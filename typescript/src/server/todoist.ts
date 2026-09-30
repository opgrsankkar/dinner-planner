import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Placement, RemoteMeal } from "../types";
export interface Todoist {
  mealsProject(): Promise<{ id: string; name: string }>;
  list(projectId: string): Promise<RemoteMeal[]>;
  create(input: Placement, requestId: string): Promise<RemoteMeal>;
}
// Separate file models the remote authority; never shares planner tables. No network client in this slice.
export class FakeTodoist implements Todoist {
  private db: DatabaseSync;
  createCalls = 0;
  failBefore = 0;
  loseResponse = 0;
  delayMs = 1200;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS tasks (request_id TEXT PRIMARY KEY, body TEXT NOT NULL)",
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
  close() {
    this.db.close();
  }
}
