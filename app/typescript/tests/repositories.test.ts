import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { createOperationalRepositories, type OperationalRepositories } from '../src/operational-repositories.ts'

const projectRoot = resolve(import.meta.dirname, '..')
const migrationWrapper = join(projectRoot, 'scripts', 'prisma-migrate-with-invariant.ts')

interface TemporaryDatabase {
  readonly root: string
  readonly databasePath: string
}

function assertTemporaryDatabasePath(databasePath: string, tempRoot: string): void {
  const absolutePath = resolve(databasePath)
  const fromFixture = relative(resolve(tempRoot), absolutePath)
  const fromOsTemp = relative(resolve(tmpdir()), absolutePath)
  assert.equal(isAbsolute(absolutePath), true)
  assert.ok(fromFixture.length > 0 && fromFixture !== '..' && !fromFixture.startsWith(`..${sep}`))
  assert.ok(fromOsTemp.length > 0 && fromOsTemp !== '..' && !fromOsTemp.startsWith(`..${sep}`))
  assert.equal(absolutePath === '/data' || absolutePath.startsWith(`/data${sep}`), false)
}

async function createTemporaryDatabase(): Promise<TemporaryDatabase> {
  const root = await mkdtemp(join(tmpdir(), 'dinner-planner-repositories-'))
  const databasePath = join(root, 'operational.sqlite3')
  assertTemporaryDatabasePath(databasePath, root)

  // Keep the wrapper's ambient fallback deliberately pointed at a separate temp file.
  const ignoredFallback = join(root, 'must-not-be-created.sqlite3')
  assertTemporaryDatabasePath(ignoredFallback, root)
  const migration = spawnSync(process.execPath, [migrationWrapper, '--db', databasePath], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_PATH: ignoredFallback },
    encoding: 'utf8',
  })
  assert.equal(
    migration.status,
    0,
    `the supported Prisma migration wrapper must create the temporary test database:\n${migration.stdout}\n${migration.stderr}`,
  )
  assert.equal((await stat(databasePath)).isFile(), true)
  await assert.rejects(stat(ignoredFallback), { code: 'ENOENT' })
  return { root, databasePath }
}

function withNativeDatabase<T>(databasePath: string, operation: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(databasePath)
  try {
    return operation(database)
  } finally {
    database.close()
  }
}

async function withRepositories(
  operation: (fixture: TemporaryDatabase, repositories: OperationalRepositories) => Promise<void>,
  options: Parameters<typeof createOperationalRepositories>[1] = {},
): Promise<void> {
  const fixture = await createTemporaryDatabase()
  let repositories: OperationalRepositories | undefined
  try {
    repositories = createOperationalRepositories(fixture.databasePath, options)
    await operation(fixture, repositories)
  } finally {
    await repositories?.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
}

test('requires an explicit existing absolute database path and closes cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dinner-planner-repository-path-'))
  const absentDatabase = join(root, 'must-remain-absent.sqlite3')
  assertTemporaryDatabasePath(absentDatabase, root)
  try {
    assert.throws(
      () => createOperationalRepositories(undefined as unknown as string),
      /explicit absolute SQLite database path/,
    )
    assert.throws(() => createOperationalRepositories('relative.sqlite3'), /explicit absolute SQLite database path/)
    assert.throws(() => createOperationalRepositories(absentDatabase), /must already exist/)
    await assert.rejects(stat(absentDatabase), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  await withRepositories(async (_fixture, repositories) => {
    const inFlightWrite = repositories.settings.set('close-race', 'finished-before-close')
    const firstClose = repositories.close()
    const secondClose = repositories.close()
    assert.equal(firstClose, secondClose, 'close should share one completion promise')
    await Promise.all([inFlightWrite, firstClose])
    await assert.rejects(repositories.settings.get('close-race'), /closing or closed/)
  })
})

