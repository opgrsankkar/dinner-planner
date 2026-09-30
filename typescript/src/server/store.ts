import sqlite from "@prisma/orm-sqlite/runtime";
import type { DefaultModelRow } from "@prisma/orm-sqlite/orm-client";
import type { Contract } from "../prisma/contract";
import contractJson from "../prisma/contract.json";
import { randomUUID } from "node:crypto";
import type {
  Board,
  Card,
  Placement,
  Mutation,
  Settings,
  Slot,
} from "../types";
import type { Todoist } from "./todoist";
type Id = DefaultModelRow<Contract, "Outbox">["id"];
const id = (value: string) => value as Id;
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const settingsId = id("00000000-0000-4000-8000-000000000001");
export class Store {
  readonly db;
  private writing: Promise<unknown> = Promise.resolve();
  constructor(path: string) {
    this.db = sqlite<Contract>({ contractJson, path });
  }
  // One writer within the application, including requests and worker acknowledgements.
  write<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writing.then(fn);
    this.writing = result.catch(() => {});
    return result;
  }
  async seed() {
    await this.write(() =>
      this.db.transaction(async (tx) => {
        if (await tx.orm.Setting.where({ id: settingsId }).first()) return;
        if (!(await tx.orm.Slot.first())) {
          for (const [name, time] of [
            ["Breakfast", "08:00"],
            ["Lunch", "13:00"],
            ["Dinner", "19:00"],
          ]) {
            await tx.orm.Slot.create({ id: id(randomUUID()), name, time });
          }
        }
        if (!(await tx.orm.Library.first()))
          for (const name of ["Idli & sambar", "Dal & rice", "Vegetable pasta"])
            await tx.orm.Library.create({ id: id(randomUUID()), name });
        await tx.orm.Setting.create({
          id: settingsId,
          value: JSON.stringify({
            theme: "system",
            slotOrder: [],
            libraryOrder: [],
            aliases: {},
            revision: 0,
          } satisfies Settings),
        });
      }),
    );
  }
  async addLibrary(name: string) {
    name = name.trim();
    if (!name || name.length > 120)
      throw new Error("Use a meal name between 1 and 120 characters");
    return this.write(() =>
      this.db.transaction(async (tx) => {
        const existing = (await tx.orm.Library.all()).find(
          (meal) => meal.name.toLowerCase() === name.toLowerCase(),
        );
        return (
          existing ?? tx.orm.Library.create({ id: id(randomUUID()), name })
        );
      }),
    );
  }
  async place(
    input: { requestId: string; mealId: string; slotId: string; date: string },
    projectId: string,
  ) {
    if (
      !uuidPattern.test(input.requestId) ||
      !uuidPattern.test(input.mealId) ||
      !uuidPattern.test(input.slotId)
    )
      throw new Error("Invalid placement ID");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
      new Date(`${input.date}T12:00:00Z`).toISOString().slice(0, 10) !==
        input.date
    )
      throw new Error("Invalid day");
    return this.write(() =>
      this.db.transaction(async (tx) => {
        const existing = await tx.orm.Outbox.where({
          id: id(input.requestId),
        }).first();
        if (existing) {
          const previous: Placement = JSON.parse(existing.payload);
          if (
            previous.mealId !== input.mealId ||
            previous.slotId !== input.slotId ||
            previous.date !== input.date ||
            previous.projectId !== projectId
          )
            throw new Error("Request ID already belongs to another placement");
          return existing;
        }
        const meal = await tx.orm.Library.where({
          id: id(input.mealId),
        }).first();
        const slot = await tx.orm.Slot.where({ id: id(input.slotId) }).first();
        if (!meal || !slot) throw new Error("Meal or slot no longer exists");
        const payload: Placement = {
          mealId: meal.id,
          name: meal.name,
          slotId: slot.id,
          time: slot.time,
          date: input.date,
          projectId,
        };
        return tx.orm.Outbox.create({
          id: id(input.requestId),
          payload: JSON.stringify(payload),
          state: "pending",
          error: "",
          remoteId: "",
          attempted: "0",
          nextAt: "0",
          confirmedAt: "0",
        });
      }),
    );
  }
  async board(todoist: Todoist): Promise<Omit<Board, "csrf">> {
    const project = await todoist.mealsProject();
    if (project.name !== "Meals")
      throw new Error("Configured project is not Meals");
    const remote = await todoist.list(project.id);
    return this.write(async () => {
      const settings = await this.settings();
      const operations = (await this.db.orm.Outbox.all()).filter(
        (row) => (JSON.parse(row.payload) as Mutation).projectId === project.id,
      );
      const cards: Card[] = remote
        .filter(
          (task) =>
            task.projectId === project.id &&
            !operations.some(
              (row) =>
                row.state === "saved" &&
                (JSON.parse(row.payload) as Mutation).kind === "delete" &&
                row.remoteId === task.id,
            ),
        )
        .map((task) => {
          const op = [...operations]
            .sort((a, b) => Number(b.confirmedAt) - Number(a.confirmedAt))
            .find(
              (row) =>
                (row.id === task.requestId || row.remoteId === task.id) &&
                row.state === "saved",
            );
          return {
            ...task,
            state: "saved",
            error: "",
            confirmedAt: Number(op?.confirmedAt ?? 0),
          };
        });
      for (const op of operations.filter((row) => row.state === "pending")) {
        const payload: Mutation = JSON.parse(op.payload);
        if (payload.projectId !== project.id) continue;
        // Keep spinner until worker validation, even if the provider exposes the write early.
        const remoteIndex = cards.findIndex(
          (card) => card.requestId === op.id || card.id === payload.taskId,
        );
        if (remoteIndex >= 0) cards.splice(remoteIndex, 1);
        cards.push({
          id: payload.taskId ?? `local:${op.id}`,
          deleting: payload.kind === "delete",
          requestId: op.id,
          ...payload,
          state: "pending",
          error: op.error,
          confirmedAt: 0,
        });
      }
      settings.aliases = Object.fromEntries(
        Object.entries(settings.aliases).filter(([, slotId]) =>
          operations.some(
            (row) =>
              row.state === "pending" &&
              (JSON.parse(row.payload) as Mutation).slotId === slotId,
          ),
        ),
      );
      const slots = await this.db.orm.Slot.all();
      for (const card of cards)
        card.slotId =
          slots.find((slot) => slot.time === card.time)?.id ??
          settings.aliases[card.time];
      const sort = <T extends { id: string }>(items: T[], order: string[]) =>
        items.sort((a, b) => {
          const ai = order.indexOf(a.id),
            bi = order.indexOf(b.id);
          return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
        });
      return {
        settings,
        projectId: project.id,
        receivedRequests: operations
          .filter(
            (row) =>
              (JSON.parse(row.payload) as Mutation).projectId === project.id,
          )
          .map((row) => row.id),
        library: sort(await this.db.orm.Library.all(), settings.libraryOrder),
        slots: sort(slots, settings.slotOrder),
        cards,
      };
    });
  }
  async settings(): Promise<Settings> {
    const row = await this.db.orm.Setting.where({ id: settingsId }).first();
    return row
      ? JSON.parse(row.value)
      : {
          theme: "system",
          slotOrder: [],
          libraryOrder: [],
          aliases: {},
          revision: 0,
        };
  }
  async saveTheme(theme: Settings["theme"]) {
    if (!["system", "light", "dark"].includes(theme))
      throw new Error("Invalid theme");
    return this.write(async () => {
      const settings = { ...(await this.settings()), theme };
      await this.putSettings(settings);
      return settings;
    });
  }
  private async putSettings(settings: Settings) {
    const row = await this.db.orm.Setting.where({ id: settingsId }).first();
    if (row)
      await this.db.orm.Setting.where({ id: settingsId }).update({
        value: JSON.stringify(settings),
      });
    else
      await this.db.orm.Setting.create({
        id: settingsId,
        value: JSON.stringify(settings),
      });
  }
  async removeLibrary(mealId: string) {
    if (!uuidPattern.test(mealId)) throw new Error("Invalid meal ID");
    await this.write(() =>
      this.db.orm.Library.where({ id: id(mealId) }).delete(),
    );
  }
  async shuffle() {
    return this.write(async () => {
      const order = (await this.db.orm.Library.all()).map((meal) => meal.id);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      await this.putSettings({
        ...(await this.settings()),
        libraryOrder: order,
      });
    });
  }
  async change(
    input: {
      requestId: string;
      taskId: string;
      kind: "move" | "delete";
      slotId?: string;
      date?: string;
    },
    todoist: Todoist,
  ) {
    if (
      !uuidPattern.test(input.requestId) ||
      !input.taskId.trim() ||
      input.taskId.length > 200
    )
      throw new Error("Invalid operation ID");
    const project = await todoist.mealsProject();
    if (project.name !== "Meals") throw new Error("Meals project unavailable");
    return this.write(async () => {
      const existing = await this.db.orm.Outbox.where({
        id: id(input.requestId),
      }).first();
      if (existing) {
        const previous: Mutation = JSON.parse(existing.payload);
        if (
          previous.kind !== input.kind ||
          previous.taskId !== input.taskId ||
          previous.projectId !== project.id ||
          (input.kind === "move" &&
            (previous.slotId !== input.slotId || previous.date !== input.date))
        )
          throw new Error("Request ID already belongs to another operation");
        return existing;
      }
      const operations = await this.db.orm.Outbox.all();
      if (
        operations.some(
          (row) =>
            row.state === "pending" &&
            (JSON.parse(row.payload) as Mutation).taskId === input.taskId,
        )
      )
        throw new Error("Meal already has a pending change");
      const task = (await todoist.list(project.id)).find(
        (task) => task.id === input.taskId && task.projectId === project.id,
      );
      if (!task) throw new Error("Meal does not belong to Meals");
      const slot = await this.db.orm.Slot.where({
        id: id(input.slotId ?? ""),
      }).first();
      if (input.kind === "move" && (!slot || !validDate(input.date ?? "")))
        throw new Error("Invalid destination");
      const payload: Mutation = {
        kind: input.kind,
        taskId: task.id,
        projectId: project.id,
        name: task.name,
        mealId: "",
        slotId: slot?.id ?? "",
        date: input.kind === "move" ? input.date! : task.date,
        time: input.kind === "move" ? slot!.time : task.time,
      };
      return this.enqueue(payload, input.requestId);
    });
  }
  private async enqueue(payload: Mutation, requestId: string = randomUUID()) {
    return this.db.orm.Outbox.create({
      id: id(requestId),
      payload: JSON.stringify(payload),
      state: "pending",
      error: "",
      remoteId: "",
      attempted: "0",
      nextAt: "0",
      confirmedAt: "0",
    });
  }
  async retry(requestId: string, todoist: Todoist) {
    if (!uuidPattern.test(requestId)) throw new Error("Invalid request ID");
    const project = await todoist.mealsProject();
    await this.write(async () => {
      const row = await this.db.orm.Outbox.where({ id: id(requestId) }).first();
      if (
        !row ||
        project.name !== "Meals" ||
        (JSON.parse(row.payload) as Mutation).projectId !== project.id
      )
        throw new Error("Operation does not belong to Meals");
      if (row.state === "pending")
        await this.db.orm.Outbox.where({ id: row.id }).update({
          nextAt: "0",
          error: "",
        });
    });
  }
  async saveSlots(slots: Slot[], revision: number, todoist: Todoist) {
    if (
      !slots.length ||
      slots.length > 12 ||
      slots.some(
        (slot) =>
          !uuidPattern.test(slot.id) ||
          !slot.name.trim() ||
          slot.name.length > 120 ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time),
      ) ||
      new Set(slots.map((slot) => slot.id)).size !== slots.length ||
      new Set(slots.map((slot) => slot.time)).size !== slots.length
    )
      throw new Error("Every slot needs a name and unique time");
    const project = await todoist.mealsProject();
    if (project.name !== "Meals") throw new Error("Meals project unavailable");
    return this.write(async () => {
      const settings = await this.settings();
      if (settings.revision !== revision)
        throw new Error("Settings changed elsewhere. Reload before saving");
      const old = await this.db.orm.Slot.all();
      const operations = await this.db.orm.Outbox.all();
      if (operations.some((row) => row.state === "pending"))
        throw new Error("Wait for pending meals before changing slots");
      const remote = await todoist.list(project.id);
      const aliases: Record<string, string> = {};
      await this.db.transaction(async (tx) => {
        for (const slot of slots) {
          const previous = old.find((item) => item.id === slot.id);
          if (previous && previous.time !== slot.time) {
            aliases[previous.time] = slot.id;
            for (const task of remote.filter(
              (task) =>
                task.projectId === project.id && task.time === previous.time,
            )) {
              await tx.orm.Outbox.create({
                id: id(randomUUID()),
                payload: JSON.stringify({
                  kind: "move",
                  taskId: task.id,
                  projectId: project.id,
                  name: task.name,
                  mealId: "",
                  slotId: slot.id,
                  date: task.date,
                  time: slot.time,
                } satisfies Mutation),
                state: "pending",
                error: "",
                remoteId: "",
                attempted: "0",
                nextAt: "0",
                confirmedAt: "0",
              });
            }
          }
        }
        for (const previous of old)
          await tx.orm.Slot.where({ id: previous.id }).delete();
        for (const slot of slots)
          await tx.orm.Slot.create({
            ...slot,
            id: id(slot.id),
            name: slot.name.trim(),
          });
        const next = {
          ...settings,
          aliases,
          slotOrder: slots.map((slot) => slot.id),
          revision: revision + 1,
        };
        const row = await tx.orm.Setting.where({ id: settingsId }).first();
        if (row)
          await tx.orm.Setting.where({ id: settingsId }).update({
            value: JSON.stringify(next),
          });
        else
          await tx.orm.Setting.create({
            id: settingsId,
            value: JSON.stringify(next),
          });
      });
      return this.settings();
    });
  }
  async session(token: string) {
    if (!uuidPattern.test(token)) return null;
    const session = await this.db.orm.Session.where({ id: id(token) }).first();
    return session && Number(session.expiresAt) > Date.now() ? session : null;
  }
  async login() {
    return this.write(() =>
      this.db.orm.Session.create({
        id: id(randomUUID()),
        csrf: randomUUID(),
        expiresAt: String(Date.now() + 7 * 86400000),
      }),
    );
  }
  async logout(token: string) {
    await this.write(() =>
      this.db.orm.Session.where({ id: id(token) }).delete(),
    );
  }
  async close() {
    await this.writing;
    await this.db.close();
  }
}
function validDate(date: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date + "T12:00:00Z")) &&
    new Date(date + "T12:00:00Z").toISOString().slice(0, 10) === date
  );
}
export class Worker {
  private active: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private store: Store,
    private todoist: Todoist,
  ) {}
  start() {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.tick().catch(console.error);
      }, 300);
      this.timer.unref();
    }
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.process().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  private async process() {
    const action = await this.store.write(async () =>
      (await this.store.db.orm.Outbox.all()).find(
        (row) => row.state === "pending" && Number(row.nextAt) <= Date.now(),
      ),
    );
    if (!action) return;
    const payload: Mutation = JSON.parse(action.payload);
    try {
      const project = await this.todoist.mealsProject();
      if (project.name !== "Meals" || project.id !== payload.projectId)
        throw new Error(
          "Meals project ownership changed; placement remains pending",
        );
      if (payload.kind) {
        await this.store.write(() =>
          this.store.db.orm.Outbox.where({ id: action.id }).update({
            attempted: String(Number(action.attempted) + 1),
          }),
        );
        if (payload.kind === "delete") {
          await this.todoist.delete(payload.taskId!, project.id, action.id);
          // Success/404 is final acknowledgement. Never GET to validate a delete.
        } else {
          const task = await this.todoist.move(
            { ...payload, taskId: payload.taskId! },
            action.id,
          );
          if (
            task.id !== payload.taskId ||
            task.projectId !== project.id ||
            task.date !== payload.date ||
            task.time !== payload.time ||
            task.name !== payload.name
          )
            throw new Error("Todoist acknowledgement did not match move");
        }
        await this.store.write(() =>
          this.store.db.orm.Outbox.where({ id: action.id }).update({
            state: "saved",
            remoteId: payload.taskId!,
            error: "",
            confirmedAt: String(Date.now()),
          }),
        );
        return;
      }
      const matches = (await this.todoist.list(project.id)).filter(
        (task) => task.requestId === action.id,
      );
      if (matches.length > 1)
        throw new Error("Duplicate placement markers require inspection");
      await this.store.write(() =>
        this.store.db.orm.Outbox.where({ id: action.id }).update({
          attempted: String(Number(action.attempted) + 1),
        }),
      );
      // Injectable providers must implement request-id idempotency. Same ID on every retry.
      const task =
        matches[0] ?? (await this.todoist.create(payload, action.id));
      if (
        task.projectId !== project.id ||
        task.requestId !== action.id ||
        task.name !== payload.name ||
        task.date !== payload.date ||
        task.time !== payload.time
      )
        throw new Error("Todoist acknowledgement did not match placement");
      await this.store.write(() =>
        this.store.db.orm.Outbox.where({ id: action.id }).update({
          state: "saved",
          remoteId: task.id,
          error: "",
          confirmedAt: String(Date.now()),
        }),
      );
    } catch (error) {
      const delay = Math.min(
        30000,
        500 * 2 ** Math.min(Number(action.attempted), 6),
      );
      await this.store.write(() =>
        this.store.db.orm.Outbox.where({ id: action.id }).update({
          error: error instanceof Error ? error.message : "Sync failed",
          nextAt: String(Date.now() + delay),
        }),
      );
    }
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
