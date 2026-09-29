from __future__ import annotations

from datetime import date, datetime
import html
import json
import re
import time
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database
from app.main import create_app
from app.todoist import TodoistClient

TZ = ZoneInfo("Asia/Kolkata")


class FakeTodoist:
    def __init__(self):
        self.project = {"id": "meals-project", "name": "Meals"}
        self.tasks: dict[str, dict] = {}
        self.completed: list[dict] = []
        self.created: list[dict] = []
        self.deleted: list[str] = []
        self.fail_after_create = False

    def find_project(self, name):
        assert name == "Meals"
        return self.project

    def list_tasks(self, project_id):
        assert project_id == self.project["id"]
        return list(self.tasks.values())

    def get_task(self, task_id):
        return self.tasks.get(task_id)

    def completed_tasks(self, project_id, since, until):
        return [t for t in self.completed if t["project_id"] == project_id and since.date() <= date.fromisoformat(t["due"]["date"][:10]) < until.date()]

    def create_task(self, title, project_id, due_at, timezone, request_id, description=""):
        task = {"id": f"task-{len(self.created)+1}", "content": title, "project_id": project_id,
                "description": description,
                "due": {"datetime": due_at.isoformat(timespec="seconds"), "date": due_at.isoformat(timespec="seconds"), "timezone": timezone}}
        self.tasks[task["id"]] = task
        self.created.append({"task": task, "request_id": request_id})
        if self.fail_after_create:
            self.fail_after_create = False
            from app.todoist import TodoistError
            raise TodoistError("simulated lost response after remote create")
        return task

    def update_task(self, task_id, payload, request_id):
        task = self.tasks[task_id]
        due_at = datetime.fromisoformat(payload["due_datetime"])
        task["due"] = {"datetime": due_at.isoformat(timespec="seconds"), "date": due_at.isoformat(timespec="seconds"), "timezone": payload["due_timezone"]}
        return task

    def close_task(self, task_id, request_id):
        task = self.tasks.pop(task_id)
        task["completed_at"] = datetime.now(TZ).isoformat()
        self.completed.append(task)

    def delete_task(self, task_id, request_id):
        self.deleted.append(task_id)
        self.tasks.pop(task_id, None)


def make_app(tmp_path: Path, fake: FakeTodoist | None = None):
    settings = Settings(
        todoist_token="test-token", todoist_project="Meals", app_password="test-password",
        session_secret="a" * 48, database_path=tmp_path / "planner.sqlite3",
        timezone="Asia/Kolkata", allowed_hosts=("testserver", "localhost"), cookie_secure=False,
    )
    now = lambda: datetime(2026, 9, 27, 10, 0, tzinfo=TZ)
    db = Database(settings.database_path)
    return create_app(settings, todoist=fake or FakeTodoist(), db=db, now=now), db


def login(client: TestClient):
    response = client.post("/login", data={"password": "test-password"}, follow_redirects=False)
    assert response.status_code == 303
    return response


def csrf(client: TestClient):
    login(client)
    page = client.get("/")
    return re.search(r'data-csrf="([^"]+)"', page.text).group(1)


def boot_data(page: str) -> dict:
    match = re.search(r'data-boot="([^"]+)"', page)
    assert match, "React boot data missing from page"
    return json.loads(html.unescape(match.group(1)))


def test_auth_redirect_safe_hosts_and_headers(tmp_path):
    app, _ = make_app(tmp_path)
    with TestClient(app) as client:
        response = client.get("/", follow_redirects=False)
        assert response.status_code == 303
        assert response.headers["location"].startswith("/login?next=")
        assert response.headers["x-frame-options"] == "DENY"
        login(client)
        assert client.get("/").status_code == 200
        bad = TestClient(app, base_url="http://attacker.example").get("/healthz")
        assert bad.status_code == 400