test('settings preserve generic key/value behavior and theme defaults and validation', async () => {
  await withRepositories(async (_fixture, repositories) => {
    assert.equal(await repositories.settings.get('missing-key'), null)
    assert.equal(await repositories.settings.getThemeMode(), 'system')

    await repositories.settings.set('week_start', 'monday')
    assert.equal(await repositories.settings.get('week_start'), 'monday')
    await repositories.settings.set('week_start', 'sunday')
    assert.equal(await repositories.settings.get('week_start'), 'sunday')

    await repositories.settings.setThemeMode('dark')
    assert.equal(await repositories.settings.getThemeMode(), 'dark')
    await assert.rejects(
      repositories.settings.setThemeMode('sepia' as 'system'),
      /Theme mode must be system, light, or dark/,
    )

    await repositories.settings.set('theme_mode', 'sepia')
    assert.equal(await repositories.settings.getThemeMode(), 'system', 'unknown stored theme values fail back to system')
  })
})

test('meal library normalizes, deduplicates with SQLite ASCII NOCASE, orders, appends, and deletes independently', async () => {
  await withRepositories(async ({ databasePath }, repositories) => {
    const first = await repositories.mealLibrary.add('  White\n  Rice\tBowl  ')
    assert.equal(first.created, true)
    assert.equal(first.item.name, 'White Rice Bowl')
    assert.equal(first.item.position, 0)

    const duplicate = await repositories.mealLibrary.add('white rice bowl')
    assert.equal(duplicate.created, false)
    assert.deepEqual(duplicate.item, first.item)

    const unicodeUpper = await repositories.mealLibrary.add('Ångström Soup')
    const unicodeLower = await repositories.mealLibrary.add('ångström Soup')
    assert.equal(unicodeUpper.created, true)
    assert.equal(unicodeLower.created, true, 'SQLite NOCASE folds ASCII letters only')

    const zebra = await repositories.mealLibrary.add('zebra')
    const apple = await repositories.mealLibrary.add('apple')
    const apricot = await repositories.mealLibrary.add('Apricot')
    withNativeDatabase(databasePath, (database) => {
      const tiePosition = 20
      for (const item of [zebra.item, apple.item, apricot.item]) {
        database.prepare('UPDATE meal_library SET position = ? WHERE id = ?').run(tiePosition, item.id)
      }
      // A synthetic Todoist cache row stands in for task data. Reusable-library deletion must not touch it.
      database.prepare(
        'INSERT INTO project_task_cache(task_key,remote_id,project_id,task_json,seen_at) VALUES(?,?,?,?,?)',
      ).run('remote:synthetic-task', 'synthetic-task', 'synthetic-project', '{"id":"synthetic-task"}', 1)
    })

    const orderedTie = (await repositories.mealLibrary.list()).filter((item) => item.position === 20)
    assert.deepEqual(orderedTie.map((item) => item.name), ['apple', 'Apricot', 'zebra'])
    assert.deepEqual(await repositories.mealLibrary.get(apricot.item.id), { ...apricot.item, position: 20 })

    const deleted = await repositories.mealLibrary.delete(first.item.id)
    assert.deepEqual(deleted, first.item)
    assert.equal(await repositories.mealLibrary.get(first.item.id), null)
    const next = await repositories.mealLibrary.add('after a deleted position')
    assert.equal(next.item.position, 21, 'new entries append after the maximum saved position, without reusing gaps')

    const remainingTask = withNativeDatabase(databasePath, (database) => ({ ...(database.prepare(
      'SELECT task_key, remote_id, project_id, task_json, seen_at FROM project_task_cache WHERE task_key = ?',
    ).get('remote:synthetic-task') as Record<string, unknown>) }))
    assert.deepEqual(remainingTask, {
      task_key: 'remote:synthetic-task',
      remote_id: 'synthetic-task',
      project_id: 'synthetic-project',
      task_json: '{"id":"synthetic-task"}',
      seen_at: 1,
    })
  })
})

