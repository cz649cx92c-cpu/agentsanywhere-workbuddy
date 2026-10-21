"""Headless adapter checks against the installed Connector 2.0.3 API.

No WorkBuddy process, credentials, native conversation, or network is used.
"""
from __future__ import annotations

import asyncio
import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path

ADAPTER_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ADAPTER_DIR.parent))
if os.environ.get("AA_CONNECTOR_PACKAGE_PARENT"):
    sys.path.insert(0, os.environ["AA_CONNECTOR_PACKAGE_PARENT"])

from connector.core.json_kv import JsonKeyValueStore
from connector.runtime_protocol import RuntimeConfig, RuntimeInvalidRequestError, RuntimeUpstreamError, RuntimeUnavailableError
from connector.runtime_protocol.host import RuntimeHostClient
from workbuddy.bridge import OutcomeUnknown, WorkBuddyBridge
from workbuddy.projection import project_messages
from workbuddy.provider import DEFAULTS, WORKSPACE, WorkBuddyProvider
from workbuddy.runtime import WorkBuddyRuntime


class FakeHost(RuntimeHostClient):
    def __init__(self, path):
        self._kv = JsonKeyValueStore(path)
        self.events = []

    @property
    def connector_id(self):
        return "test_connector"

    @property
    def runtime_kv(self):
        return self._kv

    async def session_meta_upsert(self, **kwargs):
        self.events.append(("meta", kwargs))

    async def session_state_update(self, **kwargs):
        self.events.append(("state", kwargs))

    async def timeline_sync(self, **kwargs):
        self.events.append(("timeline", kwargs))

    async def session_turn_ended(self, **kwargs):
        self.events.append(("ended", kwargs))

    async def notice_upsert(self, notice):
        self.events.append(("notice", notice))

    async def runtime_health_update(self, *args):
        self.events.append(("health", args))

    async def runtime_capabilities_update(self, value):
        self.events.append(("capabilities", value))

    async def model_catalog_update(self, value):
        self.events.append(("models", value))

    async def permission_catalog_update(self, value):
        self.events.append(("permissions", value))


class FakeBridge:
    def __init__(self):
        self.calls = []
        self.fail = None
        self.version = "5.8.4"
        self.unexpected = False
        self.sessions = {"native-1": {"id": "native-1", "title": "Existing", "cwd": WORKSPACE, "state": "idle", "updatedAt": "2026-10-16T00:00:00Z", "model": "model-a"}}
        self.messages = {"native-1": [{"id": "m1", "role": "user", "text": "hello"}, {"id": "m2", "role": "assistant", "text": "reply"}]}
        self.pending = {}

    async def request(self, action, params=None):
        if self.unexpected:
            raise ValueError("PRIVATE_SDK_DETAIL")
        params = params or {}
        self.calls.append((action, copy.deepcopy(params)))
        if action == self.fail:
            raise OutcomeUnknown("simulated lost response")
        if action == "probe":
            return {"available": True, "version": self.version}
        if action == "models":
            return {"models": [{"id": "model-a", "title": "Model A"}, {"id": "model-b", "title": "Model B"}]}
        if action == "list":
            return {"sessions": list(copy.deepcopy(self.sessions).values()), "complete": True}
        if action == "get":
            return {"info": copy.deepcopy(self.sessions[params["id"]]), "messages": copy.deepcopy(self.messages.get(params["id"], [])), "pending": self.pending.get(params["id"], []), "complete": True}
        if action == "create":
            value = {"id": "native-created", "title": params.get("title"), "cwd": params["cwd"], "state": "idle", "updatedAt": "2026-10-16T00:01:00Z", "model": params.get("model")}
            self.sessions[value["id"]] = value
            return copy.deepcopy(value)
        if action == "send":
            self.sessions[params["id"]]["state"] = "running"
            return {"accepted": True}
        if action in {"respond", "interrupt"}:
            return {"ok": True}
        raise AssertionError(action)


class VersionFake:
    def __init__(self, bridge):
        self.bridge = bridge
        self.calls = 0
        self.fail = False

    async def request(self, action, params=None):
        self.calls += 1
        if self.fail:
            raise RuntimeUnavailableError("Version probe unavailable")
        return {"version": self.bridge.version}


