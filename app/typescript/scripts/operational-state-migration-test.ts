import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateLegacyOperationalData, legacyOperationalTables } from '../src/legacy-operational-migration.ts'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repositoryRoot = resolve(projectRoot, '..', '..')
const legacySchemaPath = resolve(projectRoot, '..', 'db.py')
const tempRoot = await mkdtemp(join(tmpdir(), 'dinner-planner-operational-state-proof-'))
const legacySource = join(tempRoot, 'legacy-source', 'legacy.sqlite3')
const migrationCopy = join(tempRoot, 'migration-input', 'legacy-copy.sqlite3')
const nullKeyCopy = join(tempRoot, 'invalid-legacy-input', 'null-key.sqlite3')
const targetDatabase = join(tempRoot, 'prisma-target', 'operational-state.sqlite3')
const migrationWrapper = join(projectRoot, 'scripts', 'prisma-migrate-with-invariant.ts')

function assertTemporaryDatabasePath(databasePath: string): void {
  const absolutePath = resolve(databasePath)
  const pathFromRoot = relative(resolve(tempRoot), absolutePath)
  const pathFromOsTemp = relative(resolve(tmpdir()), absolutePath)
  assert.ok(pathFromRoot.length > 0 && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
  assert.ok(pathFromOsTemp !== '..' && !pathFromOsTemp.startsWith(`..${sep}`))
  assert.equal(absolutePath === '/data' || absolutePath.startsWith(`/data${sep}`), false)
}

interface FixtureManifest {
  readonly tables: Record<string, readonly (string | number | null)[][]>
}

const fixtureBuilder = String.raw`
import ast
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

schema_path, legacy_path, copy_path, bad_copy_path, temp_root_path = map(Path, sys.argv[1:])
temp_root = Path(tempfile.gettempdir()).resolve()
for path in (legacy_path, copy_path, bad_copy_path):
    resolved = path.resolve()
    if not resolved.is_relative_to(temp_root) or not resolved.is_relative_to(temp_root_path.resolve()):
        raise RuntimeError("fixture database path escaped its fresh temporary root")

module = ast.parse(schema_path.read_text(encoding="utf-8"), filename=str(schema_path))
schema = None
for node in module.body:
    if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "SCHEMA" for target in node.targets):
        schema = ast.literal_eval(node.value)
        break
if not isinstance(schema, str) or "CREATE TABLE IF NOT EXISTS task_tombstones" not in schema:
    raise RuntimeError("could not extract the exact legacy SCHEMA literal from app/db.py")

legacy_path.parent.mkdir(parents=True, exist_ok=True)
copy_path.parent.mkdir(parents=True, exist_ok=True)
bad_copy_path.parent.mkdir(parents=True, exist_ok=True)
database = sqlite3.connect(legacy_path)
database.executescript(schema)

fixtures = {
    "meal_library": [
        ("meal-id-0001", "Pasta", 0, "2026-09-20 08:00:00"),
        ("meal-id-0002", "Saag Paneer", 4, "2026-09-21 09:30:15"),
    ],
    "meal_slots": [
        ("breakfast", "Breakfast", "08:30", 0, '["07:30","08:00"]', 1),
        ("custom-slot-v2", "Late snack", "21:15", 2, "[]", 1),
        ("retired-slot", "Old snack", "17:00", 3, '["17:30"]', 0),
    ],
    "idempotent_actions": [
        ("req-pending-001", "create-meal", '{"name":"Pasta","project_id":"project-42"}', "pending", None, None, "2026-09-29 08:00:00", "remote:task-900", 3, 1800000000.125, "temporary timeout", 1),
        ("req-processing-002", "move-meal", '{"slot_id":"dinner","task_id":"task-901"}', "processing", "task-901", '{"accepted":true,"version":4}', "2026-09-29 08:01:00", "remote:task-901", 5, 1800000100.5, None, 0),
        ("req-failed-003", "delete-meal", '{"project_id":"project-42","task_id":"task-902"}', "failed", "task-902", None, "2026-09-29 08:02:00", None, 7, 1800000200.0, "Todoist rejected request after retries", 1),
        ("req-done-004", "create-meal", '{"name":"Rice","project_id":"project-42"}', "done", "task-903", '{"id":"task-903","synced":true}', "2026-09-29 08:03:00", "remote:task-903", 1, 0.0, None, 1),
        ("req-pending-legacy-no-key", "create-meal", '{"name":"Unreconciled","project_id":"project-42"}', "pending", None, None, "2026-09-29 08:04:00", None, 0, 0.0, None, 0),
    ],
    "project_task_cache": [
        ("remote:task-901", "task-901", "project-42", '{"id":"task-901","project_id":"project-42","content":"Cached dinner","labels":["meal"]}', 1790000000.125),
        ("local:req-pending-001", None, "project-42", '{"id":"local:req-pending-001","project_id":"project-42","content":"Pending dinner","is_local":true}', 1790000001.5),
    ],
    "task_tombstones": [("task-deleted-2026-17", 1790000100.75)],
    "kv": [
        ("theme_mode", "dark"),
        ("week_start", "1"),
        ("notification_prefs", '{"enabled":false,"channels":["browser"]}'),
    ],
}
columns = {
    "meal_library": ("id,name,position,created_at", "?,?,?,?"),
    "meal_slots": ("id,name,time,position,time_aliases,active", "?,?,?,?,?,?"),
    "idempotent_actions": ("request_id,kind,payload,state,remote_id,response_json,updated_at,task_key,attempts,next_attempt,last_error,create_attempted", "?,?,?,?,?,?,?,?,?,?,?,?"),
    "project_task_cache": ("task_key,remote_id,project_id,task_json,seen_at", "?,?,?,?,?"),
    "task_tombstones": ("remote_id,created_at", "?,?"),
    "kv": ("key,value", "?,?"),
}
for table, rows in fixtures.items():
    names, placeholders = columns[table]
    database.executemany(f"INSERT INTO {table} ({names}) VALUES ({placeholders})", rows)
database.commit()

copy = sqlite3.connect(copy_path)
database.backup(copy)
copy.close()
bad_copy = sqlite3.connect(bad_copy_path)
database.backup(bad_copy)
bad_copy.execute("INSERT INTO meal_library(id,name,position) VALUES(NULL,?,?)", ("NULL-key sentinel", 99))
bad_copy.commit()

database.row_factory = sqlite3.Row
manifest = {}
for table, (names, _) in columns.items():
    manifest[table] = [list(row) for row in database.execute(f"SELECT {names} FROM {table} ORDER BY rowid")]
print(json.dumps({"tables": manifest}, separators=(",", ":")))
bad_copy.close()
database.close()
`

function buildLegacyFixture(): FixtureManifest {
  const result = spawnSync(
    'python3',
    ['-c', fixtureBuilder, legacySchemaPath, legacySource, migrationCopy, nullKeyCopy, tempRoot],
    { cwd: repositoryRoot, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`Legacy fixture creation failed:\n${result.stdout}\n${result.stderr}`)
  }
  return JSON.parse(result.stdout) as FixtureManifest
}

function counts(database: DatabaseSync): Record<string, number> {
  return Object.fromEntries(
    legacyOperationalTables.map((table) => {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table.name}"`).get() as { count: number }
      return [table.name, row.count]
    }),
  )
}

