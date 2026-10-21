from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import RuntimeTimelineItem, RuntimeUpstreamError, SessionNotice, timeline_content_hash

STATES = frozenset({"idle", "waiting", "pending", "running", "stopping", "waiting_approval", "blocked", "error", "disconnected"})
ACTIVE_STATES = frozenset({"waiting", "pending", "running", "stopping", "waiting_approval"})
MESSAGE_STATUSES = frozenset({"pending", "running", "waiting_approval", "done", "failed", "cancelled", "interrupted"})


def native_status(value: Any) -> str:
    if value not in STATES:
        raise RuntimeUpstreamError("WorkBuddy returned an unknown normalized session state")
    return value


def stable_item_id(session_id: str, native_id: str) -> str:
    return "wbmsg_" + hashlib.sha256(f"{session_id}:{native_id}".encode()).hexdigest()[:28]


def project_messages(session_id: str, native_id: str, messages: Any) -> tuple[RuntimeTimelineItem, ...]:
    if not isinstance(messages, list):
        raise RuntimeUpstreamError("WorkBuddy messages must be an array")
    output = []
    seen = set()
    for index, value in enumerate(messages):
        if not isinstance(value, Mapping) or not isinstance(value.get("id"), str) or not value["id"]:
            raise RuntimeUpstreamError("WorkBuddy messages require stable native IDs")
        if value["id"] in seen:
            raise RuntimeUpstreamError("WorkBuddy repeated a native message ID")
        seen.add(value["id"])
        role = value.get("role")
        if role not in {"user", "assistant", "system", "tool"}:
            raise RuntimeUpstreamError("WorkBuddy message role is invalid")
        text = value.get("text")
        if not isinstance(text, str):
            raise RuntimeUpstreamError("WorkBuddy message text must be a string")
        status = value.get("status") or "done"
        if status not in MESSAGE_STATUSES:
            raise RuntimeUpstreamError("WorkBuddy message status is invalid")
        content = {"kind": "markdown", "text": text, "format": "markdown"}
        source = {"runtime": "workbuddy", "sessionId": native_id, "itemId": value["id"]}
        if isinstance(value.get("clientMessageId"), str):
            source["clientMessageId"] = value["clientMessageId"]
        output.append(RuntimeTimelineItem(
            id=stable_item_id(session_id, value["id"]), session_id=session_id,
            type="message", status=status, role=role, order_seq=index + 1,
            content=content, source=source,
            content_hash=timeline_content_hash(item_type="message", status=status, role=role, content=content),
        ))
    return tuple(output)


def project_notices(session_id: str, pending: Any) -> tuple[SessionNotice, ...]:
    if not isinstance(pending, list):
        raise RuntimeUpstreamError("WorkBuddy pending interactions must be an array")
    result = []
    for value in pending:
        if not isinstance(value, Mapping) or not isinstance(value.get("id"), str) or not value["id"]:
            raise RuntimeUpstreamError("WorkBuddy pending interaction requires an ID")
        actions = value.get("actions", [])
        if not isinstance(actions, list) or any(not isinstance(action, dict) or not isinstance(action.get("actionId"), str) or not isinstance(action.get("label"), str) for action in actions):
            raise RuntimeUpstreamError("WorkBuddy pending interaction actions are invalid")
        result.append(SessionNotice(
            notice_id=value["id"], session_id=session_id, runtime="workbuddy",
            type="interaction", title=str(value.get("title") or "WorkBuddy approval required"),
            message=value.get("message"), status=str(value.get("status") or "open"),
            interaction_type=str(value.get("interactionType") or "approval"),
            response_required=True, actions=tuple(actions),
            blocking={"scope": "session", "targetId": session_id},
            source={"runtime": "workbuddy", "approvalId": value["id"]},
            context=dict(value.get("context") or {}),
        ))
    return tuple(result)
