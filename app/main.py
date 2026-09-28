from __future__ import annotations

import asyncio
import hmac
import json
import secrets
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import Settings
from .db import Database
from .outbox import PlanOutbox
from .todoist import TodoistClient, TodoistError

BASE_DIR = Path(__file__).resolve().parent


def week_start(day: date) -> date:
    return day - timedelta(days=day.weekday())


def due_parts(task: dict[str, Any], zone: ZoneInfo) -> tuple[date | None, str | None]:
    due = task.get("due")
    if not isinstance(due, dict):
        return None, None
    value = str(due.get("datetime") or due.get("date") or "").strip()
    if not value:
        return None, None
    try:
        if "T" in value:
            normalized = value.replace("Z", "+00:00")
            parsed = datetime.fromisoformat(normalized)
            if parsed.tzinfo:
                parsed = parsed.astimezone(zone)
            else:
                parsed = parsed.replace(tzinfo=zone)
            return parsed.date(), parsed.strftime("%H:%M")
        return date.fromisoformat(value[:10]), None
    except ValueError:
        return None, None


def safe_next(value: str | None) -> str:
    if not value:
        return "/"
    decoded = unquote(value)
    if not decoded.startswith("/") or decoded.startswith("//") or "\\" in decoded or any(ord(c) < 32 for c in decoded):
        return "/"
    return value


