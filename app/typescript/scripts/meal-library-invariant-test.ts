import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const tempRoot = await mkdtemp(join(tmpdir(), 'dinner-planner-meal-invariant-'))
const migratedDatabase = join(tempRoot, 'migrated.sqlite3')
const fallbackDatabase = join(tempRoot, 'fallback.sqlite3')
const missingDatabase = join(tempRoot, 'must-not-be-created.sqlite3')
const malformedDatabase = join(tempRoot, 'malformed.sqlite3')
const verifierScript = join(projectRoot, 'scripts', 'verify-meal-library-name-index.ts')
const migrationWrapper = join(projectRoot, 'scripts', 'prisma-migrate-with-invariant.ts')
const prismaBin = join(projectRoot, 'node_modules', '.bin', 'prisma')

function assertTempDatabasePath(databasePath: string): void {
  const absolutePath = resolve(databasePath)
  const pathFromRoot = relative(resolve(tempRoot), absolutePath)
  const pathFromOsTemp = relative(resolve(tmpdir()), absolutePath)
  assert.ok(pathFromRoot.length > 0 && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
  assert.ok(pathFromOsTemp !== '..' && !pathFromOsTemp.startsWith(`..${sep}`))
  assert.equal(isAbsolute(absolutePath), true)
  assert.equal(absolutePath === '/data' || absolutePath.startsWith(`/data${sep}`), false)
}

function assertAllDatabasePathsAreTemporary(): void {
  for (const databasePath of [migratedDatabase, fallbackDatabase, missingDatabase, malformedDatabase]) {
    assertTempDatabasePath(databasePath)
  }
}

function runNodeScript(scriptPath: string, args: readonly string[], fallbackPath = fallbackDatabase) {
  assertAllDatabasePathsAreTemporary()
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_PATH: fallbackPath },
    encoding: 'utf8',
  })
}

function runVerifier(databasePath: string) {
  assertTempDatabasePath(databasePath)
  return runNodeScript(verifierScript, ['--db', databasePath])
}

function assertVerifierFails(databasePath: string, message: string): void {
  const result = runVerifier(databasePath)
  assert.notEqual(result.status, 0, message)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

let database: DatabaseSync | undefined
let fallback: DatabaseSync | undefined
try {
  assertAllDatabasePathsAreTemporary()
  fallback = new DatabaseSync(fallbackDatabase)
  fallback.close()
  fallback = undefined
  await writeFile(malformedDatabase, 'not a SQLite database')

  const missingVerifierDbArg = runNodeScript(verifierScript, [])
  assert.notEqual(missingVerifierDbArg.status, 0, 'the custom verifier must reject a missing --db argument')
  assert.match(`${missingVerifierDbArg.stdout}${missingVerifierDbArg.stderr}`, /--db <path>/)

  const missingWrapperDbArg = runNodeScript(migrationWrapper, [])
  assert.notEqual(missingWrapperDbArg.status, 0, 'the migration wrapper must reject a missing --db argument')
  assert.match(`${missingWrapperDbArg.stdout}${missingWrapperDbArg.stderr}`, /--db <path>/)
  const untouchedFallback = new DatabaseSync(fallbackDatabase, { readOnly: true })
  try {
    assert.equal(
      (untouchedFallback.prepare('SELECT COUNT(*) AS count FROM sqlite_schema').get() as { count: number }).count,
      0,
      'DATABASE_PATH must not act as a verifier or migration-wrapper fallback',
    )
  } finally {
    untouchedFallback.close()
  }

  const missingDatabaseResult = runVerifier(missingDatabase)
  assert.notEqual(missingDatabaseResult.status, 0, 'the verifier must reject a database file that does not exist')
  assert.equal(await exists(missingDatabase), false, 'read-only verification must not create a missing database')
  assertVerifierFails(fallbackDatabase, 'an existing database with no meal_library table must fail closed')
  assertVerifierFails(malformedDatabase, 'an unreadable or malformed SQLite file must fail closed')
  const failedMigration = runNodeScript(migrationWrapper, ['--db', malformedDatabase])
  assert.notEqual(failedMigration.status, 0, 'the supported wrapper must fail when Prisma db migrate fails')

  const relativeMigratedDatabase = relative(projectRoot, migratedDatabase)
  assertTempDatabasePath(resolve(projectRoot, relativeMigratedDatabase))
  const migration = runNodeScript(migrationWrapper, ['--db', relativeMigratedDatabase])
  assert.equal(migration.status, 0, `the supported wrapper must migrate and verify a fresh database:\n${migration.stdout}\n${migration.stderr}`)
  assert.equal(runVerifier(migratedDatabase).status, 0, 'a correctly migrated database must pass the custom verifier')

  database = new DatabaseSync(migratedDatabase)
  database.exec('DROP INDEX "meal_library_name_nocase"')
  assertVerifierFails(migratedDatabase, 'dropping the NOCASE index must fail custom verification')

  const wrapperWithoutIndex = runNodeScript(migrationWrapper, ['--db', migratedDatabase])
  assert.notEqual(wrapperWithoutIndex.status, 0, 'the supported wrapper must fail when its post-migration invariant check fails')

  const prismaVerifyWithoutIndex = spawnSync(prismaBin, ['db', 'verify', '--db', migratedDatabase], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_PATH: migratedDatabase },
    encoding: 'utf8',
  })
  assert.equal(
    prismaVerifyWithoutIndex.status,
    0,
    'Prisma db verify must demonstrate its current blind spot for the raw NOCASE index operation',
  )
  assert.match(prismaVerifyWithoutIndex.stdout, /Database marker and schema match contract/)

  database.exec('CREATE UNIQUE INDEX "meal_library_name_nocase" ON "meal_library" ("name" COLLATE BINARY)')
  assertVerifierFails(migratedDatabase, 'a same-name unique BINARY index must fail custom verification')

  database.exec('DROP INDEX "meal_library_name_nocase"')
  database.exec('CREATE UNIQUE INDEX "meal_library_name_nocase" ON "meal_library" ("name" COLLATE NOCASE) WHERE "position" >= 0')
  assertVerifierFails(migratedDatabase, 'a same-name partial NOCASE index must fail custom verification')

  database.exec('DROP INDEX "meal_library_name_nocase"')
  database.exec('CREATE UNIQUE INDEX "meal_library_name_nocase" ON "meal_library" ("name" COLLATE NOCASE, "position")')
  assertVerifierFails(migratedDatabase, 'a same-name composite NOCASE index must fail custom verification')

  database.exec('DROP INDEX "meal_library_name_nocase"')
  database.exec('CREATE UNIQUE INDEX "meal_library_name_nocase" ON "meal_library" ("name" COLLATE NOCASE)')
  assert.equal(runVerifier(migratedDatabase).status, 0, 'restoring the exact NOCASE unique index must pass')

  database.prepare('INSERT INTO meal_library(id, name, position) VALUES (?, ?, ?)').run('meal-one', 'Pasta', 0)
  assert.throws(
    () => database!.prepare('INSERT INTO meal_library(id, name, position) VALUES (?, ?, ?)').run('meal-two', 'pAsTa', 1),
    /constraint failed/i,
    'the NOCASE unique index must reject duplicate names that differ only by case',
  )

  console.log('Temporary SQLite meal-library invariant, fail-closed CLI, migration wrapper, and Prisma verifier-gap checks passed.')
} finally {
  try {
    database?.close()
    fallback?.close()
    assertAllDatabasePathsAreTemporary()
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}
