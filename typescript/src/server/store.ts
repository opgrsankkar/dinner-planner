import sqlite from "@prisma/orm-sqlite/runtime";
import type { DefaultModelRow } from "@prisma/orm-sqlite/orm-client";
import type { Contract } from "../prisma/contract";
import contractJson from "../prisma/contract.json";
import { randomUUID } from "node:crypto";
import type { Board, Card, Placement } from "../types";
import type { Todoist } from "./todoist";
type Id = DefaultModelRow<Contract, "Outbox">["id"];
const id = (value: string) => value as Id;
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
    const operations = await this.db.orm.Outbox.all();
    const cards: Card[] = remote
      .filter((task) => task.projectId === project.id)
      .map((task) => {
        const op = operations.find(
          (row) => row.id === task.requestId && row.state === "saved",
        );
        return {
          ...task,
          state: "saved",
          error: "",
          confirmedAt: Number(op?.confirmedAt ?? 0),
        };
      });
    for (const op of operations.filter((row) => row.state === "pending")) {
      const payload: Placement = JSON.parse(op.payload);
      if (payload.projectId !== project.id) continue;
      // Keep spinner until worker validation, even if the provider exposes the write early.
      const remoteIndex = cards.findIndex((card) => card.requestId === op.id);
      if (remoteIndex >= 0) cards.splice(remoteIndex, 1);
      cards.push({
        id: `local:${op.id}`,
        requestId: op.id,
        ...payload,
        state: "pending",
        error: op.error,
        confirmedAt: 0,
      });
    }
    return {
      library: await this.db.orm.Library.orderBy((m) => m.name.asc()).all(),
      slots: await this.db.orm.Slot.orderBy((s) => s.time.asc()).all(),
      cards,
    };
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
    const action = (await this.store.db.orm.Outbox.all()).find(
      (row) => row.state === "pending" && Number(row.nextAt) <= Date.now(),
    );
    if (!action) return;
    const payload: Placement = JSON.parse(action.payload);
    try {
      const project = await this.todoist.mealsProject();
      if (project.name !== "Meals" || project.id !== payload.projectId)
        throw new Error(
          "Meals project ownership changed; placement remains pending",
        );
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
