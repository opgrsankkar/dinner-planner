import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store, Worker } from "../src/server/store";
import { FakeTodoist } from "../src/server/todoist";
import { handle, type App } from "../src/server/app";
let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "planner-slice-"));
  execFileSync(
    process.execPath,
    ["node_modules/prisma/dist/prisma.js", "db", "init"],
    {
      env: { ...process.env, PLANNER_DB: join(root, "template.sqlite") },
      stdio: "pipe",
    },
  );
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(root, "case-"));
  const path = join(directory, "planner.sqlite");
  await cp(join(root, "template.sqlite"), path);
  const store = new Store(path);
  await store.seed();
  const providerPath = join(directory, "provider.sqlite");
  const provider = new FakeTodoist(providerPath);
  provider.delayMs = 0;
  const worker = new Worker(store, provider);
  const board = await store.board(provider);
  const input = {
    requestId: randomUUID(),
    mealId: board.library[0].id,
    slotId: board.slots[0].id,
    date: "2026-10-01",
  };
  const project = await provider.mealsProject();
  return {
    store,
    provider,
    worker,
    input,
    project,
    path,
    providerPath,
    async close() {
      await worker.stop();
      await store.close();
      provider.close();
    },
  };
}
test("placement transaction survives reload and both application/provider restart", async () => {
  const f = await fixture();
  await f.store.place(f.input, f.project.id);
  const pending = await f.store.board(f.provider);
  assert.equal(pending.cards[0].state, "pending");
  assert.equal((await f.provider.list(f.project.id)).length, 0);
  await f.close();
  const store = new Store(f.path);
  const provider = new FakeTodoist(f.providerPath);
  provider.delayMs = 0;
  const worker = new Worker(store, provider);
  try {
    assert.equal(
      (await store.board(provider)).cards[0].requestId,
      f.input.requestId,
    );
    await worker.tick();
    const saved = (await store.board(provider)).cards[0];
    assert.equal(saved.state, "saved");
    assert.equal(saved.requestId, f.input.requestId);
    assert.ok(saved.confirmedAt > 0);
    assert.equal((await provider.list(f.project.id)).length, 1);
  } finally {
    await worker.stop();
    await store.close();
    provider.close();
  }
});
test("lost create response reconciles marker after restart without another create", async () => {
  const f = await fixture();
  await f.store.place(f.input, f.project.id);
  f.provider.loseResponse = 1;
  await f.worker.tick();
  assert.equal(f.provider.createCalls, 1);
  const pending = (await f.store.board(f.provider)).cards[0];
  assert.equal(pending.state, "pending");
  assert.match(pending.error, /response lost/);
  assert.equal((await f.provider.list(f.project.id)).length, 1);
  await f.close();
  const store = new Store(f.path);
  const provider = new FakeTodoist(f.providerPath);
  const worker = new Worker(store, provider);
  try {
    await new Promise((resolve) => setTimeout(resolve, 550));
    await worker.tick();
    assert.equal(provider.createCalls, 0);
    assert.equal((await provider.list(f.project.id)).length, 1);
    assert.equal((await store.board(provider)).cards[0].state, "saved");
  } finally {
    await worker.stop();
    await store.close();
    provider.close();
  }
});
test("failed provider response retains intent and retries with original request ID", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.project.id);
    f.provider.failBefore = 1;
    await f.worker.tick();
    assert.equal((await f.provider.list(f.project.id)).length, 0);
    assert.equal((await f.store.board(f.provider)).cards[0].state, "pending");
    await new Promise((resolve) => setTimeout(resolve, 550));
    await f.worker.tick();
    const remote = await f.provider.list(f.project.id);
    assert.equal(remote.length, 1);
    assert.equal(remote[0].requestId, f.input.requestId);
    await f.store.place(f.input, f.project.id);
    await f.worker.tick();
    assert.equal((await f.provider.list(f.project.id)).length, 1);
  } finally {
    await f.close();
  }
});
test("retry reuses request ID when uncertain create marker is temporarily invisible", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.project.id);
    const list = f.provider.list.bind(f.provider);
    const create = f.provider.create.bind(f.provider);
    const requests: string[] = [];
    f.provider.list = async () => [];
    f.provider.create = async (input, requestId) => {
      requests.push(requestId);
      return create(input, requestId);
    };
    f.provider.loseResponse = 1;
    await f.worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 550));
    await f.worker.tick();
    assert.deepEqual(requests, [f.input.requestId, f.input.requestId]);
    assert.equal((await list(f.project.id)).length, 1);
    assert.equal((await f.store.db.orm.Outbox.all())[0].state, "saved");
  } finally {
    await f.close();
  }
});

