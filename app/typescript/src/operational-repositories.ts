import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import sqlite from '@prisma/orm-sqlite/runtime'
import type { Contract } from '../prisma/contract.d'
import contractJson from '../prisma/contract.json' with { type: 'json' }

export type ThemeMode = 'system' | 'light' | 'dark'

export interface MealLibraryItem {
  readonly id: string
  readonly name: string
  readonly position: number
}

export interface MealSlotInput {
  readonly id: string
  readonly name: string
  readonly time: string
}

export interface MealSlot extends MealSlotInput {
  readonly position: number
  readonly time_aliases: string[]
}

export interface OperationalRepositories {
  readonly settings: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    getThemeMode(): Promise<ThemeMode>
    setThemeMode(value: ThemeMode): Promise<void>
  }
  readonly mealLibrary: {
    list(): Promise<MealLibraryItem[]>
    add(name: string): Promise<{ item: MealLibraryItem; created: boolean }>
    get(id: string): Promise<MealLibraryItem | null>
    delete(id: string): Promise<MealLibraryItem | null>
    shuffle(): Promise<MealLibraryItem[]>
  }
  readonly mealSlots: {
    listActive(): Promise<MealSlot[]>
    saveAll(slots: readonly MealSlotInput[]): Promise<void>
  }
  close(): Promise<void>
}

export interface OperationalRepositoryOptions {
  /** Random source used only by meal-library shuffle; defaults to Math.random. */
  readonly random?: () => number
}

const THEME_MODES = new Set<ThemeMode>(['system', 'light', 'dark'])

function requireExplicitExistingPath(databasePath: string): string {
  if (typeof databasePath !== 'string' || databasePath.length === 0 || !isAbsolute(databasePath)) {
    throw new Error('An explicit absolute SQLite database path is required')
  }

  const absolutePath = resolve(databasePath)
  let fileInfo
  try {
    fileInfo = statSync(absolutePath)
  } catch {
    throw new Error('The explicit SQLite database path must already exist')
  }
  if (!fileInfo.isFile()) {
    throw new Error('The explicit SQLite database path must be a regular file')
  }
  return absolutePath
}

function normalizeMealName(name: string): string {
  return name.trim().split(/\s+/u).filter(Boolean).join(' ')
}

function parseTimeAliases(slotId: string, value: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`Meal slot ${slotId} has malformed time_aliases JSON`)
  }

  if (!Array.isArray(parsed) || parsed.some((alias) => typeof alias !== 'string')) {
    throw new Error(`Meal slot ${slotId} has invalid time_aliases JSON`)
  }
  return parsed
}

function libraryRowsPlan(db: ReturnType<typeof sqlite<Contract>>) {
  return db.raw.sql`
    SELECT id, name, position
    FROM meal_library
    ORDER BY position ASC, name COLLATE NOCASE ASC
  `.returnsRow({
    id: { codecId: 'sqlite/text@1' },
    name: { codecId: 'sqlite/text@1' },
    position: { codecId: 'sqlite/integer@1' },
  }).build()
}

function mealByAsciiNoCaseNamePlan(db: ReturnType<typeof sqlite<Contract>>, name: string) {
  // Prisma's typed model filter does not express SQLite's legacy ASCII-only NOCASE collation.
  // Keep this collation-specific read in Prisma's raw lane; template interpolations are bound parameters.
  return db.raw.sql`
    SELECT id, name, position
    FROM meal_library
    WHERE name = ${name} COLLATE NOCASE
    LIMIT 1
  `.returnsRow({
    id: { codecId: 'sqlite/text@1' },
    name: { codecId: 'sqlite/text@1' },
    position: { codecId: 'sqlite/integer@1' },
  }).build()
}

function nextMealPositionPlan(db: ReturnType<typeof sqlite<Contract>>) {
  return db.raw.sql`
    SELECT COALESCE(MAX(position), -1) + 1 AS position
    FROM meal_library
  `.returnsRow({ position: { codecId: 'sqlite/integer@1' } }).build()
}

/**
 * Construct repositories bound to one existing, explicit SQLite file.
 * The caller owns the returned lifecycle and must call close() when finished.
 */