test('shuffle injects randomness and atomically persists contiguous positions in returned order', async () => {
  const randomValues = [0, 0, 0]
  await withRepositories(async ({ databasePath }, repositories) => {
    for (const name of ['A', 'B', 'C', 'D']) await repositories.mealLibrary.add(name)

    const shuffled = await repositories.mealLibrary.shuffle()
    assert.deepEqual(shuffled.map((item) => item.name), ['B', 'C', 'D', 'A'])
    assert.deepEqual(shuffled.map((item) => item.position), [0, 1, 2, 3])
    const persisted = await repositories.mealLibrary.list()
    assert.deepEqual(persisted, shuffled)
    assert.deepEqual(
      withNativeDatabase(databasePath, (database) => database.prepare(
        'SELECT position FROM meal_library ORDER BY position',
      ).all().map((row) => (row as { position: number }).position)),
      [0, 1, 2, 3],
    )
  }, {
    random: () => randomValues.shift() ?? 0,
  })
})

test('meal slots preserve active ordering, aliases, inactive rows, contiguous positions, rollback, and reopen persistence', async () => {
  await withRepositories(async ({ databasePath }, initialRepositories) => {
    withNativeDatabase(databasePath, (database) => {
      const insert = database.prepare(
        'INSERT INTO meal_slots(id,name,time,position,time_aliases,active) VALUES(?,?,?,?,?,?)',
      )
      insert.run('slot-a', 'Alpha', '08:30', 2, '["07:30","08:00"]', 1)
      insert.run('slot-b', 'Beta', '09:00', 2, '["09:00","08:45"]', 1)
      insert.run('removed', 'Removed', '15:00', 4, '["14:45"]', 1)
      insert.run('retired', 'Retired', '17:00', 8, '["17:00","16:30"]', 0)
    })

    assert.deepEqual((await initialRepositories.mealSlots.listActive()).map(({ id, position }) => [id, position]), [
      ['slot-a', 2],
      ['slot-b', 2],
      ['removed', 4],
    ])
    assert.equal((await initialRepositories.mealSlots.listActive()).some((slot) => slot.id === 'retired'), false)

    const firstSave = [
      { id: 'slot-b', name: 'Beta', time: '10:00' },
      { id: 'slot-a', name: 'Alpha', time: '09:30' },
      { id: 'new-slot', name: 'New', time: '18:00' },
    ]
    await initialRepositories.mealSlots.saveAll(firstSave)
    let active = await initialRepositories.mealSlots.listActive()
    assert.deepEqual(active.map((slot) => [slot.id, slot.position]), [
      ['slot-b', 0],
      ['slot-a', 1],
      ['new-slot', 2],
    ])
    assert.deepEqual(active[0]?.time_aliases, ['09:00', '08:45'], 'do not duplicate an existing previous-time alias')
    assert.deepEqual(active[1]?.time_aliases, ['07:30', '08:00', '08:30'], 'append the previous time after prior aliases')

    await initialRepositories.mealSlots.saveAll(firstSave)
    active = await initialRepositories.mealSlots.listActive()
    assert.deepEqual(active[1]?.time_aliases, ['07:30', '08:00', '08:30'], 're-saving the same time must not append an alias')

    const aliasOrderSave = [
      firstSave[0]!,
      { id: 'slot-a', name: 'Alpha', time: '10:00' },
      firstSave[2]!,
    ]
    await initialRepositories.mealSlots.saveAll(aliasOrderSave)
    await initialRepositories.mealSlots.saveAll(aliasOrderSave)
    active = await initialRepositories.mealSlots.listActive()
    assert.deepEqual(active[1]?.time_aliases, ['07:30', '08:00', '08:30', '09:30'])
    assert.deepEqual(active.map((slot) => slot.position), [0, 1, 2])

    const beforeRollback = withNativeDatabase(databasePath, (database) => database.prepare(
      'SELECT id,name,time,position,time_aliases,active FROM meal_slots ORDER BY id',
    ).all())
    withNativeDatabase(databasePath, (database) => database.exec(`
      CREATE TRIGGER reject_mid_slot_save
      BEFORE INSERT ON meal_slots
      WHEN NEW.id = 'forced-failure'
      BEGIN
        SELECT RAISE(ABORT, 'forced mid-save failure');
      END;
    `))

    await assert.rejects(
      initialRepositories.mealSlots.saveAll([
        { id: 'slot-a', name: 'Changed before failure', time: '11:00' },
        { id: 'forced-failure', name: 'Rejected', time: '12:00' },
      ]),
      /forced mid-save failure/,
    )
    const afterRollback = withNativeDatabase(databasePath, (database) => database.prepare(
      'SELECT id,name,time,position,time_aliases,active FROM meal_slots ORDER BY id',
    ).all())
    assert.deepEqual(afterRollback, beforeRollback, 'a later slot write failure must roll back deactivation and earlier upserts')
    withNativeDatabase(databasePath, (database) => database.exec('DROP TRIGGER reject_mid_slot_save'))

    await initialRepositories.settings.setThemeMode('light')
    await initialRepositories.settings.set('persisted', 'yes')
    await initialRepositories.mealLibrary.add('Persisted meal')
    await initialRepositories.close()

    const reopened = createOperationalRepositories(databasePath)
    try {
      assert.equal(await reopened.settings.getThemeMode(), 'light')
      assert.equal(await reopened.settings.get('persisted'), 'yes')
      assert.deepEqual((await reopened.mealLibrary.list()).map((item) => item.name), ['Persisted meal'])
      assert.deepEqual((await reopened.mealSlots.listActive()).map((slot) => [slot.id, slot.position]), [
        ['slot-b', 0],
        ['slot-a', 1],
        ['new-slot', 2],
      ])
    } finally {
      await reopened.close()
    }

    const finalRows = withNativeDatabase(databasePath, (database) => database.prepare(
      'SELECT id,position,time_aliases,active FROM meal_slots ORDER BY id',
    ).all().map((row) => ({ ...(row as Record<string, unknown>) }))) as {
      id: string
      position: number
      time_aliases: string
      active: number
    }[]
    const removed = finalRows.find((row) => row.id === 'removed')
    const retired = finalRows.find((row) => row.id === 'retired')
    assert.deepEqual(removed, { id: 'removed', position: 4, time_aliases: '["14:45"]', active: 0 })
    assert.deepEqual(retired, { id: 'retired', position: 8, time_aliases: '["17:00","16:30"]', active: 0 })
  })
})

test('hostile input stays parameterized and malformed slot aliases fail closed', async () => {
  await withRepositories(async ({ databasePath }, repositories) => {
    const key = "x'); DROP TABLE meal_slots;--"
    const value = "' ; DROP TABLE kv; --"
    await repositories.settings.set(key, value)
    assert.equal(await repositories.settings.get(key), value)

    const name = "x'); DROP TABLE meal_slots;--"
    const added = await repositories.mealLibrary.add(name)
    assert.equal(added.item.name, name)
    await repositories.mealSlots.saveAll([
      { id: "slot'; DROP TABLE kv;--", name: "name'); DELETE FROM kv;--", time: "00:00'); --" },
    ])
    assert.equal((await repositories.mealSlots.listActive())[0]?.id, "slot'; DROP TABLE kv;--")

    withNativeDatabase(databasePath, (database) => {
      database.prepare('UPDATE meal_slots SET time_aliases = ? WHERE id = ?').run('not-json', "slot'; DROP TABLE kv;--")
      assert.equal(
        (database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('kv','meal_slots','meal_library')")
          .get() as { count: number }).count,
        3,
      )
    })
    await assert.rejects(repositories.mealSlots.listActive(), /malformed time_aliases JSON/)
  })
})
