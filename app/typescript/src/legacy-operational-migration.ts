import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

interface ColumnSpec {
  readonly name: string
  readonly type: 'TEXT' | 'INTEGER' | 'REAL'
  readonly nullable: boolean
}

interface TableSpec {
  readonly name: string
  readonly primaryKey: string
  readonly columns: readonly ColumnSpec[]
}

export const legacyOperationalTables: readonly TableSpec[] = [
  {
    name: 'meal_library',
    primaryKey: 'id',
    columns: [
      { name: 'id', type: 'TEXT', nullable: false },
      { name: 'name', type: 'TEXT', nullable: false },
      { name: 'position', type: 'INTEGER', nullable: false },
      { name: 'created_at', type: 'TEXT', nullable: false },
    ],
  },
  {
    name: 'meal_slots',
    primaryKey: 'id',
    columns: [
      { name: 'id', type: 'TEXT', nullable: false },
      { name: 'name', type: 'TEXT', nullable: false },
      { name: 'time', type: 'TEXT', nullable: false },
      { name: 'position', type: 'INTEGER', nullable: false },
      { name: 'time_aliases', type: 'TEXT', nullable: false },
      { name: 'active', type: 'INTEGER', nullable: false },
    ],
  },
  {
    name: 'idempotent_actions',
    primaryKey: 'request_id',
    columns: [
      { name: 'request_id', type: 'TEXT', nullable: false },
      { name: 'kind', type: 'TEXT', nullable: false },
      { name: 'payload', type: 'TEXT', nullable: false },
      { name: 'state', type: 'TEXT', nullable: false },
      { name: 'remote_id', type: 'TEXT', nullable: true },
      { name: 'response_json', type: 'TEXT', nullable: true },
      { name: 'updated_at', type: 'TEXT', nullable: false },
      { name: 'task_key', type: 'TEXT', nullable: true },
      { name: 'attempts', type: 'INTEGER', nullable: false },
      { name: 'next_attempt', type: 'REAL', nullable: false },
      { name: 'last_error', type: 'TEXT', nullable: true },
      { name: 'create_attempted', type: 'INTEGER', nullable: false },
    ],
  },
  {
    name: 'project_task_cache',
    primaryKey: 'task_key',
    columns: [
      { name: 'task_key', type: 'TEXT', nullable: false },
      { name: 'remote_id', type: 'TEXT', nullable: true },
      { name: 'project_id', type: 'TEXT', nullable: false },
      { name: 'task_json', type: 'TEXT', nullable: false },
      { name: 'seen_at', type: 'REAL', nullable: false },
    ],
  },
  {
    name: 'task_tombstones',
    primaryKey: 'remote_id',
    columns: [
      { name: 'remote_id', type: 'TEXT', nullable: false },
      { name: 'created_at', type: 'REAL', nullable: false },
    ],
  },
  {
    name: 'kv',
    primaryKey: 'key',
    columns: [
      { name: 'key', type: 'TEXT', nullable: false },
      { name: 'value', type: 'TEXT', nullable: false },
    ],
  },
]

interface TableInfoRow {
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly pk: number
}

