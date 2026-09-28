from __future__ import annotations

import json
import random
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

DEFAULT_SLOTS = [
    {"id": "breakfast", "name": "Breakfast", "time": "08:00", "position": 0},
    {"id": "lunch", "name": "Lunch", "time": "13:00", "position": 1},
    {"id": "dinner", "name": "Dinner", "time": "19:00", "position": 2},
    {"id": "school-snack", "name": "School snack", "time": "16:00", "position": 3},
]

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS meal_library (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS meal_slots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  time TEXT NOT NULL,
  position INTEGER NOT NULL,
  time_aliases TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS idempotent_actions (
  request_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  remote_id TEXT,
  response_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  task_key TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt REAL NOT NULL DEFAULT 0,
  last_error TEXT,
  create_attempted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS project_task_cache (
  task_key TEXT PRIMARY KEY,
  remote_id TEXT UNIQUE,
  project_id TEXT NOT NULL,
  task_json TEXT NOT NULL,
  seen_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS task_tombstones (
  remote_id TEXT PRIMARY KEY,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


class Database:
    def __init__(self, path: Path | str):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            columns = {row[1] for row in conn.execute("PRAGMA table_info(idempotent_actions)")}
            for name, declaration in (
                ("task_key", "TEXT"),
                ("attempts", "INTEGER NOT NULL DEFAULT 0"),
                ("next_attempt", "REAL NOT NULL DEFAULT 0"),
                ("last_error", "TEXT"),
                ("create_attempted", "INTEGER NOT NULL DEFAULT 0"),
            ):
                if name not in columns:
                    conn.execute(f"ALTER TABLE idempotent_actions ADD COLUMN {name} {declaration}")
            conn.execute("UPDATE idempotent_actions SET state='pending',next_attempt=0 WHERE state='processing'")
            conn.execute(
                """UPDATE idempotent_actions SET state='failed',last_error='Queued before background-sync support; reload to reconcile the Todoist task.'
                   WHERE state='pending' AND kind IN ('create-meal','move-meal','delete-meal') AND task_key IS NULL"""
            )
            conn.execute("DELETE FROM idempotent_actions WHERE state IN ('done','failed') AND updated_at < datetime('now','-30 days')")
            count = conn.execute("SELECT COUNT(*) FROM meal_slots WHERE active=1").fetchone()[0]
            if not count:
                conn.executemany(
                    "INSERT INTO meal_slots(id,name,time,position) VALUES(:id,:name,:time,:position)",
                    DEFAULT_SLOTS,
                )
            conn.execute("INSERT OR IGNORE INTO kv(key,value) VALUES('theme_mode','system')")

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=15, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def slots(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT id,name,time,position,time_aliases FROM meal_slots WHERE active=1 ORDER BY position,id"
            ).fetchall()
        return [dict(row) | {"time_aliases": json.loads(row["time_aliases"])} for row in rows]

    def save_slots(self, slots: list[dict[str, Any]]) -> None:
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            ids = {str(slot["id"]) for slot in slots if slot.get("id")}
            if ids:
                marks = ",".join("?" for _ in ids)
                conn.execute(f"UPDATE meal_slots SET active=0 WHERE id NOT IN ({marks})", tuple(ids))
            else:
                conn.execute("UPDATE meal_slots SET active=0")
            for position, slot in enumerate(slots):
                old = conn.execute("SELECT * FROM meal_slots WHERE id=?", (slot["id"],)).fetchone()
                aliases = json.loads(old["time_aliases"]) if old else []
                if old and old["time"] != slot["time"] and old["time"] not in aliases:
                    aliases.append(old["time"])
                conn.execute(
                    """INSERT INTO meal_slots(id,name,time,position,time_aliases,active)
                       VALUES(?,?,?,?,?,1)
                       ON CONFLICT(id) DO UPDATE SET name=excluded.name,time=excluded.time,
                         position=excluded.position,time_aliases=excluded.time_aliases,active=1""",
                    (slot["id"], slot["name"], slot["time"], position, json.dumps(aliases)),
                )
            conn.commit()

    def library(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute("SELECT id,name,position FROM meal_library ORDER BY position,name COLLATE NOCASE").fetchall()
        return [dict(row) for row in rows]

    def add_meal(self, name: str) -> tuple[dict[str, Any], bool]:
        normalized = " ".join(name.split())
        with self.connect() as conn:
            existing = conn.execute("SELECT id,name,position FROM meal_library WHERE name=? COLLATE NOCASE", (normalized,)).fetchone()
            if existing:
                return dict(existing), False
            position = conn.execute("SELECT COALESCE(MAX(position),-1)+1 FROM meal_library").fetchone()[0]
            item = {"id": str(uuid.uuid4()), "name": normalized, "position": position}
            conn.execute("INSERT INTO meal_library(id,name,position) VALUES(?,?,?)", (item["id"], normalized, position))
        return item, True

    def shuffle_library(self) -> list[dict[str, Any]]:
        items = self.library()
        random.SystemRandom().shuffle(items)
        with self.connect() as conn:
            conn.executemany("UPDATE meal_library SET position=? WHERE id=?", [(i, item["id"]) for i, item in enumerate(items)])
        return self.library()

    def get_meal(self, meal_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT id,name,position FROM meal_library WHERE id=?", (meal_id,)).fetchone()
        return dict(row) if row else None

    def get_theme_mode(self) -> str:
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM kv WHERE key='theme_mode'").fetchone()
        value = str(row["value"]) if row else "system"
        return value if value in {"system", "light", "dark"} else "system"

    def set_theme_mode(self, value: str) -> None:
        if value not in {"system", "light", "dark"}:
            raise ValueError("Theme mode must be system, light, or dark")
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO kv(key,value) VALUES('theme_mode',?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (value,),
            )

    def get_value(self, key: str) -> str | None:
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return str(row["value"]) if row else None

    def set_value(self, key: str, value: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )

    def delete_meal(self, meal_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT id,name,position FROM meal_library WHERE id=?", (meal_id,)).fetchone()
            if row is None:
                return None
            conn.execute("DELETE FROM meal_library WHERE id=?", (meal_id,))
            conn.commit()
        return dict(row)

    def start_action(self, request_id: str, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        packed = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM idempotent_actions WHERE request_id=?", (request_id,)).fetchone()
            if row:
                if row["kind"] != kind or row["payload"] != packed:
                    raise ValueError("Request ID was already used for a different action")
                result = dict(row)
            else:
                conn.execute("INSERT INTO idempotent_actions(request_id,kind,payload,state) VALUES(?,?,?,'pending')", (request_id, kind, packed))
                result = {"request_id": request_id, "kind": kind, "payload": packed, "state": "pending", "remote_id": None, "response_json": None}
            conn.commit()
        return result

    def enqueue_plan_action(self, request_id: str, kind: str, payload: dict[str, Any], task_key: str, cache_task: dict[str, Any] | None = None) -> dict[str, Any]:
        packed = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM idempotent_actions WHERE request_id=?", (request_id,)).fetchone()
            if row:
                if row["kind"] != kind or row["payload"] != packed:
                    raise ValueError("Request ID was already used for a different action")
                result = dict(row)
            else:
                conn.execute(
                    "INSERT INTO idempotent_actions(request_id,kind,payload,state,task_key) VALUES(?,?,?,'pending',?)",
                    (request_id, kind, packed, task_key),
                )
                result = {"request_id": request_id, "kind": kind, "payload": packed, "state": "pending", "remote_id": None, "task_key": task_key}
            if cache_task is not None:
                remote_id = cache_task.get("id")
                if str(remote_id or "").startswith("local:"):
                    remote_id = None
                key = task_key
                conn.execute(
                    """INSERT INTO project_task_cache(task_key,remote_id,project_id,task_json,seen_at)
                       VALUES(?,?,?,?,?) ON CONFLICT(task_key) DO UPDATE SET remote_id=COALESCE(excluded.remote_id,project_task_cache.remote_id),
                         project_id=excluded.project_id,task_json=excluded.task_json,seen_at=excluded.seen_at""",
                    (key, str(remote_id) if remote_id else None, str(cache_task["project_id"]), json.dumps(cache_task), time.time()),
                )
            conn.commit()
        return result

    def cache_project_tasks(self, project_id: str, tasks: list[dict[str, Any]]) -> None:
        now = time.time()
        present = {str(task.get("id", "")) for task in tasks if task.get("id") and str(task.get("project_id")) == str(project_id)}
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            for task in tasks:
                task_id = str(task.get("id", ""))
                if not task_id or str(task.get("project_id")) != str(project_id):
                    continue
                if conn.execute("SELECT 1 FROM task_tombstones WHERE remote_id=?", (task_id,)).fetchone():
                    continue
                old = conn.execute("SELECT task_key FROM project_task_cache WHERE remote_id=?", (task_id,)).fetchone()
                key = old["task_key"] if old else f"remote:{task_id}"
                conn.execute(
                    """INSERT INTO project_task_cache(task_key,remote_id,project_id,task_json,seen_at)
                       VALUES(?,?,?,?,?) ON CONFLICT(task_key) DO UPDATE SET remote_id=excluded.remote_id,
                         project_id=excluded.project_id,task_json=excluded.task_json,seen_at=excluded.seen_at""",
                    (key, task_id, str(project_id), json.dumps(task), now),
                )
            conn.execute("DELETE FROM project_task_cache WHERE seen_at<?", (now - 7 * 86400,))
            tombstones = conn.execute("SELECT remote_id,created_at FROM task_tombstones").fetchall()
            absent = [(row["remote_id"],) for row in tombstones if row["remote_id"] not in present and now - float(row["created_at"]) >= 1800]
            if absent:
                conn.executemany("DELETE FROM task_tombstones WHERE remote_id=?", absent)
            conn.commit()

    def get_project_task(self, task_key: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM project_task_cache WHERE task_key=? OR remote_id=?", (task_key, task_key)).fetchone()
        if not row:
            return None
        return dict(row) | {"task": json.loads(row["task_json"])}

    def project_key_for_remote(self, remote_id: str) -> str | None:
        with self.connect() as conn:
            row = conn.execute("SELECT task_key FROM project_task_cache WHERE remote_id=?", (remote_id,)).fetchone()
        return row["task_key"] if row else None

    def tombstoned_remote_ids(self) -> set[str]:
        with self.connect() as conn:
            rows = conn.execute("SELECT remote_id FROM task_tombstones").fetchall()
        return {str(row["remote_id"]) for row in rows}

    def claim_next_action(self, now: float | None = None) -> dict[str, Any] | None:
        now = time.time() if now is None else now
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """SELECT a.* FROM idempotent_actions a
                   WHERE a.state='pending' AND a.next_attempt<=?
                     AND NOT EXISTS (
                       SELECT 1 FROM idempotent_actions prior
                       WHERE prior.task_key=a.task_key AND prior.rowid<a.rowid AND prior.state!='done'
                     )
                   ORDER BY a.rowid LIMIT 1""",
                (now,),
            ).fetchone()
            if not row:
                conn.commit()
                return None
            conn.execute("UPDATE idempotent_actions SET state='processing',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE request_id=?", (row["request_id"],))
            claimed = conn.execute("SELECT * FROM idempotent_actions WHERE request_id=?", (row["request_id"],)).fetchone()
            conn.commit()
        return dict(claimed)

    def set_create_attempted(self, request_id: str) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE idempotent_actions SET create_attempted=1 WHERE request_id=?", (request_id,))

    def set_action_remote_id(self, request_id: str, remote_id: str) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE idempotent_actions SET remote_id=? WHERE request_id=?", (remote_id, request_id))

    def retry_action(self, request_id: str, error: str, delay: float, terminal: bool = False) -> None:
        state = "failed" if terminal else "pending"
        with self.connect() as conn:
            conn.execute(
                "UPDATE idempotent_actions SET state=?,last_error=?,next_attempt=?,updated_at=CURRENT_TIMESTAMP WHERE request_id=?",
                (state, error[:500], time.time() + max(0, delay), request_id),
            )

    def update_cached_task(self, task_key: str, task: dict[str, Any], remote_id: str | None = None) -> None:
        with self.connect() as conn:
            conn.execute(
                """UPDATE project_task_cache SET remote_id=COALESCE(?,remote_id),task_json=?,seen_at=? WHERE task_key=?""",
                (remote_id, json.dumps(task), time.time(), task_key),
            )

    def delete_cached_task(self, task_key: str, remote_id: str) -> None:
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM project_task_cache WHERE task_key=? OR remote_id=?", (task_key, remote_id))
            if remote_id:
                conn.execute("INSERT OR REPLACE INTO task_tombstones(remote_id,created_at) VALUES(?,?)", (remote_id, time.time()))
            conn.commit()

    def retry_saved_action(self, request_id: str) -> bool:
        with self.connect() as conn:
            cursor = conn.execute(
                "UPDATE idempotent_actions SET state='pending',attempts=0,next_attempt=0,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE request_id=? AND state='failed'",
                (request_id,),
            )
        return cursor.rowcount > 0

    def recent_plan_actions(self, project_id: str) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """SELECT * FROM idempotent_actions
                   WHERE kind IN ('create-meal','move-meal','delete-meal')
                     AND (state IN ('pending','processing','failed') OR (state='done' AND updated_at >= datetime('now','-5 minutes')))
                   ORDER BY rowid"""
            ).fetchall()
            task_keys = {row["task_key"] for row in rows if row["task_key"]}
            allowed = set()
            if task_keys:
                marks = ",".join("?" for _ in task_keys)
                allowed = {row["task_key"] for row in conn.execute(
                    f"SELECT task_key FROM project_task_cache WHERE project_id=? AND task_key IN ({marks})",
                    (str(project_id), *task_keys),
                ).fetchall()}
            result = []
            for row in rows:
                item = dict(row)
                payload = json.loads(item["payload"])
                if ((item["kind"] == "create-meal" and str(payload.get("project_id")) == str(project_id))
                    or item.get("task_key") in allowed
                    or (item["kind"] == "delete-meal" and str(payload.get("project_id")) == str(project_id))):
                    item["payload"] = payload
                    item["response_json"] = json.loads(item["response_json"]) if item["response_json"] else None
                    result.append(item)
        return result

    def get_action_status(self, request_id: str) -> dict[str, Any] | None:
        row = self.get_action(request_id)
        if not row:
            return None
        response = json.loads(row["response_json"]) if row.get("response_json") else None
        return {
            "request_id": row["request_id"], "kind": row["kind"], "state": row["state"],
            "remote_id": row.get("remote_id"), "task_key": row.get("task_key"),
            "error": row.get("last_error"), "response": response,
        }

    def finish_action(self, request_id: str, remote_id: str | None, response: dict[str, Any] | None = None) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE idempotent_actions SET state='done',remote_id=?,response_json=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE request_id=?",
                (remote_id, json.dumps(response) if response is not None else None, request_id),
            )

    def pending_actions(self, kind: str | None = None) -> list[dict[str, Any]]:
        with self.connect() as conn:
            if kind:
                rows = conn.execute(
                    "SELECT * FROM idempotent_actions WHERE state='pending' AND kind=? ORDER BY updated_at",
                    (kind,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM idempotent_actions WHERE state='pending' ORDER BY updated_at"
                ).fetchall()
        return [dict(row) for row in rows]

    def get_action(self, request_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM idempotent_actions WHERE request_id=?", (request_id,)).fetchone()
        return dict(row) if row else None
