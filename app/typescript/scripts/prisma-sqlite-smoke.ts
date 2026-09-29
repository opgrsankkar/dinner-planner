import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = await mkdtemp(join(tmpdir(), 'dinner-planner-prisma8-'))
const databasePath = join(tempDir, 'fresh-test.sqlite3')
const prisma = join(process.cwd(), 'node_modules', '.bin', 'prisma')
process.env.DATABASE_PATH = databasePath
let closeDatabase: () => Promise<void> = async () => {}

try {
  const migration = spawnSync(prisma, ['db', 'migrate', '--db', databasePath], {
    env: { ...process.env, DATABASE_PATH: databasePath },
    encoding: 'utf8',
  })
  if (migration.status !== 0) {
    throw new Error(`Prisma migration failed:\n${migration.stdout}\n${migration.stderr}`)
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
  await closeDatabase()
  await rm(tempDir, { recursive: true, force: true })
}