test("concurrent repeated placement is idempotent and altered reuse is rejected", async () => {
  const f = await fixture();
  try {
    await Promise.all(
      Array.from({ length: 5 }, () => f.store.place(f.input, f.project.id)),
    );
    assert.equal((await f.store.db.orm.Outbox.all()).length, 1);
    await assert.rejects(
      f.store.place({ ...f.input, date: "2026-10-02" }, f.project.id),
      /another placement/,
    );
    await Promise.all([f.worker.tick(), f.worker.tick()]);
    assert.equal(f.provider.createCalls, 1);
  } finally {
    await f.close();
  }
});
test("invalid library/slot causes no intent; rollback actually works", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.store.place({ ...f.input, mealId: randomUUID() }, f.project.id),
      /no longer exists/,
    );
    assert.equal((await f.store.db.orm.Outbox.all()).length, 0);
    await assert.rejects(
      f.store.db.transaction(async (tx) => {
        await tx.orm.Library.create({ name: "Rolled back" });
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.ok(
      !(await f.store.db.orm.Library.all()).some(
        (meal) => meal.name === "Rolled back",
      ),
    );
  } finally {
    await f.close();
  }
});
test("changed Meals project ownership prevents create; bad acknowledgement remains pending", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.project.id);
    f.provider.mealsProject = async () => ({
      id: "other-project",
      name: "Meals",
    });
    await f.worker.tick();
    assert.equal(f.provider.createCalls, 0);
    assert.match((await f.store.db.orm.Outbox.all())[0].error, /ownership/);
  } finally {
    await f.close();
  }
  const g = await fixture();
  try {
    await g.store.place(g.input, g.project.id);
    const create = g.provider.create.bind(g.provider);
    g.provider.create = async (input, requestId) => ({
      ...(await create(input, requestId)),
      projectId: "other-project",
    });
    await g.worker.tick();
    assert.equal((await g.store.db.orm.Outbox.all())[0].state, "pending");
    assert.match((await g.store.db.orm.Outbox.all())[0].error, /did not match/);
  } finally {
    await g.close();
  }
});
test("active meals come from provider, not saved outbox rows", async () => {
  const f = await fixture();
  try {
    await f.store.place(f.input, f.project.id);
    await f.worker.tick();
    f.provider.list = async () => [];
    assert.equal((await f.store.board(f.provider)).cards.length, 0);
  } finally {
    await f.close();
  }
});
test("login/session/logout, hostile hosts/origins, CSRF, expiry and wrong password", async () => {
  const f = await fixture();
  const current: App = {
    store: f.store,
    todoist: f.provider,
    worker: f.worker,
    password: randomUUID(),
    origin: "http://localhost:3000",
    loginFailures: { count: 0, resetAt: 0 },
  };
  const request = (
    path: string,
    method = "GET",
    body: unknown = {},
    headers: Record<string, string> = {},
  ) =>
    new Request(`${current.origin}${path}`, {
      method,
      headers: {
        ...(method === "GET"
          ? {}
          : { origin: current.origin, "Content-Type": "application/json" }),
        ...headers,
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.equal((await handle(request("/api/board"), current)).status, 401);
    assert.equal(
      (await handle(new Request("http://evil.test/api/health"), current))
        .status,
      403,
    );
    assert.equal(
      (
        await handle(
          request(
            "/api/login",
            "POST",
            { password: current.password },
            { origin: "http://evil.test" },
          ),
          current,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await handle(
          request("/api/login", "POST", { password: "incorrect-test-input" }),
          current,
        )
      ).status,
      401,
    );
    const login = await handle(
      request("/api/login", "POST", { password: current.password }),
      current,
    );
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const board = await (
      await handle(request("/api/board", "GET", {}, { cookie }), current)
    ).json();
    assert.ok(board.csrf);
    assert.equal(
      (await handle(request("/api/plan", "POST", f.input, { cookie }), current))
        .status,
      403,
    );
    const mutationHeaders = { cookie, "x-csrf-token": board.csrf };
    assert.equal(
      (
        await handle(
          request("/api/plan", "POST", f.input, mutationHeaders),
          current,
        )
      ).status,
      202,
    );
    assert.equal(
      (
        await handle(
          request("/api/logout", "POST", {}, mutationHeaders),
          current,
        )
      ).status,
      200,
    );
    assert.equal(
      (await handle(request("/api/board", "GET", {}, { cookie }), current))
        .status,
      401,
    );
    const session = await f.store.login();
    await f.store.db.orm.Session.where({ id: session.id }).update({
      expiresAt: "0",
    });
    assert.equal(await f.store.session(session.id), null);
  } finally {
    await f.close();
  }
});