function requireTemporaryAbsolutePath(filePath: string, label: string): string {
  if (!isAbsolute(filePath)) {
    throw new Error(`${label} must be an absolute temporary file path`)
  }

  const normalized = resolve(filePath)
  const tempRoot = resolve(tmpdir())
  const relativePath = relative(tempRoot, normalized)
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} must be inside the operating system temporary directory`)
  }
  return normalized
}

function tableInfo(database: DatabaseSync, table: string): TableInfoRow[] {
  return database.prepare(`PRAGMA table_info("${table}")`).all() as unknown as TableInfoRow[]
}

function validateTableShape(database: DatabaseSync, spec: TableSpec, label: string): void {
  const rows = tableInfo(database, spec.name)
  const found = new Map(rows.map((row) => [row.name, row]))
  const expectedNames = spec.columns.map((column) => column.name).sort()
  const actualNames = [...found.keys()].sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`${label} table ${spec.name} has columns ${actualNames.join(', ')}; expected ${expectedNames.join(', ')}`)
  }

  for (const column of spec.columns) {
    const actual = found.get(column.name)
    if (!actual || actual.type.toUpperCase() !== column.type) {
      throw new Error(`${label} column ${spec.name}.${column.name} has an unsupported SQLite type`)
    }
    const isPrimaryKey = column.name === spec.primaryKey
    if (label === 'target' && Boolean(actual.notnull) !== !column.nullable) {
      throw new Error(`${label} column ${spec.name}.${column.name} has unexpected nullability`)
    }
    if (Boolean(actual.pk) !== isPrimaryKey) {
      throw new Error(`${label} table ${spec.name} has an unexpected primary key at ${column.name}`)
    }
    // SQLite's legacy TEXT PRIMARY KEY declarations report notnull=0 and accept
    // NULL. The app always writes IDs, so source rows with NULL keys are rejected
    // explicitly before copying into Prisma's stricter @id contract.
    if (label === 'source' && !isPrimaryKey && Boolean(actual.notnull) === column.nullable) {
      throw new Error(`${label} column ${spec.name}.${column.name} has unexpected nullability`)
    }
  }
}

function rowCount(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number | bigint }
  return Number(row.count)
}

function assertSourcePrimaryKeysPopulated(database: DatabaseSync): void {
  for (const spec of legacyOperationalTables) {
    const row = database
      .prepare(`SELECT COUNT(*) AS count FROM "${spec.name}" WHERE "${spec.primaryKey}" IS NULL`)
      .get() as { count: number | bigint }
    if (Number(row.count) > 0) {
      throw new Error(
        `Legacy ${spec.name}.${spec.primaryKey} contains ${Number(row.count)} NULL primary key value(s); Prisma @id requires non-NULL values`,
      )
    }
  }
}

function assertTargetEmpty(database: DatabaseSync): void {
  const populated = legacyOperationalTables
    .filter((spec) => rowCount(database, spec.name) !== 0)
    .map((spec) => spec.name)
  if (populated.length > 0) {
    throw new Error(`Target operational tables must be empty before import: ${populated.join(', ')}`)
  }
}

function hasUniqueSingleColumnIndex(
  database: DatabaseSync,
  table: string,
  columnName: string,
  collation: string,
): boolean {
  const indexes = database.prepare(`PRAGMA index_list("${table}")`).all() as {
    readonly name: string
    readonly unique: number
  }[]
  return indexes.some((index) => {
    if (index.unique !== 1) return false
    const quotedName = index.name.replaceAll('"', '""')
    const columns = database.prepare(`PRAGMA index_xinfo("${quotedName}")`).all() as {
      readonly name: string | null
      readonly coll: string | null
      readonly key: number
    }[]
    const keys = columns.filter((item) => item.key === 1)
    return keys.length === 1 && keys[0]?.name === columnName && keys[0]?.coll?.toUpperCase() === collation
  })
}

function assertMealLibraryNoCaseIndex(database: DatabaseSync): void {
  const index = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'meal_library_name_nocase'`)
    .get() as { sql: string } | undefined
  if (
    !index?.sql ||
    !/^CREATE UNIQUE INDEX/i.test(index.sql) ||
    !/COLLATE\s+NOCASE/i.test(index.sql) ||
    !hasUniqueSingleColumnIndex(database, 'meal_library', 'name', 'NOCASE')
  ) {
    throw new Error('Target is missing the legacy meal_library.name COLLATE NOCASE unique constraint')
  }
}

function assertLegacyMealLibraryNoCaseConstraint(database: DatabaseSync): void {
  if (!hasUniqueSingleColumnIndex(database, 'meal_library', 'name', 'NOCASE')) {
    throw new Error('Source is missing the legacy meal_library.name COLLATE NOCASE unique constraint')
  }
}

function assertRemoteIdUniqueConstraint(database: DatabaseSync, label: string): void {
  if (!hasUniqueSingleColumnIndex(database, 'project_task_cache', 'remote_id', 'BINARY')) {
    throw new Error(`${label} is missing the project_task_cache.remote_id unique constraint`)
  }
}

/**
 * Copy the six app-owned legacy tables into an empty database that has already
 * been created by the checked-in Prisma 8 migrations. This intentionally only
 * accepts absolute paths inside the OS temporary directory; it is a proof
 * harness, not a production cutover utility.
 */
export function migrateLegacyOperationalData(sourceFile: string, targetFile: string): void {
  const sourcePath = requireTemporaryAbsolutePath(sourceFile, 'Source')
  const targetPath = requireTemporaryAbsolutePath(targetFile, 'Target')
  if (sourcePath === targetPath) {
    throw new Error('Source and target must be different temporary database files')
  }

  const source = new DatabaseSync(sourcePath, { readOnly: true })
  const target = new DatabaseSync(targetPath)
  try {
    for (const spec of legacyOperationalTables) {
      validateTableShape(source, spec, 'source')
      validateTableShape(target, spec, 'target')
    }
    assertLegacyMealLibraryNoCaseConstraint(source)
    assertMealLibraryNoCaseIndex(target)
    assertRemoteIdUniqueConstraint(source, 'Source')
    assertRemoteIdUniqueConstraint(target, 'Target')
    assertSourcePrimaryKeysPopulated(source)
    assertTargetEmpty(target)

    target.exec('PRAGMA foreign_keys = ON')
    target.exec('BEGIN IMMEDIATE')
    try {
      for (const spec of legacyOperationalTables) {
        const columns = spec.columns.map((column) => `"${column.name}"`).join(', ')
        const placeholders = spec.columns.map(() => '?').join(', ')
        const sourceRows = source
          .prepare(`SELECT ${columns} FROM "${spec.name}" ORDER BY rowid`)
          .all() as Record<string, SQLOutputValue>[]
        const insert = target.prepare(`INSERT INTO "${spec.name}" (${columns}) VALUES (${placeholders})`)

        for (const row of sourceRows) {
          const values: SQLInputValue[] = spec.columns.map((column) => {
            const value = row[column.name]
            if (typeof value === 'undefined') {
              throw new Error(`Legacy row in ${spec.name} omitted ${column.name}`)
            }
            return value
          })
          insert.run(...values)
        }
      }
      target.exec('COMMIT')
    } catch (error) {
      target.exec('ROLLBACK')
      throw error
    }
  } finally {
    source.close()
    target.close()
  }
}