def test_week_grid_counts_and_hides_undated_meals(tmp_path):
    fake = FakeTodoist()
    fake.tasks = {
        "1": {"id": "1", "project_id": "meals-project", "content": "Idli", "due": {"datetime": "2026-09-21T08:00:00", "date": "2026-09-21T08:00:00", "timezone": "Asia/Kolkata"}},
        "2": {"id": "2", "project_id": "meals-project", "content": "Sambar", "due": {"datetime": "2026-09-21T08:00:00", "date": "2026-09-21T08:00:00", "timezone": "Asia/Kolkata"}},
        "3": {"id": "3", "project_id": "meals-project", "content": "Rice", "due": {"datetime": "2026-09-21T13:00:00", "date": "2026-09-21T13:00:00", "timezone": "Asia/Kolkata"}},
        "4": {"id": "4", "project_id": "meals-project", "content": "Unscheduled", "due": None},
    }
    completed = {"id": "5", "project_id": "meals-project", "content": "Pasta", "due": {"datetime": "2026-09-22T19:00:00", "date": "2026-09-22T19:00:00", "timezone": "Asia/Kolkata"}}
    fake.completed.append(completed)
    app, _ = make_app(tmp_path, fake)
    with TestClient(app) as client:
        login(client)
        page = client.get("/?week=2026-09-21")
        boot = boot_data(page.text)
        assert page.status_code == 200
        assert boot["week_start_label"] == "Sep 21" and boot["days"][0]["day_name"] == "Monday"
        assert boot["days"][0]["count"] == 3
        meals = boot["grid"]["breakfast"]["2026-09-21"]
        assert {meal["name"] for meal in meals} == {"Idli", "Sambar"}
        assert "Rice" in {meal["name"] for meal in boot["grid"]["lunch"]["2026-09-21"]}
        assert "Unscheduled" not in page.text
        completed = boot["grid"]["dinner"]["2026-09-22"]
        assert any(meal["name"] == "Pasta" and meal["completed"] for meal in completed)
        assert "breakfast" in boot["grid"]


def test_library_add_deduplicates_case_insensitively_and_shuffles(tmp_path):
    app, _ = make_app(tmp_path)
    with TestClient(app) as client:
        token = csrf(client)
        first = client.post("/api/library", headers={"X-CSRF-Token": token}, json={"name": "  Lemon   rice "})
        assert first.status_code == 200 and first.json()["created"] is True
        duplicate = client.post("/api/library", headers={"X-CSRF-Token": token}, json={"name": "lemon rice"})
        assert duplicate.status_code == 200 and duplicate.json()["created"] is False
        assert len(duplicate.json()["library"]) == 1
        assert client.post("/api/library/shuffle", headers={"X-CSRF-Token": token}, json={}).status_code == 200


def test_library_manager_removes_reusable_item_only_from_settings(tmp_path):
    fake = FakeTodoist()
    fake.tasks["planned"] = {"id": "planned", "project_id": "meals-project", "content": "Idli", "due": {"datetime": "2026-09-21T08:00:00", "date": "2026-09-21T08:00:00", "timezone": "Asia/Kolkata"}}
    app, db = make_app(tmp_path, fake)
    meal, _ = db.add_meal("Idli")
    with TestClient(app) as client:
        token = csrf(client)
        settings = boot_data(client.get("/settings").text)
        board = boot_data(client.get("/").text)
        assert any(item["id"] == meal["id"] for item in settings["library"])
        assert any(item["id"] == meal["id"] for item in board["library"])
        frontend = (Path(__file__).parents[1] / "frontend" / "src" / "main.jsx").read_text()
        assert "Manage meal library" in frontend and "manage-remove-meal" in frontend
        denied = client.delete(f"/api/library/{meal['id']}")
        assert denied.status_code == 403
        removed = client.delete(f"/api/library/{meal['id']}", headers={"X-CSRF-Token": token})
        assert removed.status_code == 200 and removed.json()["meal"]["name"] == "Idli"
        assert db.get_meal(meal["id"]) is None
        assert fake.tasks["planned"]["content"] == "Idli"


