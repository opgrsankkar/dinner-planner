#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/4de5b1e9dbd30bde4f9d75b24eaef329b9fbf6914fdfa951e90ff5595442d407/contract';
import endContract from '../../snapshots/4de5b1e9dbd30bde4f9d75b24eaef329b9fbf6914fdfa951e90ff5595442d407/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-sqlite/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        table: 'operational_settings',
        columns: [col('key', 'TEXT', { notNull: true }), col('value', 'TEXT', { notNull: true })],
        constraints: [primaryKey(['key'])],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
