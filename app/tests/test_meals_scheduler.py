from __future__ import annotations

import importlib.util
import sys
from datetime import date
from pathlib import Path

SCRIPT = Path("/home/hermes-admin/.hermes/scripts/todoist_recurring_rollover.py")
spec = importlib.util.spec_from_file_location("rollover", SCRIPT)
assert spec and spec.loader
rollover = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = rollover
spec.loader.exec_module(rollover)


class FakeTodoist:
    def __init__(self, tasks):
        self.tasks = list(tasks)
        self.done = []
        self.deleted = []

    def projects(self):
        return [{"id": "meals-project", "name": "Meals"}]

    def active_tasks(self):
        return list(self.tasks)

    def close_task(self, task_id, request_id=None):
        task = next(task for task in self.tasks if task["id"] == task_id)
        self.tasks.remove(task)
        self.done.append({**task, "project_id": "meals-project"})

    def completed_tasks(self, since, until):
        return self.done

    def delete_task(self, task_id, request_id=None):
        self.deleted.append(task_id)
        self.tasks = [task for task in self.tasks if task["id"] != task_id]

    def get_task(self, task_id):
        return next((task for task in self.tasks if task["id"] == task_id), None)


def task(task_id, due, project="meals-project", **extra):
    return {"id": task_id, "project_id": project, "content": task_id, "due": due, **extra}


def test_meals_maintenance_only_mutates_past_or_undated_meals():
    client = FakeTodoist([
        task("past", {"date": "2026-09-26"}),
        task("today", {"date": "2026-09-27"}),
        task("future", {"date": "2026-09-28"}),
        task("undated", None),
        task("other-project", {"date": "2026-09-20"}, project="other"),
    ])
    result = rollover.maintain_meals_project(client, date(2026, 9, 27))
    assert [action["action"] for action in result.actions] == [
        "completed_past_meal", "deleted_undated_meal"
    ]
    assert not result.blockers
    assert [task["id"] for task in client.tasks] == ["today", "future", "other-project"]
    assert client.deleted == ["undated"]


def test_meals_maintenance_dry_run_has_no_mutations():
    client = FakeTodoist([
        task("past", {"date": "2026-09-26"}),
        task("undated", None),
    ])
    result = rollover.maintain_meals_project(client, date(2026, 9, 27), dry_run=True)
    assert {action["action"] for action in result.actions} == {
        "would_complete_past_meal", "would_delete_undated_meal"
    }
    assert not result.blockers
    assert not client.done and not client.deleted


def test_recurring_client_hides_meals_project_from_legacy_rollover():
    client = FakeTodoist([
        task("meal-recurring", {"date": "2026-09-26", "is_recurring": True}),
        task("ordinary-recurring", {"date": "2026-09-26", "is_recurring": True}, project="other"),
    ])
    filtered = rollover.ProjectExcludingTodoistClient(client, {"meals-project"})
    assert [item["id"] for item in filtered.active_tasks()] == ["ordinary-recurring"]


def test_meals_cleanup_rechecks_project_before_mutating_snapshot_items():
    client = FakeTodoist([task("moved", {"date": "2026-09-26"})])
    original_get = client.get_task

    def moved_out_of_meals(task_id):
        fresh = original_get(task_id)
        assert fresh is not None
        fresh["project_id"] = "other-project"
        return fresh

    client.get_task = moved_out_of_meals
    result = rollover.maintain_meals_project(client, date(2026, 9, 27))
    assert not result.actions and not result.blockers
    assert len(client.tasks) == 1 and not client.done and not client.deleted


def test_meals_cleanup_rechecks_new_children_before_delete_or_complete():
    class ChildAppears(FakeTodoist):
        def __init__(self, tasks):
            super().__init__(tasks)
            self.active_calls = 0

        def active_tasks(self):
            self.active_calls += 1
            if self.active_calls == 2:
                self.tasks.append(task("new-child", {"date": "2026-09-26"}, parent_id="parent"))
            return list(self.tasks)

    for due in (None, {"date": "2026-09-26"}):
        client = ChildAppears([task("parent", due)])
        result = rollover.maintain_meals_project(client, date(2026, 9, 27))
        assert not result.actions
        assert result.blockers and "subtask tree" in result.blockers[0]["error"]
        assert not client.deleted and not client.done
        assert any(item["id"] == "parent" for item in client.tasks)


def test_recurring_meal_is_left_untouched_and_reported():
    client = FakeTodoist([
        task("recurring", {"date": "2026-09-26", "is_recurring": True}),
    ])
    result = rollover.maintain_meals_project(client, date(2026, 9, 27))
    assert not result.actions
    assert result.blockers and "recurring" in result.blockers[0]["error"]
    assert len(client.tasks) == 1
