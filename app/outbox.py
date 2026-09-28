from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Any

from .db import Database
from .todoist import TodoistClient, TodoistError


class PlanOutbox:
    """Durable SQLite queue: local actions are pushed to Todoist, never the reverse."""

    def __init__(self, database: Database, todoist: TodoistClient, project_name: str, timezone: str, tz: Any):
        self.db = database
        self.todoist = todoist
        self.project_name = project_name
        self.timezone = timezone
        self.tz = tz
        self.wake = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.stopping = False

    def start(self) -> None:
        if self.task is None or self.task.done():
            self.stopping = False
            self.task = asyncio.create_task(self.run(), name="dinner-planner-todoist-outbox")

    async def stop(self) -> None:
        self.stopping = True
        self.wake.set()
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
            self.task = None

    def notify(self) -> None:
        self.wake.set()

    async def run(self) -> None:
        while not self.stopping:
            action = await asyncio.to_thread(self.db.claim_next_action)
            if action:
                await asyncio.to_thread(self.process, action)
                continue
            self.wake.clear()
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=1.0)
            except TimeoutError:
                pass

    @staticmethod
    def _check_task(task: dict[str, Any], project_id: str, title: str | None = None) -> None:
        if str(task.get("project_id")) != str(project_id):
            raise TodoistError("The meal is no longer in the Meals project; no change was made")
        if title is not None and str(task.get("content") or "") != title:
            raise TodoistError("Todoist read-back did not match the requested meal")

    def _check_due(self, task: dict[str, Any], expected: str) -> None:
        due = task.get("due") or {}
        raw = str(due.get("datetime") or due.get("date") or "")
        try:
            actual = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if actual.tzinfo:
                actual = actual.astimezone(self.tz)
            else:
                actual = actual.replace(tzinfo=self.tz)
            wanted = datetime.fromisoformat(expected)
        except ValueError as exc:
            raise TodoistError("Todoist read-back did not include a valid due date and time") from exc
        if (actual.date(), actual.strftime("%H:%M")) != (wanted.date(), wanted.strftime("%H:%M")):
            raise TodoistError("Todoist read-back did not match the requested date and time")

    def _process_create(self, action: dict[str, Any], payload: dict[str, Any]) -> None:
        request_id = action["request_id"]
        project_id = str(payload["project_id"])
        marker = f"meal-planner-request-id: {request_id}"
        remote_id = action.get("remote_id")
        remote = self.todoist.get_task(str(remote_id)) if remote_id else None
        if not remote and remote_id:
            raise TodoistError("Created Todoist meal is not readable yet; it will be checked again")
        if not remote:
            active = self.todoist.list_tasks(project_id)
            matches = [task for task in active if marker in str(task.get("description") or "").splitlines()]
            if len(matches) > 1:
                raise TodoistError("Multiple Todoist tasks have this placement marker; inspect the Meals project")
            if matches:
                remote = matches[0]
                self.db.set_action_remote_id(request_id, str(remote["id"]))
            elif action.get("create_attempted"):
                raise TodoistError("Create result is uncertain; the placement marker is not visible yet, so it will not create a duplicate")
            else:
                self.db.set_create_attempted(request_id)
                due_at = datetime.fromisoformat(payload["due_datetime"])
                created = self.todoist.create_task(
                    payload["name"], project_id, due_at, self.timezone, request_id, marker,
                )
                remote_id = str(created["id"])
                self.db.set_action_remote_id(request_id, remote_id)
                remote = self.todoist.get_task(remote_id)
                if not remote:
                    raise TodoistError("Created Todoist meal is not readable yet; it will be checked again")
        self._check_task(remote, project_id, payload["name"])
        self._check_due(remote, payload["due_datetime"])
        task_key = str(action.get("task_key") or f"local:{request_id}")
        self.db.update_cached_task(task_key, remote, str(remote["id"]))
        self.db.finish_action(request_id, str(remote["id"]), remote)

    def _process_move(self, action: dict[str, Any], payload: dict[str, Any]) -> None:
        task_key = str(action.get("task_key") or payload.get("task_key") or "")
        cached = self.db.get_project_task(task_key)
        if not cached:
            raise TodoistError("Meal is no longer in the local planner cache")
        task = cached["task"]
        project_id = str(cached["project_id"])
        remote_id = cached.get("remote_id") or task.get("id")
        if not remote_id or str(remote_id).startswith("local:"):
            raise TodoistError("Meal creation must sync before its move")
        fresh = self.todoist.get_task(str(remote_id))
        if not fresh:
            raise TodoistError("Todoist no longer has this meal")
        self._check_task(fresh, project_id)
        updated = self.todoist.update_task(str(remote_id), {
            "due_datetime": payload["due_datetime"], "due_timezone": payload["due_timezone"],
        }, action["request_id"])
        self._check_task(updated, project_id)
        self._check_due(updated, payload["due_datetime"])
        self.db.update_cached_task(task_key, updated, str(remote_id))
        self.db.finish_action(action["request_id"], str(remote_id), updated)

    def _process_delete(self, action: dict[str, Any], payload: dict[str, Any]) -> None:
        task_key = str(action.get("task_key") or payload.get("task_key") or "")
        cached = self.db.get_project_task(task_key)
        remote_id = str(action.get("remote_id") or payload.get("task_id") or "")
        if cached:
            remote_id = str(cached.get("remote_id") or cached["task"].get("id") or remote_id)
            project_id = str(cached["project_id"])
        else:
            project_id = str(payload.get("project_id", ""))
        if remote_id and not remote_id.startswith("local:"):
            fresh = self.todoist.get_task(remote_id)
            if fresh:
                self._check_task(fresh, project_id)
                self.todoist.delete_task(remote_id, action["request_id"])
        self.db.delete_cached_task(task_key, remote_id)
        self.db.finish_action(action["request_id"], remote_id or None, {"deleted": True})

    def process(self, action: dict[str, Any]) -> None:
        request_id = action["request_id"]
        payload = json.loads(action["payload"])
        try:
            if action["kind"] == "create-meal":
                self._process_create(action, payload)
            elif action["kind"] == "move-meal":
                self._process_move(action, payload)
            elif action["kind"] == "delete-meal":
                self._process_delete(action, payload)
            else:
                self.db.retry_action(request_id, "Unknown planner action", 0, terminal=True)
        except Exception as exc:
            attempts = int(action.get("attempts", 1))
            terminal = attempts >= 8 or ("no longer in the Meals project" in str(exc))
            delay = min(45, 0.5 * (2 ** max(0, attempts - 1)))
            self.db.retry_action(request_id, str(exc), delay, terminal=terminal)
        finally:
            self.wake.set()
