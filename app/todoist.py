from __future__ import annotations

from datetime import date, datetime
from typing import Any
import uuid

import httpx


class TodoistError(RuntimeError):
    pass


class TodoistClient:
    def __init__(self, token: str, base_url: str = "https://api.todoist.com/api/v1", transport: httpx.BaseTransport | None = None):
        self.token = token
        self.client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=20,
            transport=transport,
        )

    def _request(self, method: str, path: str, *, request_id: str | None = None, **kwargs: Any) -> Any:
        headers = dict(kwargs.pop("headers", {}))
        if request_id:
            headers["X-Request-ID"] = request_id
        try:
            response = self.client.request(method, path, headers=headers, **kwargs)
        except httpx.HTTPError as exc:
            raise TodoistError("Todoist could not be reached; try again") from exc
        if response.status_code == 404:
            return None
        if response.is_error:
            detail = ""
            try:
                body = response.json()
                if isinstance(body, dict):
                    detail = str(body.get("error") or body.get("message") or "")[:180]
            except ValueError:
                pass
            raise TodoistError(f"Todoist request failed ({response.status_code})" + (f": {detail}" if detail else ""))
        if not response.content or response.status_code == 204:
            return None
        return response.json()

    @staticmethod
    def _items(payload: Any) -> list[dict[str, Any]]:
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            for key in ("results", "items"):
                if isinstance(payload.get(key), list):
                    return payload[key]
        raise TodoistError("Todoist returned an unexpected list response")

    def _paginate(self, path: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            query = dict(params or {})
            query["limit"] = 200
            if cursor:
                query["cursor"] = cursor
            payload = self._request("GET", path, params=query)
            result.extend(self._items(payload))
            cursor = payload.get("next_cursor") if isinstance(payload, dict) else None
            if not cursor:
                return result

    def find_project(self, name: str) -> dict[str, Any]:
        projects = self._paginate("/projects")
        matches = [p for p in projects if p.get("name") == name]
        if len(matches) != 1:
            raise TodoistError(f"Expected exactly one Todoist project named {name!r}; found {len(matches)}")
        return matches[0]

    def list_tasks(self, project_id: str) -> list[dict[str, Any]]:
        return self._paginate("/tasks", {"project_id": project_id})

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        result = self._request("GET", f"/tasks/{task_id}")
        return result if isinstance(result, dict) else None

    def completed_tasks(self, project_id: str, since: datetime, until: datetime) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            params: dict[str, Any] = {"since": since.isoformat(), "until": until.isoformat(), "limit": 200}
            if cursor:
                params["cursor"] = cursor
            payload = self._request("GET", "/tasks/completed/by_completion_date", params=params)
            result.extend(task for task in self._items(payload) if str(task.get("project_id")) == str(project_id))
            cursor = payload.get("next_cursor") if isinstance(payload, dict) else None
            if not cursor:
                return result

    def create_task(self, title: str, project_id: str, due_at: datetime, timezone: str, request_id: str, description: str = "") -> dict[str, Any]:
        payload = {
            "content": title,
            "project_id": project_id,
            "due_datetime": due_at.isoformat(timespec="seconds"),
            "due_timezone": timezone,
            "description": description,
        }
        task = self._request("POST", "/tasks", json=payload, request_id=request_id)
        if not isinstance(task, dict) or not task.get("id"):
            raise TodoistError("Todoist did not return the created task")
        return task

    def update_task(self, task_id: str, payload: dict[str, Any], request_id: str) -> dict[str, Any]:
        result = self._request("POST", f"/tasks/{task_id}", json=payload, request_id=request_id)
        task = result if isinstance(result, dict) else self.get_task(task_id)
        if not task:
            raise TodoistError("Updated Todoist task could not be read back")
        return task

    def close_task(self, task_id: str, request_id: str) -> None:
        self._request("POST", f"/tasks/{task_id}/close", request_id=request_id)

    def delete_task(self, task_id: str, request_id: str) -> None:
        # A successful DELETE is the write acknowledgement. Do not immediately GET:
        # Todoist can briefly serve a stale task after accepting the deletion.
        self._request("DELETE", f"/tasks/{task_id}", request_id=request_id)
