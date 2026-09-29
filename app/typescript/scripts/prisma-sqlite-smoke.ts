import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { createOperationalRepositories } from '../src/operational-repositories.ts'

const tempDir = await mkdtemp(join(tmpdir(), 'dinner-planner-prisma8-'))
const databasePath = join(tempDir, 'fresh-test.sqlite3')
const migrationWrapper = join(process.cwd(), 'scripts', 'prisma-migrate-with-invariant.ts')
let repositories: ReturnType<typeof createOperationalRepositories> | undefined

try {
  const relativeToTempRoot = relative(resolve(tempDir), resolve(databasePath))
  const relativeToOsTemp = relative(resolve(tmpdir()), resolve(databasePath))
  if (
    relativeToTempRoot.length === 0 ||
    relativeToTempRoot === '..' ||
    relativeToTempRoot.startsWith(`..${sep}`) ||
    relativeToOsTemp === '..' ||
    relativeToOsTemp.startsWith(`..${sep}`) ||
    resolve(databasePath) === '/data' ||
    resolve(databasePath).startsWith(`/data${sep}`)
  ) {
    throw new Error('SQLite smoke database path must remain under its fresh OS temporary directory')
  }

  const migration = spawnSync(process.execPath, [migrationWrapper, '--db', databasePath], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_PATH: databasePath },
    encoding: 'utf8',
  })
  if (migration.status !== 0) {
    throw new Error(`Supported Prisma migration failed:\n${migration.stdout}\n${migration.stderr}`)
  }

  const {
    settings,
  } = (repositories = createOperationalRepositories(databasePath))

  await settings.set('pilot-mode', 'created')
  await settings.set('pilot-mode', 'verified')
  const value = await settings.get('pilot-mode')
  if (value !== 'verified') {
    throw new Error(`Expected a read-after-write value of "verified", received ${String(value)}`)
  }
  if ((await settings.getThemeMode()) !== 'system') {
    throw new Error('Expected a fresh settings repository to default theme_mode to "system"')
  }
  console.log('Prisma ORM 8 SQLite migration and explicit-path operational repository smoke passed on a fresh temporary database.')
} finally {
  try {
    await repositories?.close()
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}