function expectConstraint(database: DatabaseSync, label: string, attempt: () => void): void {
  database.exec('SAVEPOINT expected_constraint')
  try {
    assert.throws(attempt, /constraint failed/i, label)
  } finally {
    database.exec('ROLLBACK TO expected_constraint')
    database.exec('RELEASE expected_constraint')
  }
}

let target: DatabaseSync | undefined
try {
  for (const databasePath of [legacySource, migrationCopy, nullKeyCopy, targetDatabase]) {
    assertTemporaryDatabasePath(databasePath)
  }
  const manifest = buildLegacyFixture()
  await mkdir(join(targetDatabase, '..'), { recursive: true })

  const prismaMigration = spawnSync(process.execPath, [migrationWrapper, '--db', targetDatabase], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_PATH: targetDatabase },
    encoding: 'utf8',
  })
  if (prismaMigration.status !== 0) {
    throw new Error(`Supported Prisma schema migration failed:\n${prismaMigration.stdout}\n${prismaMigration.stderr}`)
  }

  target = new DatabaseSync(targetDatabase)
  const expectedCounts = Object.fromEntries(
    Object.entries(manifest.tables).map(([table, rows]) => [table, rows.length]),
  )

  target.exec(`
    CREATE TRIGGER reject_tombstones_for_rollback_test
    BEFORE INSERT ON task_tombstones
    BEGIN
      SELECT RAISE(ABORT, 'forced migration rollback test failure');
    END;
  `)
  assert.throws(
    () => migrateLegacyOperationalData(nullKeyCopy, targetDatabase),
    /NULL primary key value.*Prisma @id requires non-NULL values/,
    'legacy TEXT PRIMARY KEY permits NULL, so the importer must reject it before applying the stricter Prisma @id schema',
  )
  assert.deepEqual(counts(target), Object.fromEntries(legacyOperationalTables.map((table) => [table.name, 0])))

  assert.throws(
    () => migrateLegacyOperationalData(migrationCopy, targetDatabase),
    /forced migration rollback test failure/,
    'a mid-copy SQLite failure must roll back rows written from earlier tables',
  )
  assert.deepEqual(counts(target), Object.fromEntries(legacyOperationalTables.map((table) => [table.name, 0])))

  target.exec('DROP TRIGGER reject_tombstones_for_rollback_test')
  migrateLegacyOperationalData(migrationCopy, targetDatabase)
  assert.deepEqual(counts(target), expectedCounts, 'all six app-owned tables must retain their row counts')

  for (const table of legacyOperationalTables) {
    const columnList = table.columns.map((column) => `"${column.name}"`).join(', ')
    const actual: (string | number | null)[][] = target
      .prepare(`SELECT ${columnList} FROM "${table.name}" ORDER BY rowid`)
      .all()
      .map((row) => table.columns.map((column) => (row as Record<string, string | number | null>)[column.name]))
    assert.deepEqual(actual, manifest.tables[table.name], `${table.name} values, JSON text, IDs, and row order must survive exactly`)
  }

  assert.deepEqual(
    target
      .prepare('SELECT state, attempts, next_attempt, last_error, create_attempted FROM idempotent_actions ORDER BY rowid')
      .all()
      .map((row) => ({ ...(row as Record<string, unknown>) })),
    [
      { state: 'pending', attempts: 3, next_attempt: 1800000000.125, last_error: 'temporary timeout', create_attempted: 1 },
      { state: 'processing', attempts: 5, next_attempt: 1800000100.5, last_error: null, create_attempted: 0 },
      { state: 'failed', attempts: 7, next_attempt: 1800000200, last_error: 'Todoist rejected request after retries', create_attempted: 1 },
      { state: 'done', attempts: 1, next_attempt: 0, last_error: null, create_attempted: 1 },
      { state: 'pending', attempts: 0, next_attempt: 0, last_error: null, create_attempted: 0 },
    ],
    'pending, processing, failed, and done retry/outbox fields must not be normalized or discarded during import',
  )

  const tableNames = new Set(
    (target.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((row) => row.name),
  )
  assert.equal(tableNames.has('planned_meals'), false, 'Todoist planned meals must not become local authoritative records')
  assert.equal(tableNames.has('project_task_cache'), true, 'Todoist rows may exist only in the operational cache')
  assert.equal(tableNames.has('operational_settings'), false, 'the phase-one smoke table is replaced by the legacy kv contract')

  const noCaseIndex = target
    .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='meal_library_name_nocase'`)
    .get() as { sql: string }
  assert.match(noCaseIndex.sql, /CREATE UNIQUE INDEX/i)
  assert.match(noCaseIndex.sql, /COLLATE\s+NOCASE/i)

  expectConstraint(target, 'meal library primary key', () => target!.exec('INSERT INTO meal_library SELECT * FROM meal_library LIMIT 1'))
  expectConstraint(target, 'meal library case-insensitive name uniqueness', () => {
    target!.prepare('INSERT INTO meal_library(id,name,position) VALUES(?,?,?)').run('duplicate-meal-id', 'pAsTa', 99)
  })
  expectConstraint(target, 'meal slot primary key', () => target!.exec('INSERT INTO meal_slots SELECT * FROM meal_slots LIMIT 1'))
  expectConstraint(target, 'idempotent action primary key', () => target!.exec('INSERT INTO idempotent_actions SELECT * FROM idempotent_actions LIMIT 1'))
  expectConstraint(target, 'task cache primary key', () => target!.exec('INSERT INTO project_task_cache SELECT * FROM project_task_cache LIMIT 1'))
  expectConstraint(target, 'task cache remote ID uniqueness', () => {
    target!.prepare('INSERT INTO project_task_cache(task_key,remote_id,project_id,task_json,seen_at) VALUES(?,?,?,?,?)')
      .run('duplicate-remote-key', 'task-901', 'project-42', '{}', 1)
  })
  expectConstraint(target, 'tombstone primary key', () => target!.exec('INSERT INTO task_tombstones SELECT * FROM task_tombstones LIMIT 1'))
  expectConstraint(target, 'kv primary key', () => target!.exec('INSERT INTO kv SELECT * FROM kv LIMIT 1'))
  expectConstraint(target, 'Prisma primary keys reject NULL values', () => target!.exec("INSERT INTO kv(key,value) VALUES(NULL,'invalid')"))

  target.exec('SAVEPOINT nullable_remote_id_test')
  target
    .prepare('INSERT INTO project_task_cache(task_key,remote_id,project_id,task_json,seen_at) VALUES(?,?,?,?,?)')
    .run('local:second-pending', null, 'project-42', '{"id":"local:second-pending"}', 1790000002)
  target.exec('ROLLBACK TO nullable_remote_id_test')
  target.exec('RELEASE nullable_remote_id_test')

  const slotDefaults = target.prepare('PRAGMA table_info("meal_slots")').all() as { name: string; dflt_value: string | null }[]
  const slotDefaultsByName = new Map(slotDefaults.map((row) => [row.name, row.dflt_value]))
  assert.equal(slotDefaultsByName.get('time_aliases'), "'[]'")
  assert.equal(slotDefaultsByName.get('active'), '1')

  assert.throws(
    () => migrateLegacyOperationalData(migrationCopy, targetDatabase),
    /Target operational tables must be empty before import/,
    'a rerun must refuse a populated target instead of duplicating or overwriting rows',
  )
  assert.deepEqual(counts(target), expectedCounts, 'failed reruns must leave the successful import unchanged')

  const sourceBefore = new DatabaseSync(migrationCopy, { readOnly: true })
  try {
    assert.deepEqual(counts(sourceBefore), expectedCounts, 'the migration input copy must remain unchanged')
  } finally {
    sourceBefore.close()
  }

  console.log('Prisma 8 operational schema migration, legacy copy import, constraints, retry state, and rollback checks passed.')
} finally {
  try {
    target?.close()
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}
