import type { Placement, RemoteMeal } from "../types";
import type { Todoist } from "./todoist";

const base = "https://api.todoist.com/api/v1";
const marker = "meal-planner-request-id: ";
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TodoistError("Todoist returned an invalid response");
  return value as ObjectValue;
}
function required(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new TodoistError("Todoist returned an invalid ID or content");
  return value;
}
export class TodoistError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
    readonly retryAfterMs = 30000,
  ) {
    super(message);
  }
}
// v1 uses due.date for both dates and datetimes; older datetime payloads are also accepted.
export function remoteMeal(value: unknown, completed = false): RemoteMeal {
  const task = object(value);
  const due = task.due ? object(task.due) : {};
  const raw = String(due.datetime ?? due.date ?? "");
  let date = "",
    time = "",
    dueError = "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && validDay(raw)) {
    date = raw;
    dueError = "No due time";
  } else if (
    /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(
      raw,
    ) &&
    validDay(raw.slice(0, 10))
  ) {
    const floating = !/(Z|[+-]\d{2}:\d{2})$/.test(raw);
    if (floating && due.timezone && due.timezone !== "Asia/Kolkata") {
      date = raw.slice(0, 10);
      dueError = "Unsupported floating due timezone";
    } else {
      const instant = new Date(floating ? raw + "+05:30" : raw);
      if (Number.isFinite(instant.getTime())) {
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Kolkata",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).formatToParts(instant);
        const part = (name: string) =>
          parts.find((p) => p.type === name)!.value;
        date = `${part("year")}-${part("month")}-${part("day")}`;
        time = `${part("hour")}:${part("minute")}`;
      } else dueError = "Invalid due date/time";
    }
  } else dueError = raw ? "Invalid due date/time" : "No due date/time";
  const description =
    typeof task.description === "string" ? task.description : "";
  const requestId =
    description
      .split(/\r?\n/)
      .find((line) => line.startsWith(marker))
      ?.slice(marker.length) ?? "";
  return {
    id: required(task.id),
    projectId: required(task.project_id),
    name: required(task.content),
    date,
    time,
    requestId,
    description,
    completed: completed || task.checked === true || !!task.completed_at,
    dueError,
  };
}
function validDay(day: string) {
  const parsed = new Date(day + "T12:00:00Z");
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === day
  );
}
function due(input: Placement) {
  if (!validDay(input.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time))
    throw new TodoistError("Invalid placement date/time");
  // Current v1 create/update schema has no due_timezone field. RFC3339 offset
  // expresses Asia/Kolkata exactly, without relying on the account timezone.
  return { due_datetime: `${input.date}T${input.time}:00+05:30` };
}
export class TodoistApi implements Todoist {
  private project?: { value: { id: string; name: string }; until: number };
  private projectFlight?: Promise<{ id: string; name: string }>;
  private cache = new Map<
    string,
    {
      value?: RemoteMeal[];
      until: number;
      error?: unknown;
      flight?: Promise<RemoteMeal[]>;
    }
  >();
  private blockedUntil = 0;
  private projectError?: { error: unknown; until: number };
  constructor(
    private token: string,
    private fetcher: typeof fetch = fetch,
    private now = Date.now,
    private timeoutMs = 15000,
  ) {
    if (!token.trim()) throw new Error("Todoist token is required");
  }
  private async request(
    path: string,
    method = "GET",
    body?: unknown,
    requestId?: string,
    missing = false,
  ): Promise<unknown> {
    if (this.now() < this.blockedUntil)
      throw new TodoistError(
        "Todoist rate limited; waiting before retry",
        false,
        this.blockedUntil - this.now(),
      );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(base + path, {
        method,
        signal: controller.signal,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(requestId ? { "X-Request-Id": requestId } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 404 && missing) return null;
      if (!response.ok) {
        const retry = response.headers.get("Retry-After");
        const seconds = retry ? Number(retry) : NaN;
        const delay = Number.isFinite(seconds)
          ? seconds * 1000
          : retry
            ? Date.parse(retry) - this.now()
            : 30000;
        if (response.status === 429)
          this.blockedUntil = this.now() + Math.max(1000, delay || 30000);
        // Never surface response bodies or transport messages: they may echo credentials.
        throw new TodoistError(
          `Todoist request failed (${response.status})`,
          method !== "GET" &&
            (response.status >= 500 ||
              response.status === 408 ||
              response.status === 409),
          response.status === 429 ? Math.max(1000, delay || 30000) : 30000,
        );
      }
      if (response.status === 204) return null;
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new TodoistError(
          "Todoist returned invalid JSON",
          method !== "GET",
        );
      }
    } catch (error) {
      if (error instanceof TodoistError) throw error;
      throw new TodoistError(
        "Todoist connection failed or timed out",
        method !== "GET",
      );
    } finally {
      clearTimeout(timer);
    }
  }
  private async pages(
    path: string,
    params: Record<string, string> = {},
    completed = false,
  ): Promise<unknown[]> {
    const results: unknown[] = [],
      seen = new Set<string>();
    let cursor = "";
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({
        ...params,
        limit: "200",
        ...(cursor ? { cursor } : {}),
      });
      const payload = object(await this.request(`${path}?${query}`));
      const items = payload[completed ? "items" : "results"];
      if (!Array.isArray(items))
        throw new TodoistError("Todoist returned an invalid page");
      results.push(...items);
      if (payload.next_cursor == null || payload.next_cursor === "")
        return results;
      cursor = required(payload.next_cursor);
      if (seen.has(cursor))
        throw new TodoistError("Todoist repeated a pagination cursor");
      seen.add(cursor);
    }
    throw new TodoistError("Todoist pagination exceeded safety limit");
  }
  async mealsProject() {
    if (this.projectError && this.projectError.until > this.now())
      throw this.projectError.error;
    if (this.project && this.project.until > this.now())
      return this.project.value;
    return (this.projectFlight ??= this.pages("/projects")
      .then((items) => {
        const matches = items
          .map(object)
          .filter((p) => p.name === "Meals" && !p.is_deleted && !p.is_archived);
        if (matches.length !== 1)
          throw new TodoistError(
            `Expected exactly one Todoist project named Meals; found ${matches.length}`,
          );
        const value = { id: required(matches[0].id), name: "Meals" };
        this.project = { value, until: this.now() + 60000 };
        return value;
      })
      .catch((error) => {
        this.projectError = { error, until: this.now() + 15000 };
        throw error;
      })
      .finally(() => {
        this.projectFlight = undefined;
      }));
  }
  async list(
    projectId: string,
    options: { week?: string; fresh?: boolean } = {},
  ) {
    const key = projectId + ":" + (options.week ?? "active");
    const existing = this.cache.get(key);
    if (existing?.error && existing.until > this.now()) throw existing.error;
    if (!options.fresh && existing?.value && existing.until > this.now())
      return existing.value;
    if (existing?.flight) return existing.flight;
    const entry = existing ?? { until: 0 };
    this.cache.set(key, entry);
    entry.flight = (async () => {
      const active = options.week
        ? await this.list(projectId)
        : (await this.pages("/tasks", { project_id: projectId })).map((t) =>
            remoteMeal(t),
          );
      let history: RemoteMeal[] = [];
      if (options.week) {
        if (!validDay(options.week))
          throw new TodoistError("Invalid history week");
        const start = new Date(options.week + "T00:00:00+05:30");
        const end = new Date(start.getTime() + 7 * 86400000);
        history = (
          await this.pages(
            "/tasks/completed/by_due_date",
            {
              project_id: projectId,
              since: start.toISOString(),
              until: end.toISOString(),
            },
            true,
          )
        ).map((t) => remoteMeal(t, true));
      }
      const tasks = new Map<string, RemoteMeal>();
      for (const task of [...history, ...active])
        if (task.projectId === projectId) tasks.set(task.id, task);
      entry.error = undefined;
      entry.value = [...tasks.values()];
      entry.until = this.now() + (options.week ? 60000 : 15000);
      while (this.cache.size > 10)
        this.cache.delete(this.cache.keys().next().value!);
      return entry.value;
    })()
      .catch((error) => {
        entry.error = error;
        entry.until = this.now() + 15000;
        throw error;
      })
      .finally(() => {
        entry.flight = undefined;
      });
    return entry.flight;
  }
  async get(taskId: string, projectId: string): Promise<RemoteMeal | null> {
    const value = await this.request(
      `/tasks/${encodeURIComponent(taskId)}`,
      "GET",
      undefined,
      undefined,
      true,
    );
    if (!value) return null;
    const task = remoteMeal(value);
    if (task.projectId !== projectId || task.id !== taskId)
      throw new TodoistError(
        "Task no longer belongs to Meals or task ID did not match",
      );
    return task;
  }
  async create(input: Placement, requestId: string) {
    if ((await this.mealsProject()).id !== input.projectId)
      throw new TodoistError("Meals project ownership changed");
    const value = await this.request(
      "/tasks",
      "POST",
      {
        content: input.name,
        project_id: input.projectId,
        description: marker + requestId,
        ...due(input),
      },
      requestId,
    );
    try {
      return remoteMeal(value);
    } catch {
      throw new TodoistError(
        "Create acknowledgement invalid; result is uncertain",
        true,
      );
    }
  }
  async move(input: Placement & { taskId: string }, requestId: string) {
    const task = await this.get(input.taskId, input.projectId);
    if (!task || task.completed)
      throw new TodoistError("Task is missing or completed");
    // Omit description/content: moving a meal must preserve all existing notes.
    const value = await this.request(
      `/tasks/${encodeURIComponent(input.taskId)}`,
      "POST",
      due(input),
      requestId,
    );
    const updated = value
      ? remoteMeal(value)
      : await this.get(input.taskId, input.projectId);
    if (!updated) throw new TodoistError("Moved task is not readable yet");
    return updated;
  }
  async delete(taskId: string, projectId: string, requestId: string) {
    const task = await this.get(taskId, projectId);
    if (!task) return;
    if (task.completed)
      throw new TodoistError("Completed meals cannot be deleted");
    await this.request(
      `/tasks/${encodeURIComponent(taskId)}`,
      "DELETE",
      undefined,
      requestId,
      true,
    );
  }
}
