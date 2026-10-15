import { randomUUID } from "node:crypto";
import type { Placement, RemoteMeal } from "../types";
import type { Store } from "./store";
import { uuidPattern } from "./store";
import type { Todoist } from "./todoist";

const projectId = "local-meals";
type Id = `${string}-${string}-${string}-${string}-${string}`;
function id(value: string): Id {
  if (!uuidPattern.test(value)) throw new Error("Invalid local meal/request ID");
  return value as Id;
}
function checkProject(value: string) {
  if (value !== projectId) throw new Error("Local meal ownership changed");
}

// Uses the existing provider boundary and outbox, with the planner DB as authority.
// Each write and its replay receipt commit together, so restart cannot duplicate it.
export class LocalPlan implements Todoist {
  readonly allowCreateReplay = true;
  constructor(private store: Store) {}

  async mealsProject() {
    return { id: projectId, name: "Meals" };
  }
  async list(owner: string) {
    checkProject(owner);
    return (this.store.db.localMealAll()).map(
      (row) => JSON.parse(row.body) as RemoteMeal,
    );
  }
  async get(taskId: string, owner: string) {
    checkProject(owner);
    const row = this.store.db.localMealGet(id(taskId));
    return row ? JSON.parse(row.body) as RemoteMeal : null;
  }
  async create(input: Placement, requestId: string) {
    checkProject(input.projectId);
    return this.store.write(() => this.store.db.transaction(tx => {
      const receipt = tx.localReceiptGet(id(requestId));
      if (receipt) return JSON.parse(receipt.body) as RemoteMeal;
      const task: RemoteMeal = {
        id: randomUUID(), projectId, name: input.name, date: input.date,
        time: input.time, requestId,
      };
      tx.localMealInsert({ id: id(task.id), body: JSON.stringify(task) });
      tx.localReceiptInsert({ id: id(requestId), body: JSON.stringify(task) });
      return task;
    }));
  }
  async move(input: Placement & { taskId: string }, requestId: string) {
    checkProject(input.projectId);
    return this.store.write(() => this.store.db.transaction(tx => {
      const receipt = tx.localReceiptGet(id(requestId));
      if (receipt) return JSON.parse(receipt.body) as RemoteMeal;
      const row = tx.localMealGet(id(input.taskId));
      if (!row) throw new Error("Local meal no longer exists");
      const task = JSON.parse(row.body) as RemoteMeal;
      checkProject(task.projectId);
      const updated = { ...task, date: input.date, time: input.time };
      tx.localMealUpdate(row.id, { body: JSON.stringify(updated) });
      tx.localReceiptInsert({ id: id(requestId), body: JSON.stringify(updated) });
      return updated;
    }));
  }
  async delete(taskId: string, owner: string, requestId: string) {
    checkProject(owner);
    await this.store.write(() => this.store.db.transaction(tx => {
      if (tx.localReceiptGet(id(requestId))) return;
      const row = tx.localMealGet(id(taskId));
      if (row) {
        checkProject((JSON.parse(row.body) as RemoteMeal).projectId);
        tx.localMealDelete(row.id);
      }
      tx.localReceiptInsert({ id: id(requestId), body: "null" });
    }));
  }
}