def test_theme_mode_defaults_to_system_and_persists_three_choices(tmp_path):
    app, db = make_app(tmp_path)
    assert db.get_theme_mode() == "system"
    with TestClient(app) as client:
        token = csrf(client)
        page = client.get("/")
        assert 'data-theme-mode="system"' in page.text
        assert boot_data(page.text)["theme_mode"] == "system"
        settings = boot_data(client.get("/settings").text)
        assert settings["theme_mode"] == "system"
        denied = client.post("/api/settings/theme", json={"mode": "dark"})
        assert denied.status_code == 403
        for mode in ("dark", "light", "system"):
            saved = client.post("/api/settings/theme", headers={"X-CSRF-Token": token}, json={"mode": mode})
            assert saved.status_code == 200 and saved.json()["theme_mode"] == mode
            assert db.get_theme_mode() == mode
            assert f'data-theme-mode="{mode}"' in client.get("/").text
        frontend = (Path(__file__).parents[1] / "frontend" / "src" / "main.jsx").read_text()
        assert all(f'"{mode}"' in frontend for mode in ("system", "light", "dark"))
        assert 'mode === "system" ? (prefersDark ? "dark" : "light")' in frontend


def wait_for_operation(client: TestClient, operation_id: str, timeout: float = 5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = client.get(f"/api/operations/{operation_id}")
        assert result.status_code == 200, result.text
        if result.json()["state"] in {"done", "failed"}:
            return result.json()
        time.sleep(0.03)
    raise AssertionError(f"operation {operation_id} did not settle in {timeout}s")


def test_add_move_and_delete_plan_with_readback(tmp_path):
    fake = FakeTodoist()
    app, db = make_app(tmp_path, fake)
    meal, _ = db.add_meal("Idli")
    with TestClient(app) as client:
        token = csrf(client)
        create_id = "75bf82b5-b09e-4d11-bb70-2d7bb8f6d2b0"
        result = client.post("/api/plan", headers={"X-CSRF-Token": token}, json={"meal_id": meal["id"], "date": "2026-09-21", "slot_id": "breakfast", "request_id": create_id})
        assert result.status_code == 200, result.text
        operation_id = result.json()["operation_id"]
        assert wait_for_operation(client, operation_id)["state"] == "done"
        task_id = db.get_action(operation_id)["remote_id"]
        assert fake.tasks[task_id]["content"] == "Idli"
        assert fake.tasks[task_id]["due"]["datetime"] == "2026-09-21T08:00:00"
        task_key = db.get_action(operation_id)["task_key"]
        move_id = "f91f5e5e-7d53-42dd-967e-f52d5a9b8ae0"
        moved = client.post(f"/api/plan/{task_key}/move", headers={"X-CSRF-Token": token}, json={"date": "2026-09-23", "slot_id": "lunch", "request_id": move_id})
        assert moved.status_code == 200, moved.text
        assert wait_for_operation(client, move_id)["state"] == "done"
        assert fake.tasks[task_id]["due"]["datetime"] == "2026-09-23T13:00:00"
        delete_id = "be32799c-dd75-43d4-a1fa-2e5162dcd4ee"
        deleted = client.delete(f"/api/plan/{task_key}", headers={"X-CSRF-Token": token, "X-Request-ID": delete_id})
        assert deleted.status_code == 200
        assert wait_for_operation(client, delete_id)["state"] == "done"
        assert task_id in fake.deleted
        assert task_id not in fake.tasks


def test_ambiguous_meal_create_is_reconciled_instead_of_duplicated(tmp_path):
    fake = FakeTodoist()
    fake.fail_after_create = True
    app, db = make_app(tmp_path, fake)
    meal, _ = db.add_meal("Idli")
    with TestClient(app) as client:
        token = csrf(client)
        payload = {"meal_id": meal["id"], "date": "2026-09-21", "slot_id": "breakfast"}
        first = client.post("/api/plan", headers={"X-CSRF-Token": token}, json={**payload, "request_id": "d0233aae-3491-4fd0-a68e-3bf5a5bde310"})
        assert first.status_code == 200
        operation_id = first.json()["operation_id"]
        assert wait_for_operation(client, operation_id)["state"] == "done"
        assert len(fake.tasks) == 1
        second = client.post("/api/plan", headers={"X-CSRF-Token": token}, json={**payload, "request_id": operation_id})
        assert second.status_code == 200
        assert second.json()["operation_id"] == operation_id
        assert len(fake.tasks) == 1


def test_meal_create_waits_for_todoist_readback_without_duplicating(tmp_path):
    fake = FakeTodoist()
    app, db = make_app(tmp_path, fake)
    meal, _ = db.add_meal("Idli")
    fake.get_task = lambda task_id: None
    with TestClient(app) as client:
        token = csrf(client)
        response = client.post("/api/plan", headers={"X-CSRF-Token": token}, json={
            "meal_id": meal["id"], "date": "2026-09-21", "slot_id": "breakfast",
            "request_id": "8016ac6a-80f4-4126-9f46-8e7b22e96072",
        })
        assert response.status_code == 200
        operation_id = response.json()["operation_id"]
        time.sleep(0.12)
        assert len(fake.tasks) == 1
        action = db.get_action(operation_id)
        assert action is not None and action["state"] in {"pending", "processing"}
        assert action["create_attempted"] == 1


def test_plan_mutation_returns_before_slow_todoist_write(tmp_path):
    class SlowTodoist(FakeTodoist):
        def create_task(self, *args, **kwargs):
            time.sleep(0.6)
            return super().create_task(*args, **kwargs)

    app, db = make_app(tmp_path, SlowTodoist())
    meal, _ = db.add_meal("Idli")
    with TestClient(app) as client:
        token = csrf(client)
        started = time.monotonic()
        response = client.post("/api/plan", headers={"X-CSRF-Token": token}, json={
            "meal_id": meal["id"], "date": "2026-09-21", "slot_id": "breakfast",
            "request_id": "1a5d1f27-84bc-4990-9689-13edb98f4f11",
        })
        elapsed = time.monotonic() - started
        assert response.status_code == 200
        assert elapsed < 0.4
        board = client.get("/").text
        tasks = [task for cells in boot_data(board)["grid"].values() for items in cells.values() for task in items]
        assert any(task["operation_id"] == response.json()["operation_id"] for task in tasks)
        assert "/static/planner.bundle.js?v=20" in board
        assert "/static/app.css?v=33" in board
        assert wait_for_operation(client, response.json()["operation_id"])["state"] == "done"


def test_delete_ack_does_not_fail_on_a_stale_followup_read():
    methods = []

    def handler(request):
        methods.append(request.method)
        if request.method == "DELETE":
            return httpx.Response(204)
        return httpx.Response(200, json={"id": "meal-1"})

    client = TodoistClient("unused-test-token", transport=httpx.MockTransport(handler))
    client.delete_task("meal-1", "delete-request-id")
    assert methods == ["DELETE"]


def test_lucide_assets_and_react_sync_indicator_are_served(tmp_path):
    fake = FakeTodoist()
    fake.tasks["meal-1"] = {
        "id": "meal-1", "project_id": "meals-project", "content": "Idli",
        "due": {"datetime": "2026-09-21T08:00:00", "date": "2026-09-21T08:00:00", "timezone": "Asia/Kolkata"},
    }
    app, _ = make_app(tmp_path, fake)
    with TestClient(app) as client:
        login(client)
        page = client.get("/").text
        boot = boot_data(page)
        icons = client.get("/static/lucide-icons.svg")
        bundle = client.get("/static/planner.bundle.js")
        frontend = (Path(__file__).parents[1] / "frontend" / "src" / "main.jsx").read_text()
        assert any(task["cache_key"] == "remote:meal-1" for cells in boot["grid"].values() for items in cells.values() for task in items)
        assert bundle.status_code == 200 and "createRoot" in bundle.text
        assert icons.status_code == 200 and all(f'id="{name}"' in icons.text for name in ("settings", "moon", "sun", "loader", "check"))
        assert '/static/lucide-icons.svg#${name}' in frontend
        assert "meal-sync-indicator" in frontend and "sync-spinner" in frontend
        assert "window.location.reload" not in frontend


def test_settings_slot_rows_keep_labels_screenreader_only_at_all_widths():
    css = (Path(__file__).parents[1] / "static" / "app.css").read_text()
    frontend = (Path(__file__).parents[1] / "frontend" / "src" / "main.jsx").read_text()
    assert '.visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}' in css
    assert '<span className="visually-hidden">Meal slot label</span>' in frontend
    assert '<span className="visually-hidden">Preset time</span>' in frontend
    assert ".slot-edit-row label>span{" not in css
    assert ".slot-edit-row{grid-template-columns:28px minmax(0,1fr) 170px 38px}" in css
    assert ".slot-order-step{display:none;" in css
    assert "body.keyboard-navigation .slot-edit-row,.slot-edit-row.reorder-actions-open{grid-template-columns:52px" in css
    assert ".slot-edit-row:hover .slot-order-step" not in css
    assert "@media(max-width:560px) and (hover:hover){.slot-edit-row:hover" not in css
    assert "slot-edit-grip" in frontend and "slot-order-step" in frontend and "onPointerDown" in frontend
    assert "DndContext" in frontend and "SortableContext" in frontend and "useSortable" in frontend
    assert "PointerSensor" in frontend and "KeyboardSensor" not in frontend and "sortableKeyboardCoordinates" not in frontend
    assert 'from "motion/react"' in frontend  # retained for swipe/delete animation
    assert "suppressPostDragClickRef.current = true" in frontend and "if (suppressPostDragClickRef.current)" in frontend
    assert 'element.style.setProperty("--sortable-transform"' in frontend and 'element.style.setProperty("--sortable-transition"' in frontend
    assert "slot-edit-grip{flex:0 0 20px;width:20px;height:28px;font-size:15px;touch-action:none;cursor:grab}" in css
    assert 'onClick={() => onReorderKey(slot.id, -1)}' in frontend and 'onClick={() => onReorderKey(slot.id, 1)}' in frontend
    assert "setSlots(arrayMove(slots, oldIndex, newIndex))" in frontend and "onDragOver={handleSlotDragOver}" not in frontend
    assert "draggingId" not in frontend and "reorderStartStateRef" not in frontend
    assert '"@dnd-kit/accessibility": "3.1.1"' in (Path(__file__).parents[1] / "frontend" / "package.json").read_text()
    assert "Use the Move Up and Move Down buttons to reorder this slot with a keyboard." in frontend
    assert 'document.addEventListener("keydown", onKeyDown, true)' in frontend and 'keyboard-navigation' in frontend
    assert "body.keyboard-navigation .slot-edit-grip,.slot-edit-row.reorder-actions-open .slot-edit-grip{display:none}" in css
    assert "@media(max-width:560px){.slot-edit-row{grid-template-columns:28px minmax(0,1fr) 72px 34px}" in css
    assert "setReorderActionsOpen(true)" in frontend and 'event.target.closest(".slot-order-controls")' in frontend
    assert "setFeedback(`Moved ${" not in frontend
    assert 'id="slot-reorder-announcement" role="status" aria-live="polite"' in frontend
    assert '<table className="meal-grid"' in frontend and '<caption className="visually-hidden">' in frontend
    assert 'scope="col"' in frontend and 'scope="row"' in frontend
    assert 'className="meal-action-trigger"' in frontend and 'className="library-plan-trigger"' in frontend
    assert "submitAccessibleAction" in frontend and 'role="status" aria-live="polite" aria-atomic="true"' in frontend
    assert ":where(button,a,input,select,textarea,[tabindex]):focus-visible" in css and "@media(hover:none)" in css
    assert all(message not in frontend for message in ('notify("Meal placed")', 'notify("Meal moved")', 'notify("Removing meal")', 'notify("Meal added to your library")'))
    assert ".slot-edit-row .slot-time{width:100%;max-width:72px;min-width:0;padding:0 2px;-webkit-appearance:none;appearance:none;text-align:center;font-size:11px}" in css
    assert ".slot-settings-form{padding:0;border:0;border-radius:0;background:transparent;box-shadow:none}" in css
    assert 'aria-label="Meal slot label"' in frontend and 'id="slot-settings"' in frontend
    assert 'id="revert-slot-changes"' in frontend and 'disabled={saving || !dirty}' in frontend
    assert frontend.count('disabled={saving}') >= 2 and 'if (saving || isReordering' in frontend
    assert 'baseline = useRef(JSON.stringify(data.slots || []))' in frontend and 'JSON.parse(baseline.current)' in frontend
    assert 'data-state={saveState}' in frontend and 'setSaveState("saving")' in frontend and 'setSaveState("saved")' in frontend
    assert "Saving…" not in frontend and "420 - (performance.now() - started)" in frontend
    assert 'onSubmit={saveSlots}' in frontend and 'window.location.href = "/"' not in frontend
    assert ".slot-save-button{position:relative;display:grid;place-items:center;width:112px;min-height:40px;flex:0 0 112px;overflow:hidden;" in css
    assert "slot-save-button[data-state=error] .slot-save-error" in css and "@keyframes slot-save-failure" in css
    assert 'M18 6 6 18M6 6l12 12' in frontend and 'M3 6h18M8 6V4h8v2m2 0-1 14H7L6 6m4 5v6m4-6v6' in frontend
    assert "#slot-settings button[type=submit]:disabled:not(.is-saved)" in css
    assert ".remove-slot:hover{transform:none;filter:brightness(.94)}" in css
    assert "transform:rotate(90deg)" not in css


def test_slot_times_unique_and_edit_migrates_active_tasks(tmp_path):
    fake = FakeTodoist()
    fake.tasks["timed"] = {"id": "timed", "project_id": "meals-project", "content": "Breakfast", "due": {"datetime": "2026-09-28T08:00:00", "date": "2026-09-28T08:00:00", "timezone": "Asia/Kolkata"}}
    app, db = make_app(tmp_path, fake)
    with TestClient(app) as client:
        token = csrf(client)
        slots = db.slots()
        slots[0]["time"] = "08:01"
        result = client.post("/api/settings/slots", headers={"X-CSRF-Token": token}, json={"slots": [{k: s[k] for k in ("id", "name", "time")} for s in slots]})
        assert result.status_code == 200, result.text
        assert fake.tasks["timed"]["due"]["datetime"] == "2026-09-28T08:01:00"
        slots = [{"id": x["id"], "name": x["name"], "time": "12:00"} for x in db.slots()]
        conflict = client.post("/api/settings/slots", headers={"X-CSRF-Token": token}, json={"slots": slots})
        assert conflict.status_code == 409


def test_slot_time_migration_retries_old_alias_after_partial_failure(tmp_path):
    from app.todoist import TodoistError

    class FlakyTodoist(FakeTodoist):
        fail_once = True

        def update_task(self, task_id, payload, request_id):
            if self.fail_once:
                self.fail_once = False
                raise TodoistError("temporary failure")
            return super().update_task(task_id, payload, request_id)

    fake = FlakyTodoist()
    fake.tasks["timed"] = {"id": "timed", "project_id": "meals-project", "content": "Breakfast", "due": {"datetime": "2026-09-28T08:00:00", "date": "2026-09-28T08:00:00", "timezone": "Asia/Kolkata"}}
    app, db = make_app(tmp_path, fake)
    with TestClient(app) as client:
        token = csrf(client)
        slots = db.slots()
        slots[0]["time"] = "08:01"
        body = {"slots": [{k: s[k] for k in ("id", "name", "time")} for s in slots]}
        first = client.post("/api/settings/slots", headers={"X-CSRF-Token": token}, json=body)
        assert first.status_code == 502
        assert fake.tasks["timed"]["due"]["datetime"] == "2026-09-28T08:00:00"
        second = client.post("/api/settings/slots", headers={"X-CSRF-Token": token}, json=body)
        assert second.status_code == 200
        assert fake.tasks["timed"]["due"]["datetime"] == "2026-09-28T08:01:00"


def test_empty_search_add_behavior_has_animation_hook_and_slot_names(tmp_path):
    app, _ = make_app(tmp_path)
    with TestClient(app) as client:
        login(client)
        page = client.get("/").text
        boot = boot_data(page)
        frontend = (Path(__file__).parents[1] / "frontend" / "src" / "main.jsx").read_text()
        assert "id=\"meal-search\"" in frontend and "id=\"add-meal\"" in frontend
        assert "shake-error" in frontend and 'onKeyDown={(event)' in frontend
        assert all(any(slot["name"] == name for slot in boot["slots"]) for name in ("Breakfast", "Lunch", "Dinner", "School snack"))
