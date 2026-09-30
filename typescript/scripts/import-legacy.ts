import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store, uuidPattern } from "../src/server/store";
import type { Settings } from "../src/types";

type Library = { id: string; name: string; position: number };
type LegacySlot = Library & {
  time: string;
  time_aliases: string;
  active: number;
};
const settingId = "00000000-0000-4000-8000-000000000001";
// Stable mapping keeps legacy human-readable slot IDs identifiable across imports.
function slotId(legacy: string) {
  if (uuidPattern.test(legacy)) return legacy;
  const hex = createHash("sha256")
    .update("dinner-planner-slot:" + legacy)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function importLegacy(sourcePath: string, targetPath: string) {
  const source = realpathSync(sourcePath),
    target = resolve(targetPath);
  if (source === target || existsSync(target))
    throw new Error(
      "Target must be a distinct, nonexistent database path. Never overwrite the source or an earlier import.",
    );
  if (!statSync(source).isFile())
    throw new Error("Source must be an explicit SQLite backup file");
  if (existsSync(source + "-wal") && statSync(source + "-wal").size)
    throw new Error(
      "Source has a WAL. Use SQLite's backup command to produce a consistent standalone backup first.",
    );
  const db = new DatabaseSync(source, { readOnly: true });
  let library: Library[],
    slots: LegacySlot[],
    values: { key: string; value: string }[];
  try {
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new Error("Source backup failed integrity_check");
    const tables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
    for (const table of [
      "meal_library",
      "meal_slots",
      "kv",
      "idempotent_actions",
      "project_task_cache",
      "task_tombstones",
    ])
      if (!tables.has(table))
        throw new Error(
          `Unsupported legacy schema: missing ${table}. Run the old application migrations on a separate copy first.`,
        );
    const unresolved = db
      .prepare(
        "SELECT COUNT(*) AS count FROM idempotent_actions WHERE state <> 'done'",
      )
      .get()!.count;
    const tombstones = db
      .prepare("SELECT COUNT(*) AS count FROM task_tombstones")
      .get()!.count;
    const localCache = db
      .prepare(
        "SELECT COUNT(*) AS count FROM project_task_cache WHERE remote_id IS NULL OR remote_id LIKE 'local:%'",
      )
      .get()!.count;
    if (Number(unresolved) || Number(tombstones) || Number(localCache))
      throw new Error(
        `Unsafe cutover: ${unresolved} unresolved actions, ${tombstones} tombstones, ${localCache} local cache entries. Keep the old worker running to drain/reconcile its queue and deletion tombstones; inspect failed/uncertain creates by their description markers. Take a fresh consistent backup after reconciliation. This importer will not discard or replay uncertain writes.`,
      );
    library = db
      .prepare(
        "SELECT id,name,position FROM meal_library ORDER BY position,name COLLATE NOCASE,id",
      )
      .all() as Library[];
    slots = db
      .prepare(
        "SELECT id,name,time,position,time_aliases,active FROM meal_slots ORDER BY position,id",
      )
      .all() as LegacySlot[];
    values = db.prepare("SELECT key,value FROM kv ORDER BY key").all() as {
      key: string;
      value: string;
    }[];
    const names = new Set<string>();
    for (const meal of library) {
      if (
        !uuidPattern.test(meal.id) ||
        !meal.name.trim() ||
        meal.name.length > 120
      )
        throw new Error(
          "Unsupported library ID/name; repair a separate backup copy before import (IDs are preserved).",
        );
      const name = meal.name.toLowerCase();
      if (names.has(name))
        throw new Error(
          "Case-insensitive duplicate library names; repair a separate backup copy before import.",
        );
      names.add(name);
    }
    const times = new Set<string>();
    for (const slot of slots) {
      if (
        !slot.id ||
        !slot.name.trim() ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time) ||
        ![0, 1].includes(slot.active)
      )
        throw new Error(
          "Invalid legacy slot; repair a separate backup copy before import.",
        );
      const aliases: unknown = JSON.parse(slot.time_aliases);
      if (
        !Array.isArray(aliases) ||
        aliases.some(
          (t) => typeof t !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t),
        )
      )
        throw new Error("Invalid legacy time aliases");
      if (slot.active && times.has(slot.time))
        throw new Error(
          "Duplicate active slot times; repair a separate backup copy before import.",
        );
      if (slot.active) times.add(slot.time);
    }
    if (
      !slots.some((slot) => slot.active) ||
      slots.filter((slot) => slot.active).length > 12
    )
      throw new Error("Legacy backup needs between 1 and 12 active slots");
  } finally {
    db.close();
  }
  mkdirSync(dirname(target), { recursive: true });
  // Build beside the target, then publish with an exclusive hard link. A failure
  // leaves no partially imported target and cannot replace a concurrently created file.
  const staging = await mkdtemp(join(dirname(target), ".planner-import-"));
  const staged = join(staging, "planner.sqlite");
  let store: Store | undefined;
  try {
    const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    execFileSync(
      process.execPath,
      ["node_modules/prisma/dist/prisma.js", "db", "init"],
      {
        cwd,
        env: {
          ...process.env,
          DATABASE_PATH: staged,
          PLANNER_DB: staged,
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdio: "pipe",
      },
    );
    store = new Store(staged);
    const active = slots.filter((slot) => slot.active);
    const aliases: Record<string, string> = {};
    const ambiguous = new Set<string>();
    for (const slot of active)
      for (const time of JSON.parse(slot.time_aliases) as string[]) {
        if (aliases[time] && aliases[time] !== slotId(slot.id))
          ambiguous.add(time);
        aliases[time] = slotId(slot.id);
      }
    for (const time of ambiguous) delete aliases[time];
    const rawTheme =
      values.find((row) => row.key === "theme_mode")?.value ?? "system";
    if (!["light", "dark", "system"].includes(rawTheme))
      throw new Error("Invalid legacy theme");
    const settings: Settings = {
      theme: rawTheme as Settings["theme"],
      slotOrder: active.map((slot) => slotId(slot.id)),
      libraryOrder: library.map((meal) => meal.id),
      aliases,
      revision: 0,
    };
    await store.db.transaction(async (tx) => {
      for (const meal of library)
        await tx.orm.Library.create({
          id: meal.id as Parameters<typeof tx.orm.Library.create>[0]["id"],
          name: meal.name,
        });
      for (const slot of active)
        await tx.orm.Slot.create({
          id: slotId(slot.id) as Parameters<typeof tx.orm.Slot.create>[0]["id"],
          name: slot.name,
          time: slot.time,
        });
      // Preserve inactive slots, original IDs/order, all aliases and settings as
      // import metadata; only active slots participate in the planner.
      await tx.orm.Setting.create({
        id: settingId as Parameters<typeof tx.orm.Setting.create>[0]["id"],
        value: JSON.stringify({
          ...settings,
          legacyImport: {
            slots,
            values,
            slotIds: Object.fromEntries(
              slots.map((slot) => [slot.id, slotId(slot.id)]),
            ),
          },
        }),
      });
    });
    await store.close();
    store = undefined;
    const checkpoint = new DatabaseSync(staged);
    checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    checkpoint.close();
    linkSync(staged, target);
    return {
      library: library.length,
      activeSlots: active.length,
      inactiveSlots: slots.length - active.length,
      target,
    };
  } finally {
    await store?.close();
    await rm(staging, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--target") {
    console.error(
      "Usage: npm run import:legacy -- --source /explicit/backup.sqlite --target /distinct/new.sqlite",
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(await importLegacy(args[1], args[3]));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Import failed");
      process.exitCode = 1;
    }
  }
}