def create_app(
    settings: Settings | None = None,
    *,
    todoist: Any | None = None,
    db: Database | None = None,
    now: Any | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.validate()
    database = db or Database(settings.database_path)
    todoist_client = todoist or TodoistClient(settings.todoist_token)
    serializer = URLSafeTimedSerializer(settings.session_secret, salt="dinner-planner-session-v1")
    cookie_name = "__Host-meals_session" if settings.cookie_secure else "meals_session"
    attempts: dict[str, deque[float]] = defaultdict(deque)
    templates = Jinja2Templates(directory=BASE_DIR / "templates")
    clock = now or (lambda: datetime.now(settings.tz))
    outbox = PlanOutbox(database, todoist_client, settings.todoist_project, settings.timezone, settings.tz)

    @asynccontextmanager
    async def lifespan(_app):
        if settings.todoist_token:
            outbox.start()
        try:
            yield
        finally:
            await outbox.stop()

    app = FastAPI(title="Meal Planner", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.allowed_hosts))
    app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
    app.state.settings = settings
    app.state.db = database
    app.state.todoist = todoist_client
    app.state.now = clock
    app.state.outbox = outbox


    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; "
            "img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; "
            "manifest-src 'self'; worker-src 'self'"
        )
        if request.url.path in {"/", "/settings", "/login", "/logout"} or request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def session_for(request: Request) -> dict[str, str] | None:
        token = request.cookies.get(cookie_name)
        if not token:
            return None
        try:
            value = serializer.loads(token, max_age=60 * 60 * 24 * 30)
        except (BadSignature, SignatureExpired):
            return None
        return value if isinstance(value, dict) and value.get("authenticated") is True else None

    def require_session(request: Request) -> dict[str, str]:
        session = session_for(request)
        if not session:
            raise HTTPException(status_code=401)
        return session

    def csrf_ok(session: dict[str, str], request: Request) -> bool:
        return bool(session.get("csrf") and hmac.compare_digest(session["csrf"], request.headers.get("X-CSRF-Token", "")))

    @app.exception_handler(401)
    async def unauthenticated(request: Request, _: HTTPException):
        if request.url.path.startswith("/api/"):
            return JSONResponse({"error": "Authentication required"}, status_code=401)
        target = request.url.path + ("?" + request.url.query if request.url.query else "")
        return RedirectResponse("/login?next=" + quote(target, safe=""), status_code=303)

    @app.get("/healthz")
    async def healthz():
        database.connect().close()
        return {"status": "ok"}

    @app.get("/login", response_class=HTMLResponse)
    async def login_page(request: Request, next: str = "/"):
        if session_for(request):
            return RedirectResponse(safe_next(next), status_code=303)
        return templates.TemplateResponse(request, "login.html", {"next": safe_next(next), "error": None, "theme_mode": database.get_theme_mode()})

    @app.post("/login", response_class=HTMLResponse)
    async def login(request: Request):
        form = await request.form()
        supplied = str(form.get("password", ""))
        target = safe_next(str(form.get("next", "/")))
        ip = request.client.host if request.client else "unknown"
        current = clock().timestamp()
        bucket = attempts[ip]
        while bucket and bucket[0] < current - 300:
            bucket.popleft()
        if len(bucket) >= 5:
            return templates.TemplateResponse(request, "login.html", {"next": target, "error": "Too many attempts. Try again shortly.", "theme_mode": database.get_theme_mode()}, status_code=429)
        if not hmac.compare_digest(supplied, settings.app_password):
            bucket.append(current)
            return templates.TemplateResponse(request, "login.html", {"next": target, "error": "Incorrect password.", "theme_mode": database.get_theme_mode()}, status_code=401)
        attempts.pop(ip, None)
        signed = serializer.dumps({"authenticated": True, "csrf": secrets.token_urlsafe(32)})
        response = RedirectResponse(target, status_code=303)
        response.set_cookie(cookie_name, signed, max_age=60 * 60 * 24 * 30, httponly=True, secure=settings.cookie_secure, samesite="lax", path="/")
        return response

    @app.post("/logout")
    async def logout(request: Request):
        session = require_session(request)
        form = await request.form()
        supplied = request.headers.get("X-CSRF-Token", str(form.get("csrf", "")))
        if not session.get("csrf") or not hmac.compare_digest(session["csrf"], supplied):
            raise HTTPException(403, "Invalid CSRF token")
        response = RedirectResponse("/login", status_code=303)
        response.delete_cookie(cookie_name, path="/")
        return response

    def render_error(request: Request, message: str, current: date, slots: list[dict[str, Any]], csrf: str, status: int = 502):
        today = clock().date()
        days = [current + timedelta(days=i) for i in range(7)]
        boot = {
            "csrf": csrf, "error": message, "week_start_label": current.strftime("%b %-d"),
            "week_end_label": (current + timedelta(days=6)).strftime("%b %-d, %Y"),
            "prev_week": (current - timedelta(days=7)).isoformat(), "next_week": (current + timedelta(days=7)).isoformat(),
            "today_week": week_start(today).isoformat(),
            "days": [{"iso": d.isoformat(), "day_name": d.strftime("%A"), "date_label": f"{d.day} {d.strftime('%b')}", "count": 0, "is_today": d == today} for d in days],
            "slots": slots, "library": database.library(), "grid": {}, "unmatched": [],
            "theme_mode": database.get_theme_mode(),
        }
        return templates.TemplateResponse(request, "board.html", {
            "csrf": csrf, "theme_mode": database.get_theme_mode(),
            "boot_json": json.dumps(boot, ensure_ascii=False, separators=(",", ":")),
        }, status_code=status)

    def overlay_recent_plan_actions(active: list[dict[str, Any]], project_id: str) -> list[dict[str, Any]]:
        tombstones = database.tombstoned_remote_ids()
        tasks = {str(task.get("id")): dict(task) for task in active if task.get("id") and str(task.get("id")) not in tombstones}
        for task_id, task in tasks.items():
            task["_cache_key"] = database.project_key_for_remote(task_id) or f"remote:{task_id}"
        for action in database.recent_plan_actions(project_id):
            payload = action["payload"]
            state = action["state"]
            operation_id = action["request_id"] if state in {"pending", "processing", "failed"} else ""
            task_key = str(action.get("task_key") or f"local:{action['request_id']}")
            if action["kind"] == "create-meal":
                marker = f"meal-planner-request-id: {action['request_id']}"
                match = next((task for task in tasks.values() if marker in str(task.get("description") or "").splitlines()), None)
                if match:
                    match["_cache_key"] = task_key
                    if operation_id:
                        match["_operation_id"] = operation_id
                    database.update_cached_task(task_key, match, str(match["id"]))
                    continue
                task_id = str(action.get("remote_id") or task_key)
                due_at = str(payload["due_datetime"])
                tasks[task_id] = {
                    "id": task_id, "content": payload["name"], "project_id": str(project_id),
                    "description": marker,
                    "due": {"datetime": due_at, "date": due_at, "timezone": settings.timezone},
                    "_cache_key": task_key,
                    "_operation_id": operation_id,
                }
            elif action["kind"] == "move-meal":
                cached = database.get_project_task(task_key)
                remote_id = str(action.get("remote_id") or payload.get("task_id") or (cached or {}).get("remote_id") or "")
                task = tasks.get(remote_id)
                if task:
                    due_at = str(payload["due_datetime"])
                    task["due"] = {"datetime": due_at, "date": due_at, "timezone": payload["due_timezone"]}
                    task["_cache_key"] = task_key
                    if operation_id:
                        task["_operation_id"] = operation_id
            elif action["kind"] == "delete-meal":
                remote_id = str(action.get("remote_id") or payload.get("task_id") or "")
                if state == "done":
                    tasks.pop(remote_id, None)
                elif remote_id in tasks:
                    tasks[remote_id]["_operation_id"] = operation_id
                    tasks[remote_id]["_delete_pending"] = True
        return list(tasks.values())

    @app.get("/", response_class=HTMLResponse)
    async def board(request: Request, week: str | None = None):
        session = require_session(request)
        today = clock().date()
        try:
            selected = week_start(date.fromisoformat(week)) if week else week_start(today)
        except ValueError:
            selected = week_start(today)
        slots = database.slots()
        if not slots:
            return render_error(request, "Add at least one meal slot in Settings to use the planner.", selected, slots, session["csrf"], 200)
        if not settings.todoist_token:
            return render_error(request, "Todoist is not configured. Set TODOIST_TOKEN or TODOIST_TOKEN_FILE in the Compose environment.", selected, slots, session["csrf"], 503)
        try:
            project = await asyncio.to_thread(todoist_client.find_project, settings.todoist_project)
            project_id = str(project["id"])
            database.set_value("meals_project_id", project_id)
            active = await asyncio.to_thread(todoist_client.list_tasks, project_id)
            database.cache_project_tasks(project_id, active)
            active = overlay_recent_plan_actions(active, project_id)
            completed: list[dict[str, Any]] = []
            window_start = max(selected, today - timedelta(days=89))
            window_end = min(selected + timedelta(days=8), today + timedelta(days=1))
            if window_start < window_end:
                since = datetime.combine(window_start, time.min, settings.tz)
                until = datetime.combine(window_end, time.min, settings.tz)
                completed = await asyncio.to_thread(todoist_client.completed_tasks, project_id, since, until)
        except TodoistError as exc:
            return render_error(request, str(exc), selected, slots, session["csrf"])
        lookup: dict[str, dict[str, Any]] = {}
        for slot in slots:
            lookup[slot["time"]] = slot
        aliases: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for slot in slots:
            for old_time in slot["time_aliases"]:
                aliases[old_time].append(slot)
        grid: dict[str, dict[str, list[dict[str, Any]]]] = {slot["id"]: {} for slot in slots}
        unmatched: list[dict[str, Any]] = []
        visible_by_id: dict[str, tuple[dict[str, Any], bool]] = {}
        for task in active:
            if task.get("id"):
                visible_by_id[str(task["id"])] = (task, False)
        for task in completed:
            task_id = str(task.get("id", ""))
            if task_id and task_id not in visible_by_id:
                visible_by_id[task_id] = (task, True)
        by_day: dict[date, int] = defaultdict(int)
        for task, completed_flag in visible_by_id.values():
            due_day, due_time = due_parts(task, settings.tz)
            if due_day is None or not (selected <= due_day <= selected + timedelta(days=6)):
                continue
            if not str(task.get("content") or "").strip():
                continue
            slot = lookup.get(due_time or "")
            if slot is None and due_time:
                matches = aliases.get(due_time, [])
                if len(matches) == 1:
                    slot = matches[0]
            info = {
                "id": str(task.get("id", "")), "cache_key": str(task.get("_cache_key") or f"remote:{task.get('id', '')}"),
                "operation_id": str(task.get("_operation_id") or ""), "delete_pending": bool(task.get("_delete_pending")),
                "name": str(task.get("content", "")), "date": due_day.isoformat(),
                "time": due_time or "", "completed": completed_flag,
            }
            by_day[due_day] += 1
            if slot is None:
                if not completed_flag:
                    unmatched.append(info)
                continue
            cell = grid[slot["id"]].setdefault(due_day.isoformat(), [])
            cell.append(info)
        for cells in grid.values():
            for entries in cells.values():
                entries.sort(key=lambda item: (item["time"], item["name"].casefold(), item["id"]))
        days = []
        for offset in range(7):
            day = selected + timedelta(days=offset)
            days.append({
                "iso": day.isoformat(), "day_name": day.strftime("%A"),
                "date_label": f"{day.day} {day.strftime('%b')}", "count": by_day[day],
                "is_today": day == today,
            })
        boot = {
            "csrf": session["csrf"], "error": None, "theme_mode": database.get_theme_mode(),
            "week_start_label": selected.strftime("%b %-d"), "week_end_label": (selected + timedelta(days=6)).strftime("%b %-d, %Y"),
            "prev_week": (selected - timedelta(days=7)).isoformat(), "next_week": (selected + timedelta(days=7)).isoformat(),
            "today_week": week_start(today).isoformat(), "days": days, "slots": slots,
            "grid": grid, "library": database.library(), "unmatched": unmatched,
        }
        return templates.TemplateResponse(request, "board.html", {
            "csrf": session["csrf"], "theme_mode": database.get_theme_mode(),
            "boot_json": json.dumps(boot, ensure_ascii=False, separators=(",", ":")),
        })

    @app.get("/settings", response_class=HTMLResponse)
    async def settings_page(request: Request, error: str | None = None, saved: str | None = None):
        session = require_session(request)
        boot = {
            "csrf": session["csrf"], "slots": database.slots(), "library": database.library(),
            "theme_mode": database.get_theme_mode(), "error": error, "saved": saved,
        }
        return templates.TemplateResponse(request, "settings.html", {
            "csrf": session["csrf"], "theme_mode": database.get_theme_mode(),
            "boot_json": json.dumps(boot, ensure_ascii=False, separators=(",", ":")),
        })

    def require_csrf(request: Request) -> dict[str, str]:
        session = require_session(request)
        if not csrf_ok(session, request):
            raise HTTPException(403, "Invalid CSRF token")
        return session

    @app.post("/api/library")
    async def add_library_meal(request: Request):
        require_csrf(request)
        body = await request.json()
        name = " ".join(str(body.get("name", "")).split())
        if not name or len(name) > 100:
            raise HTTPException(400, "Enter a meal name up to 100 characters")
        try:
            meal, created = database.add_meal(name)
        except Exception as exc:
            raise HTTPException(409, "That meal could not be added") from exc
        return {"meal": meal, "created": created, "library": database.library()}

    @app.delete("/api/library/{meal_id}")
    async def delete_library_meal(request: Request, meal_id: str):
        require_csrf(request)
        item = database.delete_meal(meal_id)
        if item is None:
            raise HTTPException(404, "Meal not found in the library")
        return {"ok": True, "meal": item}

    @app.post("/api/settings/theme")
    async def save_theme_mode(request: Request):
        require_csrf(request)
        body = await request.json()
        mode = str(body.get("mode", ""))
        if mode not in {"system", "light", "dark"}:
            raise HTTPException(400, "Choose system, light, or dark appearance")
        database.set_theme_mode(mode)
        return {"theme_mode": mode}

    @app.post("/api/library/shuffle")
    async def shuffle_library(request: Request):
        require_csrf(request)
        return {"library": database.shuffle_library()}

    def parse_slot_payload(body: dict[str, Any]) -> list[dict[str, Any]]:
        raw = body.get("slots")
        if not isinstance(raw, list) or not raw or len(raw) > 12:
            raise HTTPException(400, "Keep between 1 and 12 meal slots")
        result: list[dict[str, Any]] = []
        ids: set[str] = set()
        times: set[str] = set()
        for item in raw:
            name = " ".join(str(item.get("name", "")).split())
            time_value = str(item.get("time", ""))
            slot_id = str(item.get("id", "")) or str(uuid.uuid4())
            try:
                datetime.strptime(time_value, "%H:%M")
            except ValueError as exc:
                raise HTTPException(400, f"Choose a valid time for {name or 'each slot'}") from exc
            if not name or len(name) > 32:
                raise HTTPException(400, "Slot names must contain 1–32 characters")
            if slot_id in ids:
                raise HTTPException(400, "Meal slot IDs must be unique")
            if time_value in times:
                raise HTTPException(409, "Every meal slot needs a unique time, even if only one minute apart")
            ids.add(slot_id)
            times.add(time_value)
            result.append({"id": slot_id, "name": name, "time": time_value})
        return result

    @app.post("/api/settings/slots")
    async def save_slots(request: Request):
        require_csrf(request)
        body = await request.json()
        new_slots = parse_slot_payload(body)
        old_slots = database.slots()
        old_by_id = {slot["id"]: slot for slot in old_slots}
        if settings.todoist_token:
            try:
                project = await asyncio.to_thread(todoist_client.find_project, settings.todoist_project)
                active = await asyncio.to_thread(todoist_client.list_tasks, str(project["id"]))
            except TodoistError as exc:
                raise HTTPException(502, str(exc)) from exc
        else:
            active = []
        # A slot with active tasks cannot be removed until those meals are moved or completed.
        remaining_ids = {slot["id"] for slot in new_slots}
        removed = [slot for slot in old_slots if slot["id"] not in remaining_ids]
        for slot in removed:
            slot_times = {slot["time"], *slot.get("time_aliases", [])}
            if any(due_parts(task, settings.tz)[1] in slot_times for task in active if due_parts(task, settings.tz)[0] is not None):
                raise HTTPException(409, f"Move or complete active {slot['name']} meals before removing this slot")
        # Save first so the new time and every prior alias remain classifiable after
        # a partial Todoist failure. On a retry, aliases are still scanned even
        # though the current preset already contains the new time.
        database.save_slots(new_slots)
        failures: list[str] = []
        if settings.todoist_token:
            persisted_by_id = {slot["id"]: slot for slot in database.slots()}
            for slot in new_slots:
                persisted = persisted_by_id[slot["id"]]
                target_time = slot["time"]
                matching_times = set(persisted.get("time_aliases", []))
                old = old_by_id.get(slot["id"])
                if old and old["time"] != target_time:
                    matching_times.add(old["time"])
                for task in active:
                    task_day, task_time = due_parts(task, settings.tz)
                    if task_day is None or task_time not in matching_times or task_time == target_time or not task.get("id"):
                        continue
                    new_due = datetime.combine(task_day, datetime.strptime(target_time, "%H:%M").time())
                    operation_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"meal-slot:{slot['id']}:{task['id']}:{target_time}"))
                    try:
                        updated = await asyncio.to_thread(
                            todoist_client.update_task, str(task["id"]),
                            {"due_datetime": new_due.isoformat(timespec="seconds"), "due_timezone": settings.timezone},
                            operation_id,
                        )
                        check_day, check_time = due_parts(updated, settings.tz)
                        if check_day != task_day or check_time != target_time:
                            raise TodoistError("Todoist read-back did not match the requested slot time")
                    except TodoistError:
                        failures.append(str(task.get("content") or task["id"]))
        if failures:
            raise HTTPException(502, "Preset saved, but some active meal times could not be updated: " + ", ".join(failures[:8]))
        return {"slots": database.slots(), "updated": True}

    def require_project_task(task_key: str) -> dict[str, Any]:
        if not settings.todoist_token:
            raise HTTPException(503, "Todoist is not configured")
        project_id = database.get_value("meals_project_id")
        cached = database.get_project_task(task_key)
        if not cached or not project_id or str(cached["project_id"]) != str(project_id):
            raise HTTPException(404, "Meal not found in the Meals planner")
        return cached

    @app.get("/api/operations/{operation_id}")
    async def operation_status(request: Request, operation_id: str):
        require_session(request)
        try:
            operation_id = str(uuid.UUID(operation_id))
        except ValueError as exc:
            raise HTTPException(404, "Operation not found") from exc
        status = database.get_action_status(operation_id)
        if not status or status["kind"] not in {"create-meal", "move-meal", "delete-meal"}:
            raise HTTPException(404, "Operation not found")
        return status

    @app.post("/api/operations/{operation_id}/retry")
    async def retry_operation(request: Request, operation_id: str):
        require_csrf(request)
        try:
            operation_id = str(uuid.UUID(operation_id))
        except ValueError as exc:
            raise HTTPException(404, "Operation not found") from exc
        if not database.retry_saved_action(operation_id):
            raise HTTPException(409, "This operation is not waiting for a retry")
        outbox.notify()
        return {"ok": True, "operation_id": operation_id}

    @app.post("/api/plan")
    async def add_planned_meal(request: Request):
        require_csrf(request)
        body = await request.json()
        if not settings.todoist_token:
            raise HTTPException(503, "Todoist is not configured")
        meal_id = str(body.get("meal_id", ""))
        slot_id = str(body.get("slot_id", ""))
        request_id = str(body.get("request_id", ""))
        day_value = str(body.get("date", ""))
        item = database.get_meal(meal_id)
        slot = next((x for x in database.slots() if x["id"] == slot_id), None)
        if not item or not slot:
            raise HTTPException(404, "Choose a meal and a valid meal slot")
        try:
            selected_day = date.fromisoformat(day_value)
        except ValueError as exc:
            raise HTTPException(400, "Choose a valid date") from exc
        if selected_day.weekday() > 6:
            raise HTTPException(400, "Invalid meal date")
        try:
            uuid.UUID(request_id)
        except ValueError as exc:
            raise HTTPException(400, "Invalid request ID") from exc
        project_id = database.get_value("meals_project_id")
        if not project_id:
            raise HTTPException(503, "Open the planner once so it can connect to the Meals project")
        due_at = datetime.combine(selected_day, datetime.strptime(slot["time"], "%H:%M").time())
        task_key = f"local:{request_id}"
        due = {"datetime": due_at.isoformat(timespec="seconds"), "date": due_at.isoformat(timespec="seconds"), "timezone": settings.timezone}
        local_task = {"id": task_key, "content": item["name"], "project_id": project_id, "description": f"meal-planner-request-id: {request_id}", "due": due}
        payload = {
            "meal_id": meal_id, "slot_id": slot_id, "date": selected_day.isoformat(), "name": item["name"],
            "project_id": project_id, "due_datetime": due_at.isoformat(timespec="seconds"),
            "due_timezone": settings.timezone,
        }
        try:
            action = database.enqueue_plan_action(request_id, "create-meal", payload, task_key, local_task)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        outbox.notify()
        return {"ok": True, "operation_id": request_id, "task_key": task_key, "task_id": task_key, "name": item["name"], "state": action["state"]}

    @app.post("/api/plan/{task_id}/move")
    async def move_planned_meal(request: Request, task_id: str):
        require_csrf(request)
        cached = require_project_task(task_id)
        body = await request.json()
        slot_id = str(body.get("slot_id", ""))
        slots = database.slots()
        slot = next((x for x in slots if x["id"] == slot_id), None)
        try:
            selected_day = date.fromisoformat(str(body.get("date", "")))
            request_id = str(uuid.UUID(str(body.get("request_id", ""))))
        except ValueError as exc:
            raise HTTPException(400, "Invalid date or request ID") from exc
        if not slot:
            raise HTTPException(400, "Choose a valid meal slot")
        due_at = datetime.combine(selected_day, datetime.strptime(slot["time"], "%H:%M").time())
        due_datetime = due_at.isoformat(timespec="seconds")
        payload = {
            "task_key": cached["task_key"], "task_id": str(cached.get("remote_id") or cached["task"].get("id") or ""),
            "project_id": str(cached["project_id"]), "slot_id": slot_id, "date": selected_day.isoformat(),
            "due_datetime": due_datetime, "due_timezone": settings.timezone,
        }
        task = dict(cached["task"])
        task["due"] = {"datetime": due_datetime, "date": due_datetime, "timezone": settings.timezone}
        try:
            action = database.enqueue_plan_action(request_id, "move-meal", payload, cached["task_key"], task)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        outbox.notify()
        return {"ok": True, "operation_id": request_id, "task_key": cached["task_key"], "state": action["state"]}

    @app.delete("/api/plan/{task_id}")
    async def delete_planned_meal(request: Request, task_id: str):
        require_csrf(request)
        cached = require_project_task(task_id)
        request_id = str(uuid.UUID(request.headers.get("X-Request-ID", "")))
        remote_id = str(cached.get("remote_id") or cached["task"].get("id") or "")
        payload = {"task_key": cached["task_key"], "task_id": remote_id, "project_id": str(cached["project_id"])}
        try:
            action = database.enqueue_plan_action(request_id, "delete-meal", payload, cached["task_key"])
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        outbox.notify()
        return {"ok": True, "operation_id": request_id, "task_key": cached["task_key"], "state": action["state"]}

    return app
