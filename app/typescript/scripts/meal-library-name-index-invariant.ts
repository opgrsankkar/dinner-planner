import { statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'

const tableName = 'meal_library'
const columnName = 'name'
const indexName = 'meal_library_name_nocase'

interface SchemaObjectRow {
  readonly type: string
  readonly name: string
  readonly tbl_name: string
  readonly sql: string | null
}

interface TableListRow {
  readonly schema: string
  readonly name: string
  readonly type: string
}

interface TableColumnRow {
  readonly cid: number
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly hidden: number
}

interface IndexListRow {
  readonly name: string
  readonly unique: number
  readonly origin: string
  readonly partial: number
}

interface IndexXInfoRow {
  readonly seqno: number
  readonly cid: number
  readonly name: string | null
  readonly desc: number
  readonly coll: string | null
  readonly key: number
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

export function verifyMealLibraryNameIndex(databasePath: string): void {
  const absolutePath = resolve(databasePath)
  const fileInfo = statSync(absolutePath)
  invariant(fileInfo.isFile(), `Database path is not an existing regular file: ${absolutePath}`)

  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(absolutePath, { readOnly: true })

    const tableObjects = database
      .prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name = ?')
      .all(tableName) as unknown as SchemaObjectRow[]
    invariant(
      tableObjects.length === 1 &&
        tableObjects[0]?.type === 'table' &&
        tableObjects[0].name === tableName &&
        tableObjects[0].tbl_name === tableName &&
        typeof tableObjects[0].sql === 'string',
      `Expected exactly one physical ${tableName} table in the main SQLite schema`,
    )

    const physicalTables = database.prepare('PRAGMA table_list').all() as unknown as TableListRow[]
    const matchingTables = physicalTables.filter(
      (row) => row.schema === 'main' && row.name === tableName,
    )
    invariant(
      matchingTables.length === 1 && matchingTables[0]?.type === 'table',
      `Expected ${tableName} to be one ordinary physical table in the main SQLite schema`,
    )

    const tableColumns = database
      .prepare('PRAGMA table_xinfo("meal_library")')
      .all() as unknown as TableColumnRow[]
    const nameColumns = tableColumns.filter((row) => row.name === columnName)
    invariant(
      nameColumns.length === 1 &&
        Number.isInteger(nameColumns[0]?.cid) &&
        (nameColumns[0]?.cid ?? -1) >= 0 &&
        nameColumns[0]?.type.trim().toUpperCase() === 'TEXT' &&
        nameColumns[0]?.notnull === 1 &&
        nameColumns[0]?.hidden === 0,
      `Expected ${tableName}.${columnName} to be one visible, non-null TEXT column`,
    )
    const nameColumn = nameColumns[0]!

    const indexObjects = database
      .prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name = ?')
      .all(indexName) as unknown as SchemaObjectRow[]
    invariant(
      indexObjects.length === 1 &&
        indexObjects[0]?.type === 'index' &&
        indexObjects[0].name === indexName &&
        indexObjects[0].tbl_name === tableName &&
        typeof indexObjects[0].sql === 'string',
      `Expected exactly one explicit ${indexName} index on ${tableName}`,
    )

    const listedIndexes = (database
      .prepare('PRAGMA index_list("meal_library")')
      .all() as unknown as IndexListRow[])
      .filter((row) => row.name === indexName)
    invariant(
      listedIndexes.length === 1 &&
        listedIndexes[0]?.unique === 1 &&
        listedIndexes[0]?.origin === 'c' &&
        listedIndexes[0]?.partial === 0,
      `Expected ${indexName} to be one explicitly created, non-partial unique index on ${tableName}`,
    )

    const indexColumns = database
      .prepare('PRAGMA index_xinfo("meal_library_name_nocase")')
      .all() as unknown as IndexXInfoRow[]
    invariant(indexColumns.length > 0, `SQLite returned no index metadata for ${indexName}`)
    const keyColumns = indexColumns.filter((row) => row.key === 1)
    invariant(
      keyColumns.length === 1 &&
        keyColumns[0]?.seqno === 0 &&
        keyColumns[0]?.cid === nameColumn.cid &&
        keyColumns[0]?.name === columnName &&
        typeof keyColumns[0]?.coll === 'string' &&
        keyColumns[0].coll.toUpperCase() === 'NOCASE',
      `Expected ${indexName} to index exactly ${tableName}(${columnName}) with NOCASE collation`,
    )
    invariant(
      indexColumns.every(
        (row) => Number.isInteger(row.seqno) && (row.key === 0 || row.key === 1),
      ),
      `SQLite returned ambiguous index metadata for ${indexName}`,
    )
  } finally {
    database?.close()
  }
}
