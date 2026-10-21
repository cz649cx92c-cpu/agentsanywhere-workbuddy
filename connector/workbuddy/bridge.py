from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeUnavailableError,
    RuntimeUnsupportedError,
    RuntimeUpstreamError,
)

MUTATIONS = frozenset({"create", "send", "interrupt", "respond"})
ACTIONS = MUTATIONS | {"probe", "models", "list", "get", "notices"}


class OutcomeUnknown(RuntimeUpstreamError):
    code = "outcome_unknown"
    retryable = False


class WorkBuddyBridge:
    """One authenticated native RPC helper invocation per action; never use a shell."""

    def __init__(self, values: Mapping[str, Any]) -> None:
        self.node = str(values["nodePath"])
        self.helper = str(values["helperPath"])
        self.cwd = str(values["workspace"])
        self.timeout = float(values["requestTimeoutSeconds"])

    async def request(self, action: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        if action not in ACTIONS:
            raise RuntimeUnsupportedError(action)
        request = json.dumps({"action": action, "params": dict(params or {})}, ensure_ascii=False).encode() + b"\n"
        try:
            process = await asyncio.create_subprocess_exec(
                self.node, self.helper,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.cwd,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        except OSError as exc:
            # Process never started: nothing could have reached the native app.
            raise RuntimeUnavailableError("WorkBuddy helper could not be started") from exc
        try:
            stdout, _stderr = await asyncio.wait_for(process.communicate(request), self.timeout)
        except (TimeoutError, asyncio.CancelledError) as exc:
            if process.returncode is None:
                process.kill()
            await process.communicate()
            if isinstance(exc, asyncio.CancelledError):
                raise
            error = OutcomeUnknown if action in MUTATIONS else RuntimeUnavailableError
            raise error("WorkBuddy native request did not return; refresh before submitting again") from exc
        try:
            if len(stdout) > 32 * 1024 * 1024:
                raise ValueError("oversized response")
            envelope = json.loads(stdout)
            if not isinstance(envelope, dict) or not isinstance(envelope.get("ok"), bool):
                raise ValueError("invalid envelope")
            if process.returncode != 0 and envelope["ok"]:
                raise ValueError("helper exited unsuccessfully")
        except (ValueError, UnicodeError) as exc:
            error = OutcomeUnknown if action in MUTATIONS else RuntimeUpstreamError
            raise error("WorkBuddy helper returned an invalid response") from exc
        if not envelope["ok"]:
            error = envelope.get("error") or {}
            code = error.get("code") if isinstance(error, dict) else None
            if code == "outcome_unknown":
                raise OutcomeUnknown("WorkBuddy could not confirm whether the operation was accepted")
            if code in {"invalid_request", "invalid_params", "session_not_found", "workspace_forbidden"}:
                raise RuntimeInvalidRequestError("WorkBuddy rejected the request or session workspace")
            if code in {"unsupported", "method_not_found"}:
                raise RuntimeUnsupportedError(action)
            if code in {"unavailable", "not_logged_in", "not_running"}:
                raise RuntimeUnavailableError("Start WorkBuddy and sign in to its existing account")
            raise RuntimeUpstreamError("WorkBuddy native operation failed")
        result = envelope.get("result")
        if not isinstance(result, dict):
            error = OutcomeUnknown if action in MUTATIONS else RuntimeUpstreamError
            raise error("WorkBuddy helper result must be an object")
        return result
