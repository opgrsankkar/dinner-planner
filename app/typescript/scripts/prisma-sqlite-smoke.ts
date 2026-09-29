import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

const tempDir = await mkdtemp(join(tmpdir(), 'dinner-planner-prisma8-'))
const databasePath = join(tempDir, 'fresh-test.sqlite3')
const migrationWrapper = join(process.cwd(), 'scripts', 'prisma-migrate-with-invariant.ts')
process.env.DATABASE_PATH = databasePath
let closeDatabase: () => Promise<void> = async () => {}

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
    disconnectOperationalSettings,
    readOperationalSetting,
    writeOperationalSetting,
  } = await import('../src/operational-settings.ts')
  closeDatabase = disconnectOperationalSettings

  await writeOperationalSetting('pilot-mode', 'created')
  await writeOperationalSetting('pilot-mode', 'verified')
  const value = await readOperationalSetting('pilot-mode')
  if (value !== 'verified') {
    throw new Error(`Expected a read-after-write value of "verified", received ${String(value)}`)
  }
  console.log('Prisma ORM 8 SQLite migration and operational-setting read/write passed on a fresh temporary database.')
} finally {
  try {
    await closeDatabase()
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}
