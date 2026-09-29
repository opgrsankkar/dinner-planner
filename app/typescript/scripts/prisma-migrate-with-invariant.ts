#!/usr/bin/env -S node
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parseExplicitDbPath } from './explicit-db-argument.ts'
import { verifyMealLibraryNameIndex } from './meal-library-name-index-invariant.ts'

const projectRoot = resolve(import.meta.dirname, '..')
const prismaBin = resolve(projectRoot, 'node_modules', '.bin', 'prisma')

try {
  const databasePath = resolve(parseExplicitDbPath(process.argv.slice(2), 'npm run prisma:migrate -- --db <path>'))
  const migration = spawnSync(prismaBin, ['db', 'migrate', '--db', databasePath], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_PATH: databasePath },
    encoding: 'utf8',
  })

  if (migration.stdout) process.stdout.write(migration.stdout)
  if (migration.stderr) process.stderr.write(migration.stderr)
  if (migration.error) throw new Error(`Prisma db migrate could not run: ${migration.error.message}`)
  if (migration.status !== 0) {
    throw new Error(`Prisma db migrate exited with status ${String(migration.status)}`)
  }

  verifyMealLibraryNameIndex(databasePath)
  console.log('Prisma migrations applied and the meal-library NOCASE uniqueness invariant verified.')
} catch (error) {
  console.error(`Supported Prisma migration failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
