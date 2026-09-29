#!/usr/bin/env -S node
import { parseExplicitDbPath } from './explicit-db-argument.ts'
import { verifyMealLibraryNameIndex } from './meal-library-name-index-invariant.ts'

try {
  const databasePath = parseExplicitDbPath(process.argv.slice(2), 'node scripts/verify-meal-library-name-index.ts')
  verifyMealLibraryNameIndex(databasePath)
  console.log(`Verified the physical ${'meal_library.name'} NOCASE unique index.`)
} catch (error) {
  console.error(`Meal-library invariant verification failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
