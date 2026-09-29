import { definePrismaConfig } from '@prisma/cli-engine'
import { defineConfig as ormConfig } from '@prisma/orm-sqlite/config'

export default definePrismaConfig({
  orm: ormConfig({
    contract: './prisma/contract.prisma',
    db: { connection: process.env.DATABASE_PATH ?? './operational.sqlite3' },
    migrations: { dir: './prisma/migrations' },
  }),
})