export function createOperationalRepositories(
  databasePath: string,
  options: OperationalRepositoryOptions = {},
): OperationalRepositories {
  const path = requireExplicitExistingPath(databasePath)
  const db = sqlite<Contract>({ contractJson, path })
  const random = options.random ?? Math.random
  let state: 'open' | 'closing' | 'closed' = 'open'
  let closePromise: Promise<void> | undefined
  const inFlight = new Set<Promise<unknown>>()

  function run<T>(operation: () => Promise<T>): Promise<T> {
    if (state !== 'open') {
      return Promise.reject(new Error('Operational repositories are closing or closed'))
    }

    const promise = Promise.resolve().then(operation)
    inFlight.add(promise)
    return promise.then(
      (value) => {
        inFlight.delete(promise)
        return value
      },
      (error: unknown) => {
        inFlight.delete(promise)
        throw error
      },
    )
  }

  async function listMealLibrary(): Promise<MealLibraryItem[]> {
    const rows = await db.runtime().query(libraryRowsPlan(db))
    return rows as unknown as MealLibraryItem[]
  }

  async function findMealByName(name: string): Promise<MealLibraryItem | null> {
    const rows = await db.runtime().query(mealByAsciiNoCaseNamePlan(db, name))
    return (rows as unknown as MealLibraryItem[])[0] ?? null
  }

  async function readSetting(key: string): Promise<string | null> {
    const row = await db.orm.Kv.first({ key })
    return row?.value ?? null
  }

  async function writeSetting(key: string, value: string): Promise<void> {
    await db.transaction(async (tx) => {
      const existing = await tx.orm.Kv.first({ key })
      if (existing) {
        await tx.orm.Kv.where({ key }).update({ value })
      } else {
        await tx.orm.Kv.create({ key, value })
      }
    })
  }

  return {
    settings: {
      get(key) {
        return run(() => readSetting(key))
      },
      set(key, value) {
        return run(() => writeSetting(key, value))
      },
      async getThemeMode() {
        const value = await run(() => readSetting('theme_mode'))
        return value !== null && THEME_MODES.has(value as ThemeMode) ? (value as ThemeMode) : 'system'
      },
      async setThemeMode(value) {
        if (!THEME_MODES.has(value)) {
          throw new ValueError('Theme mode must be system, light, or dark')
        }
        await run(() => writeSetting('theme_mode', value))
      },
    },
    mealLibrary: {
      list() {
        return run(listMealLibrary)
      },
      add(name) {
        return run(async () => {
          const normalized = normalizeMealName(name)
          try {
            return await db.transaction(async (tx) => {
              // This raw lookup preserves SQLite's ASCII-only NOCASE semantics and binds the name.
              const duplicateRows = await tx.query(mealByAsciiNoCaseNamePlan(db, normalized))
              const duplicate = (duplicateRows as unknown as MealLibraryItem[])[0]
              if (duplicate) return { item: duplicate, created: false }

              const nextPositionRows = await tx.query(nextMealPositionPlan(db))
              const position = Number((nextPositionRows[0] as { position: number }).position)
              const created = await tx.orm.MealLibraryEntry.create({
                id: randomUUID(),
                name: normalized,
                position,
              })
              return {
                item: { id: created.id, name: created.name, position: created.position },
                created: true,
              }
            })
          } catch (error) {
            // A concurrent insert may win the NOCASE unique-index race; return that row as legacy does.
            const duplicate = await findMealByName(normalized)
            if (duplicate) return { item: duplicate, created: false }
            throw error
          }
        })
      },
      get(id) {
        return run(async () => {
          const row = await db.orm.MealLibraryEntry.first({ id })
          return row ? { id: row.id, name: row.name, position: row.position } : null
        })
      },
      delete(id) {
        return run(async () => db.transaction(async (tx) => {
          const deleted = await tx.orm.MealLibraryEntry.where({ id }).delete()
          return deleted ? { id: deleted.id, name: deleted.name, position: deleted.position } : null
        }))
      },
      shuffle() {
        return run(async () => db.transaction(async (tx) => {
          const rows = await tx.query(libraryRowsPlan(db))
          const items = [...(rows as unknown as MealLibraryItem[])]
          for (let index = items.length - 1; index > 0; index -= 1) {
            const value = random()
            if (!Number.isFinite(value) || value < 0 || value >= 1) {
              throw new Error('Shuffle random source must return a number in [0, 1)')
            }
            const swapIndex = Math.floor(value * (index + 1))
            ;[items[index], items[swapIndex]] = [items[swapIndex]!, items[index]!]
          }

          for (const [position, item] of items.entries()) {
            await tx.orm.MealLibraryEntry.where({ id: item.id }).update({ position })
          }
          return items.map((item, position) => ({ ...item, position }))
        }))
      },
    },
    mealSlots: {
      listActive() {
        return run(async () => {
          const rows = await db.orm.MealSlot
            .where({ active: 1 })
            .orderBy([(slot) => slot.position.asc(), (slot) => slot.id.asc()])
            .all()
          return rows.map((row) => ({
            id: row.id,
            name: row.name,
            time: row.time,
            position: row.position,
            time_aliases: parseTimeAliases(row.id, row.timeAliases),
          }))
        })
      },
      saveAll(slots) {
        return run(async () => {
          const ids = new Set<string>()
          for (const slot of slots) {
            if (!slot || typeof slot.id !== 'string' || typeof slot.name !== 'string' || typeof slot.time !== 'string') {
              throw new Error('Each meal slot must include string id, name, and time values')
            }
            if (ids.has(slot.id)) throw new Error(`Duplicate meal slot id: ${slot.id}`)
            ids.add(slot.id)
          }

          await db.transaction(async (tx) => {
            const existingRows = await tx.orm.MealSlot.all()
            const existingById = new Map(existingRows.map((row) => [row.id, row]))

            for (const existing of existingRows) {
              if (!ids.has(existing.id) && existing.active !== 0) {
                await tx.orm.MealSlot.where({ id: existing.id }).update({ active: 0 })
              }
            }

            for (const [position, slot] of slots.entries()) {
              const previous = existingById.get(slot.id)
              const aliases = previous ? parseTimeAliases(previous.id, previous.timeAliases) : []
              if (previous && previous.time !== slot.time && !aliases.includes(previous.time)) {
                aliases.push(previous.time)
              }
              const data = {
                id: slot.id,
                name: slot.name,
                time: slot.time,
                position,
                timeAliases: JSON.stringify(aliases),
                active: 1,
              }

              if (previous) {
                await tx.orm.MealSlot.where({ id: slot.id }).update({
                  name: data.name,
                  time: data.time,
                  position: data.position,
                  timeAliases: data.timeAliases,
                  active: data.active,
                })
              } else {
                await tx.orm.MealSlot.create(data)
              }
            }
          })
        })
      },
    },
    close() {
      if (closePromise) return closePromise
      state = 'closing'
      closePromise = (async () => {
        await Promise.allSettled([...inFlight])
        try {
          await db.close()
        } finally {
          state = 'closed'
        }
      })()
      return closePromise
    },
  }
}

class ValueError extends Error {
  override readonly name = 'ValueError'
}
