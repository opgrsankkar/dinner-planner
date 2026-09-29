#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/4de5b1e9dbd30bde4f9d75b24eaef329b9fbf6914fdfa951e90ff5595442d407/contract';
import startContract from '../../snapshots/4de5b1e9dbd30bde4f9d75b24eaef329b9fbf6914fdfa951e90ff5595442d407/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/f98afee84feb956a923f4bc8c8d94286a3f663c4dcdf6d96bdc1166cb71a6382/contract';
import endContract from '../../snapshots/f98afee84feb956a923f4bc8c8d94286a3f663c4dcdf6d96bdc1166cb71a6382/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  col,
  fn,
  lit,
  primaryKey,
  rawSql,
  unique,
} from '@prisma/orm-sqlite/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        table: 'idempotent_actions',
        columns: [
          col('attempts', 'INTEGER', { notNull: true, default: lit(0) }),
          col('create_attempted', 'INTEGER', { notNull: true, default: lit(0) }),
          col('kind', 'TEXT', { notNull: true }),
          col('last_error', 'TEXT'),
          col('next_attempt', 'REAL', { notNull: true, default: lit(0) }),
          col('payload', 'TEXT', { notNull: true }),
          col('remote_id', 'TEXT'),
          col('request_id', 'TEXT', { notNull: true }),
          col('response_json', 'TEXT'),
          col('state', 'TEXT', { notNull: true }),
          col('task_key', 'TEXT'),
          col('updated_at', 'TEXT', { notNull: true, default: fn('now()') }),
        ],
        constraints: [primaryKey(['request_id'])],
      }),
      this.createTable({
        table: 'kv',
        columns: [col('key', 'TEXT', { notNull: true }), col('value', 'TEXT', { notNull: true })],
        constraints: [primaryKey(['key'])],
      }),
      this.createTable({
        table: 'meal_library',
        columns: [
          col('created_at', 'TEXT', { notNull: true, default: fn('now()') }),
          col('id', 'TEXT', { notNull: true }),
          col('name', 'TEXT', { notNull: true }),
          col('position', 'INTEGER', { notNull: true }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        table: 'meal_slots',
        columns: [
          col('active', 'INTEGER', { notNull: true, default: lit(1) }),
          col('id', 'TEXT', { notNull: true }),
          col('name', 'TEXT', { notNull: true }),
          col('position', 'INTEGER', { notNull: true }),
          col('time', 'TEXT', { notNull: true }),
          col('time_aliases', 'TEXT', { notNull: true, default: lit('[]') }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        table: 'project_task_cache',
        columns: [
          col('project_id', 'TEXT', { notNull: true }),
          col('remote_id', 'TEXT'),
          col('seen_at', 'REAL', { notNull: true }),
          col('task_json', 'TEXT', { notNull: true }),
          col('task_key', 'TEXT', { notNull: true }),
        ],
        constraints: [primaryKey(['task_key']), unique(['remote_id'])],
      }),
      this.createTable({
        table: 'task_tombstones',
        columns: [
          col('created_at', 'REAL', { notNull: true }),
          col('remote_id', 'TEXT', { notNull: true }),
        ],
        constraints: [primaryKey(['remote_id'])],
      }),
      rawSql({
        id: 'index.meal_library_name_nocase',
        label: 'Create NOCASE unique index meal_library_name_nocase',
        summary: 'Preserve the legacy case-insensitive unique meal name constraint',
        operationClass: 'additive',
        target: {
          id: 'sqlite',
          details: {
            schema: 'main',
            objectType: 'index',
            name: 'meal_library_name_nocase',
            table: 'meal_library',
          },
        },
        precheck: [
          {
            description: 'ensure index "meal_library_name_nocase" does not exist',
            sql: 'SELECT COUNT(*) = 0 AS "result" FROM "sqlite_master" WHERE ("type" = ? AND "name" = ?)',
            params: ['index', 'meal_library_name_nocase'],
          },
        ],
        execute: [
          {
            description: 'create case-insensitive unique meal library index',
            sql: 'CREATE UNIQUE INDEX "meal_library_name_nocase" ON "meal_library" ("name" COLLATE NOCASE)',
            params: [],
          },
        ],
        postcheck: [
          {
            description: 'verify index "meal_library_name_nocase" exists',
            sql: 'SELECT COUNT(*) > 0 AS "result" FROM "sqlite_master" WHERE ("type" = ? AND "name" = ?)',
            params: ['index', 'meal_library_name_nocase'],
          },
        ],
      }),
      this.dropTable({ table: 'operational_settings' }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