class StrategyFake(FakeBridge):
    def __init__(self, strategy):
        super().__init__()
        self.strategy = strategy
        self.version = "5.9.0"
        self.order = None
        self.empty_models = False

    async def request(self, action, params=None):
        if action == "probe" and self.order is not None:
            self.order.append(self.strategy)
        result = await super().request(action, params)
        if action == "probe":
            result.update(version=self.version, nativeConversations=True, transport={"extension":"extension","desktop-cdp":"desktop-debugger","codebuddy-cli":"codebuddy-cli"}[self.strategy])
        if action == "models" and self.empty_models:
            result["models"] = []
        return result


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.host = FakeHost(Path(self.tmp.name) / "kv.json")
        self.bridge = FakeBridge()
        self.runtime = WorkBuddyRuntime(RuntimeConfig("workbuddy", 1, values=DEFAULTS), self.host, self.bridge)
        self.version_bridge = VersionFake(self.bridge)
        self.runtime._version_bridge = self.version_bridge
        self.runtime._bridges.update({key: StrategyFake(key) for key in ("extension", "desktop-cdp", "codebuddy-cli")})

    async def asyncTearDown(self):
        await self.runtime.stop()
        self.tmp.cleanup()

    async def imported(self):
        return (await self.runtime.list_complete_session_inventory())[0]

    async def wait_health(self, status):
        async def wait():
            while not any(kind == "health" and value[0] == status for kind, value in self.host.events):
                await asyncio.sleep(0.001)
        await asyncio.wait_for(wait(), 2)

    async def test_desktop_unavailable_at_start_recovers_without_restart_or_message_replay(self):
        self.runtime.values["pollIntervalSeconds"] = 0.01
        self.bridge.fail = "probe"
        await self.runtime.start()
        worker = self.runtime._poll_task
        self.assertIsNotNone(worker)
        await self.wait_health("error")
        self.bridge.fail = None
        await self.wait_health("running")
        self.assertIs(self.runtime._poll_task, worker)
        self.assertEqual(self.runtime.identity.runtime_version, "5.8.4")
        self.assertTrue(any(kind == "models" for kind, _ in self.host.events))
        self.assertFalse(any(action in {"send", "create"} for action, _ in self.bridge.calls))
        await self.runtime.start()
        self.assertIs(self.runtime._poll_task, worker)

    async def test_desktop_drop_recovers_catalog_and_stop_cancels_retries(self):
        self.runtime.values["pollIntervalSeconds"] = 0.01
        await self.runtime.start()
        self.host.events.clear()
        self.bridge.fail = "list"
        await self.wait_health("error")
        self.bridge.fail = None
        await self.wait_health("running")
        self.assertTrue(any(kind == "models" for kind, _ in self.host.events))
        await self.runtime.stop()
        calls = len(self.bridge.calls)
        await asyncio.sleep(0.03)
        self.assertEqual(len(self.bridge.calls), calls)
        self.assertIsNone(self.runtime._poll_task)
        self.assertFalse(any(action in {"send", "create"} for action, _ in self.bridge.calls))

    async def test_import_fixed_workspace_and_native_ids(self):
        self.bridge.sessions["outside"] = {"id": "outside", "cwd": r"D:\Other", "state": "idle"}
        session = await self.imported()
        self.assertEqual(session.runtime, "workbuddy")
        self.assertEqual(session.external_session_id, "native-1")
        self.assertEqual(len(await self.runtime.list_complete_session_inventory()), 1)
        self.assertEqual((await self.runtime.list_complete_session_inventory())[0].session_id, session.session_id)

    async def test_real_history_projects_stable_message_ids_and_stream_updates(self):
        session = await self.imported()
        first = await self.runtime.get_session_snapshot(session.session_id, session.external_session_id)
        self.assertTrue(first.complete)
        self.assertEqual([value.content["text"] for value in first.items], ["hello", "reply"])
        self.bridge.messages["native-1"][1].update(text="stream changed", status="running")
        second = await self.runtime.get_session_snapshot(session.session_id)
        self.assertEqual(first.items[1].id, second.items[1].id)
        self.assertNotEqual(first.items[1].content_hash, second.items[1].content_hash)

    async def test_reject_foreign_workspace_and_binding(self):
        session = await self.imported()
        self.bridge.sessions["native-1"]["cwd"] = r"D:\Other"
        with self.assertRaises(RuntimeInvalidRequestError):
            await self.runtime.start_turn(session.session_id, "native-1", "test", client_message_id="m1")
        self.assertFalse(any(action == "send" for action, _ in self.bridge.calls))

    async def test_create_and_send_replay_survives_connector_restart(self):
        args = dict(session_id="sess_new", content="test", title="Native", cwd=WORKSPACE, client_message_id="message-new")
        first = await self.runtime.create_and_start_session(**args)
        restarted = WorkBuddyRuntime(self.runtime.config, self.host, self.bridge)
        second = await restarted.create_and_start_session(**args)
        self.assertTrue(first.ok and second.ok)
        self.assertEqual(first.result["externalSessionId"], "native-created")
        self.assertEqual(sum(action == "create" for action, _ in self.bridge.calls), 1)
        self.assertEqual(sum(action == "send" for action, _ in self.bridge.calls), 1)
        imported = await restarted.list_complete_session_inventory()
        self.assertEqual(next(value.session_id for value in imported if value.external_session_id == "native-created"), "sess_new")

    async def test_unknown_send_is_never_retried(self):
        session = await self.imported()
        self.bridge.fail = "send"
        args = dict(session_id=session.session_id, external_session_id="native-1", content="test", client_message_id="unknown-message")
        first = await self.runtime.start_turn(**args)
        self.bridge.fail = None
        second = await self.runtime.start_turn(**args)
        self.assertEqual((first.code, second.code), ("outcome_unknown", "outcome_unknown"))
        self.assertEqual(sum(action == "send" for action, _ in self.bridge.calls), 1)

    async def test_same_client_id_cannot_change_message(self):
        session = await self.imported()
        await self.runtime.start_turn(session.session_id, "native-1", "first", client_message_id="fixed")
        with self.assertRaises(RuntimeInvalidRequestError):
            await self.runtime.start_turn(session.session_id, "native-1", "different", client_message_id="fixed")

    async def test_no_permission_escalation_and_model_stage_applies_on_send(self):
        session = await self.imported()
        with self.assertRaises(RuntimeInvalidRequestError):
            await self.runtime.start_turn(session.session_id, "native-1", "test", selections={"permission": "bypassPermissions"}, client_message_id="m1")
        updated = await self.runtime.update_session_selections(session.session_id, "native-1", {"model": "wb:model-b"})
        self.assertTrue(updated.result["appliesToNextTurn"])
        await self.runtime.start_turn(session.session_id, "native-1", "test", client_message_id="m2")
        sent = next(params for action, params in self.bridge.calls if action == "send")
        self.assertEqual(sent["model"], "model-b")
        self.assertNotIn("permission", sent)

    async def test_poll_publication_finishes_turn_and_projects_notices(self):
        session = await self.imported()
        self.bridge.pending["native-1"] = [{"id": "approval-1", "actions": [{"actionId": "approve", "label": "Allow"}]}]
        self.bridge.sessions["native-1"]["state"] = "waiting_approval"
        await self.runtime._sync(session.session_id, "native-1")
        self.assertTrue(any(kind == "notice" for kind, _ in self.host.events))
        self.bridge.pending["native-1"] = []
        self.bridge.sessions["native-1"]["state"] = "idle"
        await self.runtime._sync(session.session_id, "native-1")
        self.assertTrue(any(kind == "ended" for kind, _ in self.host.events))
        self.assertTrue(any(kind == "notice" and value.status == "resolved" for kind, value in self.host.events))

    async def test_interrupt_finishes_with_interrupted_outcome(self):
        session = await self.imported()
        self.bridge.sessions["native-1"]["state"] = "running"
        await self.runtime._sync(session.session_id, "native-1")
        await self.runtime.interrupt_session(session.session_id)
        self.bridge.sessions["native-1"]["state"] = "idle"
        await self.runtime._sync(session.session_id, "native-1")
        ended = next(value for kind, value in self.host.events if kind == "ended")
        self.assertEqual(ended["outcome"], "interrupted")

    async def test_response_only_accepts_current_native_actions(self):
        session = await self.imported()
        self.bridge.pending["native-1"] = [{"id": "approval-1", "actions": [{"actionId": "approve", "label": "Allow"}]}]
        with self.assertRaises(RuntimeInvalidRequestError):
            await self.runtime.respond_interaction(session.session_id, "approval-1", "invented")
        await self.runtime.respond_interaction(session.session_id, "approval-1", "approve")
        self.assertEqual(sum(action == "respond" for action, _ in self.bridge.calls), 1)

    async def test_restart_resolves_previous_native_approval(self):
        session = await self.imported()
        self.bridge.pending["native-1"] = [{"id": "approval-1", "actions": [{"actionId": "approve", "label": "Allow"}]}]
        await self.runtime._sync(session.session_id, "native-1")
        self.bridge.pending["native-1"] = []
        restarted = WorkBuddyRuntime(self.runtime.config, self.host, self.bridge)
        await restarted._sync(session.session_id, "native-1")
        self.assertTrue(any(kind == "notice" and value.status == "resolved" for kind, value in self.host.events))

    async def test_invalid_create_workspace_makes_no_native_mutations(self):
        with self.assertRaises(RuntimeInvalidRequestError):
            await self.runtime.create_and_start_session("bad", "test", cwd=r"D:\Other", client_message_id="bad")
        self.assertFalse(self.bridge.calls)

    async def test_invalid_native_history_fails_closed(self):
        with self.assertRaises(RuntimeUpstreamError):
            project_messages("test", "native", [{"role": "assistant", "text": "missing ID"}])

    async def test_provider_is_native_workbuddy(self):
        provider = WorkBuddyProvider()
        config = await provider.validate_config({})
        self.assertEqual(config.runtime, "workbuddy")
        self.assertEqual(provider.runtime_type, "workbuddy")
        with self.assertRaises(RuntimeInvalidRequestError):
            await provider.validate_config({"workspace": r"D:\Other"})

    async def test_catalog_revision_is_stable_across_restart_and_query(self):
        first = await self.runtime.list_model_catalog()
        second = await self.runtime.list_model_catalog(query="Model A")
        restarted = WorkBuddyRuntime(self.runtime.config, self.host, self.bridge)
        third = await restarted.list_model_catalog()
        self.assertEqual((first.revision, second.revision, third.revision), (1, 1, 1))

    async def test_related_state_notices_capability_reads_reuse_snapshot_but_refresh_is_fresh(self):
        session = await self.imported()
        await self.runtime.get_session_snapshot(session.session_id, "native-1")
        await asyncio.gather(
            self.runtime.get_session_state(session.session_id, "native-1"),
            self.runtime.get_session_notices(session.session_id, "native-1"),
            self.runtime.get_session_capabilities(session.session_id, "native-1"),
        )
        self.assertEqual(sum(action == "get" for action, _ in self.bridge.calls), 1)
        self.bridge.messages["native-1"][1]["text"] = "fresh reply"
        snapshot = await self.runtime.get_session_snapshot(session.session_id, "native-1")
        self.assertEqual(snapshot.items[1].content["text"], "fresh reply")
        self.assertEqual(sum(action == "get" for action, _ in self.bridge.calls), 2)

    async def test_idle_inventory_suppresses_unchanged_sync_and_mutation_invalidates_reads(self):
        session = await self.imported()
        self.assertTrue(session.metadata["sync"]["requires_timeline_sync"])
        await self.runtime._sync(session.session_id, "native-1")
        unchanged = await self.imported()
        self.assertFalse(unchanged.metadata["sync"]["changed"])
        self.assertFalse(unchanged.metadata["sync"]["requires_timeline_sync"])
        self.bridge.sessions["native-1"]["updatedAt"] = "2026-10-16T00:02:00Z"
        self.assertTrue((await self.imported()).metadata["sync"]["changed"])
        await self.runtime.start_turn(session.session_id, "native-1", "new message", client_message_id="invalidate")
        state = await self.runtime.get_session_state(session.session_id, "native-1")
        self.assertEqual(state.status, "running")

    async def test_helper_malformed_output_has_uncertain_mutation_outcome(self):
        helper = Path(self.tmp.name) / "invalid.py"
        helper.write_text("print('invalid json')", encoding="utf-8")
        bridge = WorkBuddyBridge({**DEFAULTS, "nodePath": sys.executable, "workspace": self.tmp.name, "helperPath": str(helper)})
        with self.assertRaises(OutcomeUnknown):
            await bridge.request("send", {})
        with self.assertRaises(RuntimeUpstreamError):
            await bridge.request("get", {})

    async def test_helper_timeout_kills_wrapper_but_never_claims_cancelled_native_operation(self):
        helper = Path(self.tmp.name) / "timeout.py"
        helper.write_text("import time; time.sleep(10)", encoding="utf-8")
        bridge = WorkBuddyBridge({**DEFAULTS, "nodePath": sys.executable, "workspace": self.tmp.name, "helperPath": str(helper), "requestTimeoutSeconds": 0.1})
        with self.assertRaises(OutcomeUnknown):
            await bridge.request("create", {})

    async def test_helper_known_error_does_not_echo_its_private_details(self):
        helper = Path(self.tmp.name) / "rejected.py"
        helper.write_text("import json; print(json.dumps({'ok':False,'error':{'code':'workspace_forbidden','message':'PRIVATE_DETAIL'}}))", encoding="utf-8")
        bridge = WorkBuddyBridge({**DEFAULTS, "nodePath": sys.executable, "workspace": self.tmp.name, "helperPath": str(helper)})
        with self.assertRaises(RuntimeInvalidRequestError) as context:
            await bridge.request("send", {})
        self.assertNotIn("PRIVATE_DETAIL", str(context.exception))


    async def test_detects_installed_version_at_start_and_each_reconnect(self):
        self.runtime.values["pollIntervalSeconds"] = 0.01
        await self.runtime.start()
        self.bridge.fail = "list"
        await self.wait_health("error")
        self.bridge.version = "5.9.0"
        self.runtime._bridges["extension"] = StrategyFake("extension")
        self.bridge.fail = None
        await self.wait_health("running")
        # The first running event predates reconnection; wait for the new version.
        async def changed():
            while not self.runtime._connected or self.runtime.identity.runtime_version != "5.9.0":
                await asyncio.sleep(0.001)
        await asyncio.wait_for(changed(), 2)
        self.assertEqual(self.runtime._strategy, "extension")
        self.assertGreaterEqual(self.version_bridge.calls, 2)

    async def test_known_584_preserves_current_transport_without_fallback(self):
        await self.runtime.start()
        self.assertIs(self.runtime.bridge, self.bridge)
        self.assertEqual(self.runtime._strategy, "current")
        self.assertEqual(self.runtime.identity.runtime_version, "5.8.4")
        self.assertFalse(any(x.calls for k,x in self.runtime._bridges.items() if k != "current"))

    async def test_unknown_version_uses_extension_then_cdp_and_stops_after_success(self):
        self.bridge.version = "5.9.0"
        extension = self.runtime._bridges["extension"]
        extension.fail = "probe"
        await self.runtime._connect()
        self.assertEqual(self.runtime._strategy, "desktop-cdp")
        self.assertTrue(extension.calls)
        self.assertTrue(self.runtime._bridges["desktop-cdp"].calls)
        self.assertNotIn("codebuddy-cli", __import__("workbuddy.runtime", fromlist=["FALLBACK_STRATEGIES"]).FALLBACK_STRATEGIES)
        self.assertEqual(self.runtime.identity.runtime_version, "5.9.0")

    async def test_probe_success_with_empty_models_is_not_a_compatible_strategy(self):
        self.bridge.version = "5.9.0"
        self.runtime._bridges["extension"].empty_models = True
        await self.runtime._connect()
        self.assertEqual(self.runtime._strategy, "desktop-cdp")

    async def test_stale_bridge_version_is_rejected_and_falls_back(self):
        self.bridge.version = "5.9.0"
        self.runtime._bridges["extension"].version = "5.8.4"
        await self.runtime._connect()
        self.assertEqual(self.runtime._strategy, "desktop-cdp")

    async def test_all_strategies_fail_keeps_instance_error_and_retries_without_replay(self):
        self.bridge.version = "5.9.0"
        self.runtime.values["pollIntervalSeconds"] = 0.01
        for key, candidate in self.runtime._bridges.items():
            if key != "current":
                candidate.fail = "probe"
        await self.runtime.start()
        task = self.runtime._poll_task
        self.assertIsNotNone(task)
        self.assertFalse(task.done())
        health = [v for k,v in self.host.events if k=="health"][-1]
        self.assertEqual(health[0], "error")
        self.assertIn("WorkBuddy 5.9.0", health[1]["reason"])
        self.assertIn("5.8.4", health[1]["reason"])
        self.assertEqual([v["strategy"] for v in health[1]["attempts"]], ["extension","desktop-cdp"])
        await asyncio.sleep(0.04)
        self.assertGreaterEqual(sum(a=="probe" for a,_ in self.runtime._bridges["extension"].calls), 2)
        with self.assertRaises(RuntimeUnavailableError):
            await self.runtime.bridge.request("send", {})
        self.runtime._bridges["desktop-cdp"].fail = None
        await self.wait_health("running")
        self.assertIs(self.runtime._poll_task, task)
        self.assertFalse(task.done())
        self.assertFalse(any(a in {"create","send"} for c in self.runtime._bridges.values() for a,_ in c.calls))
        await self.runtime.stop()
        self.assertTrue(task.done())

    async def test_unexpected_start_error_does_not_escape_or_kill_retry_loop(self):
        self.runtime.values["pollIntervalSeconds"] = 0.01
        self.bridge.unexpected = True
        await self.runtime.start()
        await self.wait_health("error")
        self.assertFalse(self.runtime._poll_task.done())
        self.bridge.unexpected = False
        await self.wait_health("running")

    async def test_version_probe_failure_falls_back_without_trusting_stale_identity(self):
        self.version_bridge.fail = True
        for key,candidate in self.runtime._bridges.items():
            if key != "current":
                candidate.version = "6.1.0"
        await self.runtime._connect()
        self.assertEqual(self.runtime.identity.runtime_version, "unknown")
        self.assertEqual(self.runtime._strategy, "extension")

    async def test_invalid_version_is_sanitized_not_published(self):
        self.bridge.version = "PRIVATE_VERSION_BODY\nsecret"
        await self.runtime._connect()
        self.assertEqual(self.runtime.identity.runtime_version, "unknown")

    async def test_health_publication_failure_still_starts_retry_task(self):
        original = self.host.runtime_health_update
        async def unavailable(*args):
            raise ValueError("PRIVATE_HOST_DETAIL")
        self.host.runtime_health_update = unavailable
        await self.runtime.start()
        task = self.runtime._poll_task
        self.assertFalse(task.done())
        self.host.runtime_health_update = original
        await self.wait_health("running")
        self.assertIs(task, self.runtime._poll_task)

    async def test_strategy_bridge_passes_fixed_selector_without_changing_action(self):
        from workbuddy.runtime import _StrategyBridge
        helper = Path(self.tmp.name) / "compat-helper.cjs"
        helper.write_text("import json,sys; x=json.load(sys.stdin); print(json.dumps({'ok':True,'result':{'action':x['action'],'params':x['params']}}))", encoding="utf-8")
        bridge = _StrategyBridge({**DEFAULTS, "nodePath":sys.executable, "workspace":self.tmp.name, "helperPath":str(helper.with_name("client.cjs"))}, "desktop-cdp")
        result = await bridge.request("probe", {"cwd":WORKSPACE})
        self.assertEqual(result, {"action":"probe","params":{"cwd":WORKSPACE,"_aaStrategy":"desktop-cdp"}})



if __name__ == "__main__":
    unittest.main()
