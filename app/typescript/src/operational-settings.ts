import sqlite from '@prisma/orm-sqlite/runtime'
import type { Contract } from '../prisma/contract.d'
import contractJson from '../prisma/contract.json' with { type: 'json' }

const db = sqlite<Contract>({
  contractJson,
  path: process.env.DATABASE_PATH ?? './operational.sqlite3',
})

export async function readOperationalSetting(key: string): Promise<string | null> {
  const setting = await db.orm.OperationalSetting.where({ key }).first()
  return setting?.value ?? null
}

export async function writeOperationalSetting(key: string, value: string): Promise<void> {
  const existing = await db.orm.OperationalSetting.where({ key }).first()
  if (existing) {
    await db.orm.OperationalSetting.where({ key }).update({ value })
  } else {
    await db.orm.OperationalSetting.create({ key, value })
  }
}

export async function disconnectOperationalSettings(): Promise<void> {
  await db.close()
}
