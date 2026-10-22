import { sortSlotsByTime } from "../slot-order";
import { isPastSlot } from "../past-slot";
import { Persistence } from "./persistence";
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
import { completionRequestId, reopenRequestId } from "./todoist";
import { TodoistError } from "./todoist-api";
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Prefer an authoritative, task-scoped read; a cached active listing can lag
// behind a create/rename. Providers without get() use a forced-fresh listing.
async function findTask(todoist: Todoist, taskId: string, projectId: string) {
  return todoist.get
    ? await todoist.get(taskId, projectId)
    : (await todoist.list(projectId, { fresh: true })).find(
        (task) => task.id === taskId && task.projectId === projectId,
      ) ?? null;
}
const settingsId = "00000000-0000-4000-8000-000000000001";
export class Store {
  readonly db;
  private writing: Promise<unknown> = Promise.resolve();
  constructor(path: string) {
    this.db = new Persistence(path);
  }
  // One writer within the application, including requests and worker acknowledgements.
  write<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.writing.then(fn);
    this.writing = result.catch(() => {});
    return result;
  }
  async seed(demo = true) {
    await this.write(() =>
      this.db.transaction((tx) => {
        if (tx.settingGet(settingsId)) return;
        if (!(tx.slotAll()[0])) {
          for (const [name, time] of [
            ["Breakfast", "08:00"],
            ["Lunch", "13:00"],
            ["Dinner", "19:00"],
            ...(!demo ? [["School snack", "16:00"]] : []),
          ]) {
            tx.slotInsert({ id: randomUUID(), name, time });
          }
        }
        if (demo && !(tx.libraryAll()[0]))
          for (const name of ["Idli & sambar", "Dal & rice", "Vegetable pasta"])
            tx.libraryInsert({ id: randomUUID(), name });
        tx.settingInsert({
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
    name = name.trim().replace(/\s+/g, " ");
    if (!name || name.length > 120)
      throw new Error("Use a meal name between 1 and 120 characters");
    return this.write(() =>
      this.db.transaction((tx) => {
        const existing = (tx.libraryAll()).find(
          (meal) => meal.name.toLowerCase() === name.toLowerCase(),
        );
        return (
          existing ?? tx.libraryInsert({ id: randomUUID(), name })
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
      this.db.transaction((tx) => {
        const existing = tx.outboxGet(input.requestId);
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
        const meal = tx.libraryGet(input.mealId);
        const slot = tx.slotGet(input.slotId);
        if (!meal || !slot) throw new Error("Meal or slot no longer exists");
        const payload: Placement = {
          mealId: meal.id,
          name: meal.name,
          slotId: slot.id,
          time: slot.time,
          date: input.date,
          projectId,
          // Decide once, at submission, whether this meal is already past.
          complete: isPastSlot(input.date, slot.time) || undefined,
        };
        return tx.outboxInsert({
          id: input.requestId,
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
  private lastProject = "";
  private observed = new Set<string>();
  private snapshots = new Map<string, import("../types").RemoteMeal[]>();
  async board(todoist: Todoist, week?: string): Promise<Omit<Board, "calendarUrl">> {
    let project = { id: this.lastProject, name: "Meals" };
    let remote = this.snapshots.get(week ?? "active") ?? [];
    let integrationError = "";
    try {
      project = await todoist.mealsProject();
      if (project.name !== "Meals")
        throw new Error("Configured project is not Meals");
      this.lastProject = project.id;
      remote = await todoist.list(project.id, { week });
      this.snapshots.set(week ?? "active", remote);
      while (this.snapshots.size > 8)
        this.snapshots.delete(this.snapshots.keys().next().value!);
    } catch (error) {
      integrationError =
        error instanceof Error ? error.message : "Todoist unavailable";
    }
    if (!project.id) {
      const pending = (this.db.outboxAll()).find(
        (row) => row.state === "pending",
      );
      if (pending)
        project.id = (JSON.parse(pending.payload) as Mutation).projectId;
    }
    return this.write(async () => {
      const settings = await this.settings();
      // Parse each outbox payload once; board polls run every few seconds.
      const operations = this.db
        .outboxAll()
        .map((row) => ({ ...row, data: JSON.parse(row.payload) as Mutation }))
        .filter((row) => row.data.projectId === project.id);
      const newestFirst = [...operations].sort(
        (a, b) => Number(b.confirmedAt) - Number(a.confirmedAt),
      );
      const cards: Card[] = remote
        .filter(
          (task) =>
            task.projectId === project.id &&
            !operations.some(
              (row) =>
                row.state === "saved" &&
                row.data.kind === "delete" &&
                row.remoteId === task.id &&
                Date.now() - Number(row.confirmedAt) < 120000,
            ),
        )
        .map((task) => {
          const op = newestFirst.find(
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
        const payload = op.data;
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
          completed: payload.complete === true,
          state: "pending",
          error: op.error,
          confirmedAt: 0,
        });
      }
      // Acknowledged writes may precede eventually consistent listings. Retain a
      // short overlay, then reconcile external edits/deletions from Todoist.
      const latest = new Map<string, (typeof operations)[number]>();
      for (const op of operations
        .filter((row) => row.state === "saved")
        .sort((a, b) => Number(a.confirmedAt) - Number(b.confirmedAt)))
        latest.set(op.remoteId, op);
      for (const op of latest.values()) {
        const payload = op.data;
        if (
          payload.kind === "delete" ||
          this.observed.has(op.id) ||
          Date.now() - Number(op.confirmedAt) >= 120000 ||
          operations.some(
            (row) => row.state === "pending" && row.data.taskId === op.remoteId,
          )
        )
          continue;
        const index = cards.findIndex((card) => card.id === op.remoteId);
        // A card at the destination confirms the write. A card completed
        // elsewhere was completed in Todoist after an ordinary change, so
        // provider truth wins; a meal moved while completed is still expected
        // to be completed, so only its position counts.
        if (
          index >= 0 &&
          ((cards[index].completed && !payload.complete) ||
            (cards[index].date === payload.date &&
              cards[index].time === payload.time))
        ) {
          this.observed.add(op.id);
          continue;
        }
        if (index >= 0) cards.splice(index, 1);
        cards.push({
          ...payload,
          id: op.remoteId,
          requestId: op.id,
          completed: payload.complete === true,
          state: "saved",
          error: "",
          confirmedAt: Number(op.confirmedAt),
        });
      }
      const slots = this.db.slotAll();
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
        integrationError,
        projectId: project.id,
        receivedRequests: operations.map((row) => row.id),
        library: sort(this.db.libraryAll(), settings.libraryOrder),
        slots: sortSlotsByTime(sort(slots, settings.slotOrder)),
        cards,
      };
    });
  }
  async settings(): Promise<Settings> {
    const row = this.db.settingGet(settingsId);
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
    const row = this.db.settingGet(settingsId);
    if (row)
      this.db.settingUpdate(settingsId, {
        value: JSON.stringify(settings),
      });
    else
      this.db.settingInsert({
        id: settingsId,
        value: JSON.stringify(settings),
      });
  }
  async renameLibrary(mealId: string, name: string) {
    if (!uuidPattern.test(mealId)) throw new Error("Invalid meal ID");
    name = name.trim();
    if (!name || name.length > 120) throw new Error("Meal name must be 1–120 characters");
    return this.write(async () => {
      const meals = this.db.libraryAll();
      if (!meals.some(meal => meal.id === mealId)) throw new Error("Meal not found");
      if (meals.some(meal => meal.id !== mealId && meal.name.toLowerCase() === name.toLowerCase()))
        throw new Error("A meal with this name already exists");
      this.db.libraryUpdate(mealId, { name });
    });
  }
  async removeLibrary(mealId: string) {
    if (!uuidPattern.test(mealId)) throw new Error("Invalid meal ID");
    await this.write(() =>
      this.db.libraryDelete(mealId),
    );
  }
  async shuffle() {
    return this.write(async () => {
      const order = (this.db.libraryAll()).map((meal) => meal.id);
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
      const existing = this.db.outboxGet(input.requestId);
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
      const operations = this.db.outboxAll();
      if (
        operations.some(
          (row) =>
            row.state === "pending" &&
            (JSON.parse(row.payload) as Mutation).taskId === input.taskId,
        )
      )
        throw new Error("Meal already has a pending change");
      // A cached active listing can lag behind a create/rename, which must never
      // block changing a meal the planner just acknowledged saving.
      const task = await findTask(todoist, input.taskId, project.id);
      if (!task)
        throw new Error("Meal is missing or does not belong to Meals");
      const slot = this.db.slotGet(input.slotId ?? "");
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
        // A completed meal is reopened to change it; a moved one is completed again.
        ...(task.completed ? { complete: true } : {}),
      };
      return this.enqueue(payload, input.requestId);
    });
  }
  private async enqueue(payload: Mutation, requestId: string = randomUUID()) {
    return this.db.outboxInsert({
      id: requestId,
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
      const row = this.db.outboxGet(requestId);
      if (
        !row ||
        project.name !== "Meals" ||
        (JSON.parse(row.payload) as Mutation).projectId !== project.id
      )
        throw new Error("Operation does not belong to Meals");
      if (row.state === "pending")
        this.db.outboxUpdate(row.id, {
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
    slots = sortSlotsByTime(slots);
    const project = await todoist.mealsProject();
    if (project.name !== "Meals") throw new Error("Meals project unavailable");
    return this.write(async () => {
      const settings = await this.settings();
      if (settings.revision !== revision)
        throw new Error("Settings changed elsewhere. Reload before saving");
      const old = this.db.slotAll();
      const operations = this.db.outboxAll();
      if (operations.some((row) => row.state === "pending"))
        throw new Error("Wait for pending meals before changing slots");
      const remote = await todoist.list(project.id, { fresh: true });
      for (const removed of old.filter(
        (slot) => !slots.some((next) => next.id === slot.id),
      )) {
        const times = [
          removed.time,
          ...Object.entries(settings.aliases)
            .filter(([, id]) => id === removed.id)
            .map(([time]) => time),
        ];
        if (remote.some((task) => !task.completed && times.includes(task.time)))
          throw new Error(
            `Move or complete active ${removed.name} meals before removing this slot`,
          );
      }
      const aliases: Record<string, string> = Object.fromEntries(
        Object.entries(settings.aliases).filter(([, id]) =>
          slots.some((slot) => slot.id === id),
        ),
      );
      this.db.transaction((tx) => {
        for (const slot of slots) {
          const previous = old.find((item) => item.id === slot.id);
          if (previous) {
            if (previous.time !== slot.time) aliases[previous.time] = slot.id;
            for (const task of remote.filter(
              (task) =>
                task.projectId === project.id &&
                !task.completed &&
                validDate(task.date) &&
                task.time !== slot.time &&
                (old.find((item) => item.time === task.time)?.id ??
                  settings.aliases[task.time]) === slot.id,
            )) {
              tx.outboxInsert({
                id: randomUUID(),
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
          tx.slotDelete(previous.id);
        for (const slot of slots)
          tx.slotInsert({
            ...slot,
            id: slot.id,
            name: slot.name.trim(),
          });
        const next = {
          ...settings,
          aliases,
          slotOrder: slots.map((slot) => slot.id),
          revision: revision + 1,
        };
        const row = tx.settingGet(settingsId);
        if (row)
          tx.settingUpdate(settingsId, {
            value: JSON.stringify(next),
          });
        else
          tx.settingInsert({
            id: settingsId,
            value: JSON.stringify(next),
          });
      });
      return this.settings();
    });
  }
  // Saved receipts only matter while a request can still be retried; keep a
  // week of them and drop the rest so board reads stay small.
  async prune(now = Date.now()) {
    await this.write(() =>
      this.db.transaction((tx) => tx.outboxPrune(now - 7 * 86400000)),
    );
  }
  async close() {
    await this.writing;
    this.db.close();
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
  private pruneTimer: ReturnType<typeof setInterval> | undefined;
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
      const prune = () => void this.store.prune().catch(console.error);
      prune();
      this.pruneTimer = setInterval(prune, 3600000);
      this.pruneTimer.unref();
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
      (this.store.db.outboxAll()).find(
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
          this.store.db.outboxUpdate(action.id, {
            attempted: String(Number(action.attempted) + 1),
          }),
        );
        if (payload.kind === "delete") {
          // Providers delete completed meals too (Todoist reopens first).
          await this.todoist.delete(payload.taskId!, project.id, action.id);
          // Success/404 is final acknowledgement. Never GET to validate a delete.
        } else {
          // A completed meal is reopened, moved, then completed again. Reading
          // current state first lets a retry after any partial step resume
          // without repeating or losing work.
          const current = await findTask(this.todoist, payload.taskId!, project.id);
          if (!current) throw new TodoistError("Meal no longer exists");
          const arrived =
            current.date === payload.date && current.time === payload.time;
          if (!(current.completed && arrived)) {
            if (current.completed)
              await this.todoist.reopen(current.id, project.id, reopenRequestId(action.id));
            const task = await this.todoist.move(
              { ...payload, taskId: payload.taskId! },
              action.id,
            );
            if (
              task.id !== payload.taskId ||
              task.projectId !== project.id ||
              task.date !== payload.date ||
              task.time !== payload.time
            )
              throw new TodoistError(
                "Todoist acknowledgement did not match move",
                true,
              );
            if (payload.complete || current.completed)
              await this.todoist.complete(task.id, project.id, completionRequestId(action.id));
          }
        }
        await this.store.write(() =>
          this.store.db.outboxUpdate(action.id, {
            state: "saved",
            remoteId: payload.taskId!,
            error: "",
            confirmedAt: String(Date.now()),
          }),
        );
        return;
      }
      const known =
        action.remoteId && this.todoist.get
          ? await this.todoist.get(action.remoteId, project.id)
          : null;
      let matches = known
        ? [known]
        : (await this.todoist.list(project.id, { fresh: true })).filter(
            (task) => task.requestId === action.id,
          );
      if (
        !matches.length &&
        Number(action.attempted) > 0 &&
        !this.todoist.allowCreateReplay
      )
        matches = (
          await this.todoist.list(project.id, {
            week: payload.date,
            fresh: true,
          })
        ).filter((task) => task.requestId === action.id);
      if (matches.length > 1)
        throw new TodoistError(
          "Duplicate placement markers require inspection",
          true,
        );
      if (
        !matches[0] &&
        Number(action.attempted) > 0 &&
        !this.todoist.allowCreateReplay
      )
        throw new TodoistError(
          "Create result uncertain; marker not visible yet. Inspect Meals before abandoning this request; no duplicate will be created.",
          true,
        );
      await this.store.write(() =>
        this.store.db.outboxUpdate(action.id, {
          attempted: String(Number(action.attempted) + 1),
        }),
      );
      // Injectable providers must implement request-id idempotency. Same ID on every retry.
      const task =
        matches[0] ?? (await this.todoist.create(payload, action.id));
      await this.store.write(() =>
        this.store.db.outboxUpdate(action.id, {
          remoteId: task.id,
        }),
      );
      if (
        task.projectId !== project.id ||
        task.requestId !== action.id ||
        task.name !== payload.name ||
        task.date !== payload.date ||
        task.time !== payload.time
      )
        throw new TodoistError(
          "Todoist acknowledgement did not match placement",
          true,
        );
      // A meal submitted for a past date/time is completed right after it is
      // created. The remote ID is already persisted above and completion is
      // idempotent, so a failed or lost completion acknowledgement retries
      // without ever creating a second task.
      if (payload.complete && !task.completed)
        await this.todoist.complete(
          task.id,
          project.id,
          completionRequestId(action.id),
        );
      await this.store.write(() =>
        this.store.db.outboxUpdate(action.id, {
          state: "saved",
          remoteId: task.id,
          error: "",
          confirmedAt: String(Date.now()),
        }),
      );
    } catch (error) {
      const delay = Math.max(
        error instanceof TodoistError ? error.retryAfterMs : 0,
        Math.min(30000, 500 * 2 ** Math.min(Number(action.attempted), 6)),
      );
      await this.store.write(() =>
        this.store.db.outboxUpdate(action.id, {
          ...(!payload.kind && error instanceof TodoistError && !error.uncertain
            ? { attempted: action.attempted }
            : {}),
          error: error instanceof Error ? error.message : "Sync failed",
          nextAt: String(Date.now() + delay),
        }),
      );
    }
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.timer = undefined;
    this.pruneTimer = undefined;
    await this.active;
  }
}
