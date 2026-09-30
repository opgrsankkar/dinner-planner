import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Placement, RemoteMeal } from "../types";
// Providers enforce task project ownership before writes, durable request-ID
// idempotency, and delete success/404 acknowledgement without a follow-up read.
export interface Todoist {
  mealsProject(): Promise<{ id: string; name: string }>;
  list(projectId: string): Promise<RemoteMeal[]>;
  move(
    input: Placement & { taskId: string },
    requestId: string,
  ): Promise<RemoteMeal>;
  delete(taskId: string, projectId: string, requestId: string): Promise<void>;
  create(input: Placement, requestId: string): Promise<RemoteMeal>;
}
// Separate file models the remote authority; never shares planner tables. No network client in this slice.
export class FakeTodoist implements Todoist {
  private db: DatabaseSync;
  createCalls = 0;
  moveCalls = 0;
  moveFailBefore = 0;
  deleteFailBefore = 0;
  deleteCalls = 0;
  failBefore = 0;
  loseResponse = 0;
  delayMs = 1200;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS tasks (request_id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    );
  }
  async mealsProject() {
    return { id: "fake-meals-project", name: "Meals" };
  }
  async list(projectId: string) {
    return (
      this.db.prepare("SELECT body FROM tasks").all() as { body: string }[]
    )
      .map((row) => JSON.parse(row.body) as RemoteMeal)
      .filter((task) => task.projectId === projectId);
  }
  async create(input: Placement, requestId: string) {
    this.createCalls++;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failBefore > 0) {
      this.failBefore--;
      throw new Error("Fake Todoist unavailable before write");
    }
    const existing = this.db
      .prepare("SELECT body FROM tasks WHERE request_id = ?")
      .get(requestId) as { body: string } | undefined;
    const task: RemoteMeal = existing
      ? JSON.parse(existing.body)
      : {
          id: randomUUID(),
          projectId: input.projectId,
          name: input.name,
          date: input.date,
          time: input.time,
          requestId,
        };
    if (!existing)
      this.db
        .prepare("INSERT INTO tasks VALUES (?, ?)")
        .run(requestId, JSON.stringify(task));
    if (this.loseResponse > 0) {
      this.loseResponse--;
      throw new Error("Fake Todoist response lost after write");
    }
    return task;
  }
  private async mutate<T>(requestId: string, execute: () => T): Promise<T> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const receipt = this.db
      .prepare("SELECT body FROM receipts WHERE id = ?")
      .get(requestId) as { body: string } | undefined;
    if (receipt) return JSON.parse(receipt.body) as T;
    if (this.failBefore > 0) {
      this.failBefore--;
      throw new Error("Fake Todoist unavailable before write");
    }
    this.db.exec("BEGIN");
    let result: T;
    try {
      result = execute();
      this.db
        .prepare("INSERT INTO receipts VALUES (?, ?)")
        .run(requestId, JSON.stringify(result));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (this.loseResponse > 0) {
      this.loseResponse--;
      throw new Error("Fake Todoist response lost after write");
    }
    return result;
  }
  async move(input: Placement & { taskId: string }, requestId: string) {
    this.moveCalls++;
    if (this.moveFailBefore > 0) {
      this.moveFailBefore--;
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      throw new Error("Fake Todoist move unavailable");
    }
    return this.mutate(requestId, () => {
      const tasks = this.db
        .prepare("SELECT request_id, body FROM tasks")
        .all() as { request_id: string; body: string }[];
      const row = tasks.find(
        (row) => (JSON.parse(row.body) as RemoteMeal).id === input.taskId,
      );
      if (!row) throw new Error("Task no longer exists");
      const task = JSON.parse(row.body) as RemoteMeal;
      if (task.projectId !== input.projectId)
        throw new Error("Task ownership changed");
      const updated = { ...task, date: input.date, time: input.time };
      this.db
        .prepare("UPDATE tasks SET body = ? WHERE request_id = ?")
        .run(JSON.stringify(updated), row.request_id);
      return updated;
    });
  }
  async delete(
    taskId: string,
    projectId: string,
    requestId: string,
  ): Promise<void> {
    this.deleteCalls++;
    if (this.deleteFailBefore > 0) {
      this.deleteFailBefore--;
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      throw new Error("Fake Todoist delete unavailable");
    }
    await this.mutate(requestId, () => {
      const rows = this.db
        .prepare("SELECT request_id, body FROM tasks")
        .all() as { request_id: string; body: string }[];
      const row = rows.find(
        (row) => (JSON.parse(row.body) as RemoteMeal).id === taskId,
      );
      if (row) {
        if ((JSON.parse(row.body) as RemoteMeal).projectId !== projectId)
          throw new Error("Task ownership changed");
        this.db
          .prepare("DELETE FROM tasks WHERE request_id = ?")
          .run(row.request_id);
      }
      // Missing task is a successful 404 acknowledgement.
      return null;
    });
  }
  close() {
    this.db.close();
  }
}
