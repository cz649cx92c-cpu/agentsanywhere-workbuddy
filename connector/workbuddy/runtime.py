from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import re
from pathlib import Path
import time
from collections.abc import Mapping
from contextlib import suppress
from typing import Any

from connector.runtime_protocol import (
    AgentRuntime, RuntimeAttachment, RuntimeCapability, RuntimeCapabilitySet,
    RuntimeConfig, RuntimeIdentity, RuntimeInvalidRequestError, RuntimeModelCatalog,
    RuntimeModelItem, RuntimeOperationResult, RuntimePermissionCatalog,
    RuntimePermissionItem, RuntimeProtocolError, RuntimeTimelineSnapshot,
    RuntimeUnavailableError, RuntimeUpstreamError, SessionMeta, SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.session_identity import stable_runtime_session_id

from .bridge import OutcomeUnknown, WorkBuddyBridge
from .projection import ACTIVE_STATES, native_status, project_messages, project_notices
from .provider import WORKSPACE, normalized_config, require_workspace


LAST_VERIFIED_VERSION = "5.8.4"
VERSION_STRATEGIES = {"5.8.4": ("current",)}
FALLBACK_STRATEGIES = ("extension", "desktop-cdp")


class _StrategyBridge(WorkBuddyBridge):
    def __init__(self, values: Mapping[str, Any], strategy: str) -> None:
        super().__init__({**values, "helperPath": str(Path(values["helperPath"]).with_name("compat-helper.cjs"))})
        self.strategy = strategy

    async def request(self, action: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        return await super().request(action, {**dict(params or {}), "_aaStrategy": self.strategy})


class _UnavailableBridge:
    async def request(self, action: str, params=None) -> dict[str, Any]:
        raise RuntimeUnavailableError("No compatible WorkBuddy transport; waiting for background retry")



class WorkBuddyRuntime(AgentRuntime):
    """Native WorkBuddy conversations; AA identities never replace native IDs."""

    def __init__(self, config: RuntimeConfig, host: RuntimeHostClient, bridge: WorkBuddyBridge) -> None:
        self.config = config
        self.host = host
        self.bridge = bridge
        self.values = normalized_config(config.values)
        self._identity = RuntimeIdentity("workbuddy", "unknown", "WorkBuddy")
        self._poll_task: asyncio.Task | None = None
        self._connected = False
        self._version_bridge = _StrategyBridge(self.values, "version")
        self._bridges = {"current": bridge, **{name: _StrategyBridge(self.values, name) for name in FALLBACK_STRATEGIES}}
        self._version = "unknown"
        self._strategy = None
        self._strategy_failures = []
        self._operation_lock = asyncio.Lock()
        self._inventory_lock = asyncio.Lock()
        self._sync_lock = asyncio.Lock()
        self._read_locks: dict[str, asyncio.Lock] = {}
        self._read_cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._bindings = dict((host.runtime_kv.get("workbuddy.bindings.v1") or {}).get("sessions") or {})
        self._last_states: dict[str, str] = {}
        self._seen_updates: dict[str, Any] = {}
        self._awaiting: set[str] = set((host.runtime_kv.get("workbuddy.awaiting.v1") or {}).get("sessions") or [])
        self._interrupt_requested: set[str] = set()
        self._notice_ids: dict[str, set[str]] = {key: set(value) for key, value in dict((host.runtime_kv.get("workbuddy.notices.v1") or {}).get("sessions") or {}).items()}

    @property
    def identity(self) -> RuntimeIdentity:
        return self._identity

    async def start(self) -> None:
        if self._poll_task is not None:
            return
        try:
            await self._connect()
        except asyncio.CancelledError:
            raise
        except Exception:
            # Supervisor must retain this instance even for malformed SDK data or
            # a failing health publication. Cancellation remains intentional.
            with suppress(Exception):
                await self._report_disconnected()
        self._poll_task = asyncio.create_task(self._poll_loop())

    async def _read_version(self) -> str:
        try:
            result = await self._version_bridge.request("probe")
            value = result.get("version")
            if isinstance(value, str) and re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", value):
                return value
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        return "unknown"

    async def _connect(self) -> None:
        self._connected = False
        self._version = await self._read_version()
        self._identity = RuntimeIdentity("workbuddy", self._version, "WorkBuddy")
        self._strategy_failures = []
        for strategy in VERSION_STRATEGIES.get(self._version, FALLBACK_STRATEGIES):
            self.bridge = self._bridges[strategy]
            try:
                result = await self.bridge.request("probe")
                if result.get("available") is not True:
                    raise RuntimeUnavailableError("WorkBuddy native conversations are unavailable")
                if strategy == "current":
                    # Preserve the proven 5.8.4 authenticated-pipe path, including
                    # its request format, session IDs and mutation deduplication.
                    self._identity = RuntimeIdentity("workbuddy", self._version, "WorkBuddy")
                else:
                    expected = {"extension": "extension", "desktop-cdp": "desktop-debugger", "codebuddy-cli": "codebuddy-cli"}[strategy]
                    if result.get("version") != self._version and self._version != "unknown":
                        raise RuntimeUpstreamError("Live bridge does not match installed WorkBuddy")
                    if result.get("nativeConversations") is not True or result.get("transport") != expected:
                        raise RuntimeUpstreamError("Bridge does not implement this strategy")
                catalog = await self.list_model_catalog(limit=10000)
                if strategy != "current":
                    if not catalog.models:
                        raise RuntimeUpstreamError("Compatible bridge requires a nonempty model catalog")
                    # A successful probe alone is insufficient: test inventory
                    # shape/workspace before advertising this strategy as usable.
                    inventory = await self.bridge.request("list", {"cwd": WORKSPACE})
                    if inventory.get("complete") is not True or not isinstance(inventory.get("sessions"), list):
                        raise RuntimeUpstreamError("Compatible bridge requires complete native inventory")
                    for item in inventory["sessions"]:
                        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
                            raise RuntimeUpstreamError("Invalid native inventory identity")
                        require_workspace(item.get("cwd"))
                await self.host.runtime_capabilities_update(await self.get_runtime_capabilities())
                await self.host.model_catalog_update(catalog)
                await self.host.permission_catalog_update(await self.list_permission_catalog())
                await self.host.runtime_health_update("running")
                self._strategy = strategy
                self._connected = True
                return
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Error types/strategy names only; never publish upstream bodies,
                # credentials, helper stderr or user prompts.
                self._strategy_failures.append({"strategy": strategy, "errorType": type(exc).__name__})
        self.bridge = _UnavailableBridge()
        self._strategy = None
        raise RuntimeUnavailableError("No compatible WorkBuddy strategy")

    async def _report_disconnected(self) -> None:
        self._connected = False
        await self.host.runtime_health_update("error", {
            "code": "workbuddy_no_compatible_strategy",
            "message": f"WorkBuddy {self._version}: 无兼容桥接策略，最后验证可用版本 {LAST_VERIFIED_VERSION}，等待适配；后台持续重试。",
            "reason": f"WorkBuddy {self._version}: 无兼容桥接策略，最后可用版本 {LAST_VERIFIED_VERSION}，等待适配",
            "version": self._version,
            "lastCompatibleVersion": LAST_VERIFIED_VERSION,
            "attempts": list(self._strategy_failures),
            "retryable": True,
        })

    async def stop(self) -> None:
        if self._poll_task:
            self._poll_task.cancel()
            await asyncio.gather(self._poll_task, return_exceptions=True)
            self._poll_task = None
        self._connected = False

    async def get_config(self) -> RuntimeConfig:
        return self.config

    def _capabilities(self, session_id: str | None = None) -> RuntimeCapabilitySet:
        scope = "session" if session_id else "runtime"
        return RuntimeCapabilitySet(
            runtime="workbuddy", revision=1, session_id=session_id,
            connector_id=self.host.connector_id,
            capabilities=tuple(RuntimeCapability(
                capability_id=name, runtime="workbuddy", scope=scope,
                session_id=session_id, connector_id=self.host.connector_id,
            ) for name in ("session.send_message", "session.interrupt", "session.interaction.approval", "catalog.model", "catalog.permission")),
            metadata={"storageMode": "workbuddy-native"},
        )

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        return self._capabilities()

    async def get_session_capabilities(self, session_id: str, external_session_id: str | None = None) -> RuntimeCapabilitySet:
        await self._get(session_id, external_session_id, use_cache=True)
        return self._capabilities(session_id)

    async def list_model_catalog(self, query: str | None = None, limit: int = 100) -> RuntimeModelCatalog:
        response = await self.bridge.request("models")
        values = response.get("models")
        if not isinstance(values, list):
            raise RuntimeUpstreamError("WorkBuddy model catalog is invalid")
        result = []
        seen = set()
        for value in values:
            if not isinstance(value, dict) or not isinstance(value.get("id"), str) or not value["id"]:
                raise RuntimeUpstreamError("WorkBuddy model ID is invalid")
            if value["id"] in seen:
                raise RuntimeUpstreamError("WorkBuddy model catalog repeated an ID")
            seen.add(value["id"])
            title = str(value.get("title") or value["id"])
            if not query or query.casefold() in (title + value["id"]).casefold():
                result.append(RuntimeModelItem(id=value["id"], title=title, selection_id="wb:" + value["id"]))
        digest = hashlib.sha256(json.dumps(values, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        old = self.host.runtime_kv.get("workbuddy.model_catalog.v1") or {}
        revision = int(old.get("revision") or 0)
        if old.get("fingerprint") != digest:
            revision += 1
            self.host.runtime_kv.set("workbuddy.model_catalog.v1", {"fingerprint": digest, "revision": revision})
        return RuntimeModelCatalog(runtime="workbuddy", revision=revision, models=tuple(result[:limit]))

    async def list_permission_catalog(self, query: str | None = None, limit: int = 100) -> RuntimePermissionCatalog:
        # Preserve WorkBuddy's current native policy; never advertise bypass modes.
        item = RuntimePermissionItem(id="default", title="WorkBuddy 当前权限", selection_id="wb:default", description="沿用 WorkBuddy 的权限与审批设置")
        return RuntimePermissionCatalog(runtime="workbuddy", revision=1, permissions=(item,) if limit > 0 else ())

    def _bind(self, session_id: str, native_id: str) -> None:
        existing = self._bindings.get(session_id)
        if existing is not None and existing != native_id:
            raise RuntimeInvalidRequestError("WorkBuddy session binding does not match")
        if any(key != session_id and value == native_id for key, value in self._bindings.items()):
            raise RuntimeInvalidRequestError("WorkBuddy native session already has a different AA identity")
        if existing is None:
            self._bindings[session_id] = native_id
            self.host.runtime_kv.set("workbuddy.bindings.v1", {"sessions": self._bindings})

    def _platform_id(self, native_id: str) -> str:
        for session_id, value in self._bindings.items():
            if value == native_id:
                return session_id
        session_id = stable_runtime_session_id(self.host.session_namespace, "workbuddy", native_id)
        self._bind(session_id, native_id)
        return session_id

    async def list_sessions(self, limit: int = 100, cursor: str | None = None, force: bool = False) -> tuple[SessionMeta, ...]:
        if cursor:
            raise RuntimeInvalidRequestError("WorkBuddy inventory does not use cursors")
        return (await self.list_complete_session_inventory(force=force))[:limit]

    async def list_complete_session_inventory(self, page_size: int = 100, force: bool = False) -> tuple[SessionMeta, ...]:
        async with self._inventory_lock:
            return await self._inventory()

    async def _inventory(self) -> tuple[SessionMeta, ...]:
        result = await self.bridge.request("list", {"cwd": WORKSPACE})
        if result.get("complete") is not True or not isinstance(result.get("sessions"), list):
            raise RuntimeUpstreamError("WorkBuddy inventory is incomplete")
        output = []
        seen = set()
        for value in result["sessions"]:
            if not isinstance(value, dict):
                raise RuntimeUpstreamError("WorkBuddy session metadata is invalid")
            try:
                require_workspace(value.get("cwd"))
            except RuntimeInvalidRequestError:
                continue
            native_id = value.get("id")
            if not isinstance(native_id, str) or not native_id or native_id in seen:
                raise RuntimeUpstreamError("WorkBuddy inventory has missing or duplicate IDs")
            seen.add(native_id)
            output.append(self._meta(self._platform_id(native_id), value))
        return tuple(output)

    def _meta(self, session_id: str, info: Mapping[str, Any]) -> SessionMeta:
        require_workspace(info.get("cwd"))
        changed = session_id not in self._seen_updates or self._seen_updates.get(session_id) != info.get("updatedAt") or self._last_states.get(session_id) != info.get("state") or session_id in self._awaiting
        return SessionMeta(
            session_id=session_id, external_session_id=str(info["id"]), runtime="workbuddy",
            title=info.get("title"), cwd=WORKSPACE, ordering_time=info.get("updatedAt"),
            metadata={"source": "workbuddy-native", "nativeState": info.get("state"), "sync": {"changed": changed, "requires_timeline_sync": changed}},
        )

    async def _get(self, session_id: str, external_session_id: str | None = None, *, use_cache: bool = False) -> dict[str, Any]:
        native_id = external_session_id or self._bindings.get(session_id)
        if not native_id:
            await self.list_complete_session_inventory()
            native_id = self._bindings.get(session_id)
        if not native_id:
            raise RuntimeInvalidRequestError("Unknown WorkBuddy session")
        existing = self._bindings.get(session_id)
        if existing is not None and existing != native_id:
            raise RuntimeInvalidRequestError("WorkBuddy native session binding differs")
        async with self._read_locks.setdefault(native_id, asyncio.Lock()):
            cached = self._read_cache.get(native_id)
            if use_cache and cached and time.monotonic() - cached[0] < 1:
                self._bind(session_id, native_id)
                return copy.deepcopy(cached[1])
            result = await self.bridge.request("get", {"id": native_id, "cwd": WORKSPACE})
            info = result.get("info")
            if not isinstance(info, dict) or info.get("id") != native_id:
                raise RuntimeUpstreamError("WorkBuddy returned a different native session")
            require_workspace(info.get("cwd"))
            native_status(info.get("state"))
            self._bind(session_id, native_id)
            self._read_cache[native_id] = (time.monotonic(), copy.deepcopy(result))
            return result

    def _state(self, session_id: str, info: Mapping[str, Any]) -> SessionState:
        model = info.get("model")
        staged = dict((self.host.runtime_kv.get("workbuddy.selections." + session_id) or {}).get("selections") or {})
        return SessionState(
            session_id=session_id, external_session_id=str(info["id"]), runtime="workbuddy",
            status=native_status(info["state"]),
            selections={"model": "wb:" + model if isinstance(model, str) and model else None, "permission": "wb:default", **staged},
            metadata={"source": "workbuddy-native", "modelSelectionAppliesToNextTurn": bool(staged)},
        )

    async def get_session_state(self, session_id: str, external_session_id: str | None = None) -> SessionState:
        return self._state(session_id, (await self._get(session_id, external_session_id, use_cache=True))["info"])

    async def get_session_snapshot(self, session_id: str, external_session_id: str | None = None, limit: int | None = None) -> RuntimeTimelineSnapshot:
        result = await self._get(session_id, external_session_id)
        items = project_messages(session_id, result["info"]["id"], result.get("messages"))
        return RuntimeTimelineSnapshot(
            session_id=session_id, external_session_id=result["info"]["id"], runtime="workbuddy",
            items=items, complete=result.get("complete", True) is True,
            metadata={"source": "workbuddy-native", "totalItems": len(items)},
        )

    async def get_session_notices(self, session_id: str, external_session_id: str | None = None):
        result = await self._get(session_id, external_session_id, use_cache=True)
        return project_notices(session_id, result.get("pending", []))

    async def _model(self, selections: Mapping[str, str | None] | None) -> str | None:
        values = dict(selections or {})
        if set(values) - {"model", "permission"} or values.get("permission") not in {None, "wb:default"}:
            raise RuntimeInvalidRequestError("WorkBuddy permissions cannot be elevated by this adapter")
        selection = values.get("model")
        if selection is None:
            return None
        catalog = await self.list_model_catalog(limit=10000)
        for item in catalog.models:
            if item.selection_id == selection:
                return item.id
        raise RuntimeInvalidRequestError("Select a currently available WorkBuddy model")

    async def update_session_selections(self, session_id: str, external_session_id: str | None, selections: Mapping[str, str | None]) -> RuntimeOperationResult:
        data = await self._get(session_id, external_session_id)
        await self._model(selections)
        current = dict((self.host.runtime_kv.get("workbuddy.selections." + session_id) or {}).get("selections") or {})
        current.update(dict(selections))
        self.host.runtime_kv.set("workbuddy.selections." + session_id, {"selections": current})
        state = self._state(session_id, data["info"])
        await self.host.session_state_update(session_id=session_id, runtime="workbuddy", external_session_id=data["info"]["id"], status=state.status, selections=state.selections, metadata=state.metadata)
        return RuntimeOperationResult(result={"sessionId": session_id, "externalSessionId": data["info"]["id"], "selections": dict(state.selections), "appliesToNextTurn": True})

    async def _mutation(self, action: str, params: dict[str, Any], token: str) -> dict[str, Any]:
        digest = hashlib.sha256(json.dumps(params, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        key = "workbuddy.operation.v1." + hashlib.sha256(f"{action}:{token}".encode()).hexdigest()
        async with self._operation_lock:
            old = self.host.runtime_kv.get(key)
            if old:
                if old.get("fingerprint") != digest:
                    raise RuntimeInvalidRequestError("The clientMessageId was reused for a different operation")
                if old.get("state") == "done":
                    return dict(old["result"])
                if old.get("state") == "failed":
                    raise RuntimeUpstreamError("This WorkBuddy operation was rejected; refresh before resubmitting")
                raise OutcomeUnknown("This WorkBuddy operation may already have been submitted; it will not be resent")
            self.host.runtime_kv.set(key, {"state": "pending", "fingerprint": digest})
            try:
                result = await self.bridge.request(action, params)
            except OutcomeUnknown:
                raise
            except RuntimeProtocolError:
                self.host.runtime_kv.set(key, {"state": "failed", "fingerprint": digest})
                raise
            self.host.runtime_kv.set(key, {"state": "done", "fingerprint": digest, "result": result})
            self._read_cache.pop(params.get("id"), None)
            return result

    @staticmethod
    def _unknown() -> RuntimeOperationResult:
        return RuntimeOperationResult(ok=False, code="outcome_unknown", message="WorkBuddy 操作结果尚未确认，请刷新会话；不会自动重复发送。", result={"retryable": False, "executionState": "unknown"})

    @staticmethod
    def _validate_message(content: str, attachments: tuple[RuntimeAttachment, ...], client_message_id: str | None, cwd: str | None) -> None:
        require_workspace(cwd or WORKSPACE)
        if not isinstance(content, str) or not content.strip() or not client_message_id:
            raise RuntimeInvalidRequestError("A message and a stable clientMessageId are required")
        if attachments:
            raise RuntimeInvalidRequestError("WorkBuddy attachment transfer is not supported")

    async def create_and_start_session(self, session_id: str, content: str, title: str | None = None, cwd: str | None = None, selections: Mapping[str, str | None] | None = None, attachments: tuple[RuntimeAttachment, ...] = (), client_message_id: str | None = None, runtime_options: Mapping[str, Any] | None = None) -> RuntimeOperationResult:
        self._validate_message(content, attachments, client_message_id, cwd)
        if runtime_options:
            raise RuntimeInvalidRequestError("Unknown WorkBuddy creation option")
        model = await self._model(selections)
        try:
            # Do not let an inventory scan import a just-created native session
            # before its user-requested AA identity has been bound.
            async with self._inventory_lock:
                created = await self._mutation("create", {"cwd": WORKSPACE, "title": title, "clientMessageId": client_message_id, "model": model}, session_id)
                native_id = created.get("id")
                if not isinstance(native_id, str) or not native_id:
                    raise OutcomeUnknown("WorkBuddy conversation creation returned no identity")
                self._bind(session_id, native_id)
            await self.host.session_meta_upsert(session_id=session_id, runtime="workbuddy", external_session_id=native_id, title=title, cwd=WORKSPACE, metadata={"source": "workbuddy-native"})
            return await self.start_turn(session_id, native_id, content, selections, attachments, client_message_id, cwd=WORKSPACE)
        except OutcomeUnknown:
            return self._unknown()

    async def start_turn(self, session_id: str, external_session_id: str | None, content: str, selections: Mapping[str, str | None] | None = None, attachments: tuple[RuntimeAttachment, ...] = (), client_message_id: str | None = None, cwd: str | None = None) -> RuntimeOperationResult:
        self._validate_message(content, attachments, client_message_id, cwd)
        staged = dict((self.host.runtime_kv.get("workbuddy.selections." + session_id) or {}).get("selections") or {})
        model = await self._model({**staged, **dict(selections or {})})
        data = await self._get(session_id, external_session_id)
        native_id = data["info"]["id"]
        try:
            response = await self._mutation("send", {"id": native_id, "cwd": WORKSPACE, "text": content, "clientMessageId": client_message_id, "model": model}, f"{session_id}:{client_message_id}")
            if response.get("accepted") is not True:
                raise OutcomeUnknown("WorkBuddy did not confirm accepting the message")
            self._awaiting.add(session_id)
            self.host.runtime_kv.set("workbuddy.awaiting.v1", {"sessions": sorted(self._awaiting)})
            await self.host.session_state_update(session_id=session_id, runtime="workbuddy", external_session_id=native_id, status="running", metadata={"source": "workbuddy-native", "clientMessageId": client_message_id})
            return RuntimeOperationResult(result={"sessionId": session_id, "externalSessionId": native_id, "clientMessageId": client_message_id, "accepted": True})
        except OutcomeUnknown:
            return self._unknown()

    async def interrupt_session(self, session_id: str, reason: str | None = None) -> RuntimeOperationResult:
        info = (await self._get(session_id))["info"]
        try:
            result = await self.bridge.request("interrupt", {"id": info["id"], "cwd": WORKSPACE})
            self._read_cache.pop(info["id"], None)
            if result.get("ok") is True:
                self._interrupt_requested.add(session_id)
            return RuntimeOperationResult(ok=result.get("ok") is True, result=result)
        except OutcomeUnknown:
            return self._unknown()

    async def respond_interaction(self, session_id: str, notice_id: str, action_id: str, input_data: Mapping[str, Any] | None = None) -> RuntimeOperationResult:
        data = await self._get(session_id)
        notices = project_notices(session_id, data.get("pending", []))
        notice = next((value for value in notices if value.notice_id == notice_id), None)
        if not notice or action_id not in {value["actionId"] for value in notice.actions}:
            raise RuntimeInvalidRequestError("WorkBuddy interaction is missing or action is invalid")
        token = f"{session_id}:{notice_id}:{action_id}"
        try:
            result = await self._mutation("respond", {"id": data["info"]["id"], "cwd": WORKSPACE, "noticeId": notice_id, "actionId": action_id, "inputData": dict(input_data or {})}, token)
            return RuntimeOperationResult(ok=result.get("ok") is True, result=result)
        except OutcomeUnknown:
            return self._unknown()

    async def _sync(self, session_id: str, native_id: str) -> None:
        async with self._sync_lock:
            result = await self._get(session_id, native_id)
            info = result["info"]
            state = self._state(session_id, info)
            items = project_messages(session_id, native_id, result.get("messages"))
            await self.host.session_meta_upsert(session_id=session_id, runtime="workbuddy", external_session_id=native_id, title=info.get("title"), cwd=WORKSPACE, ordering_time=info.get("updatedAt"), metadata={"source": "workbuddy-native"})
            await self.host.session_state_update(session_id=session_id, runtime="workbuddy", external_session_id=native_id, status=state.status, selections=state.selections, metadata=state.metadata)
            await self.host.timeline_sync(session_id=session_id, runtime="workbuddy", external_session_id=native_id, items=items, complete=result.get("complete", True) is True)
            notices = project_notices(session_id, result.get("pending", []))
            current_ids = {value.notice_id for value in notices}
            for value in notices:
                await self.host.notice_upsert(value)
            for removed in self._notice_ids.get(session_id, set()) - current_ids:
                from connector.runtime_protocol import SessionNotice
                await self.host.notice_upsert(SessionNotice(notice_id=removed, session_id=session_id, runtime="workbuddy", type="interaction", title="WorkBuddy interaction resolved", status="resolved", response_required=False, source={"runtime": "workbuddy", "approvalId": removed}))
            self._notice_ids[session_id] = current_ids
            self.host.runtime_kv.set("workbuddy.notices.v1", {"sessions": {key: sorted(value) for key, value in self._notice_ids.items()}})
            old = self._last_states.get(session_id)
            self._last_states[session_id] = state.status
            self._seen_updates[session_id] = info.get("updatedAt")
            if state.status not in ACTIVE_STATES and (old in ACTIVE_STATES or session_id in self._awaiting):
                outcome = "failed" if state.status == "error" else "interrupted" if session_id in self._interrupt_requested else "completed"
                await self.host.session_turn_ended(session_id=session_id, runtime="workbuddy", external_session_id=native_id, outcome=outcome)
                self._awaiting.discard(session_id)
                self.host.runtime_kv.set("workbuddy.awaiting.v1", {"sessions": sorted(self._awaiting)})
                self._interrupt_requested.discard(session_id)

    async def _poll_loop(self) -> None:
        while True:
            try:
                if not self._connected:
                    await self._connect()
                sessions = await self.list_complete_session_inventory()
                for session in sessions:
                    if session.session_id not in self._seen_updates or self._seen_updates.get(session.session_id) != session.ordering_time or self._last_states.get(session.session_id) != session.metadata.get("nativeState") or self._last_states.get(session.session_id) in ACTIVE_STATES or session.session_id in self._awaiting:
                        await self._sync(session.session_id, session.external_session_id)
                await self.host.runtime_health_update("running")
            except asyncio.CancelledError:
                raise
            except Exception:
                # Never expose native message bodies, auth, or helper stderr in logs.
                with suppress(Exception):
                    await self._report_disconnected()
            await asyncio.sleep(float(self.values["pollIntervalSeconds"]))
