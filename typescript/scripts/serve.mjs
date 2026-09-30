import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFile, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, extname, sep } from "node:path";
import { execFileSync } from "node:child_process";

const db = resolve(
  process.env.DATABASE_PATH ??
    process.env.PLANNER_DB ??
    ".local/planner.sqlite",
);
await mkdir(dirname(db), { recursive: true });
if (!existsSync(db))
  execFileSync(
    process.execPath,
    ["node_modules/prisma/dist/prisma.js", "db", "init"],
    {
      env: { ...process.env, DATABASE_PATH: db, PLANNER_DB: db },
      stdio: "inherit",
    },
  );
if (!(process.env.APP_PASSWORD ?? process.env.PLANNER_PASSWORD))
  throw new Error("APP_PASSWORD is required");
if (
  process.env.TODOIST_MODE !== "fake" &&
  !process.env.TODOIST_TOKEN &&
  !process.env.TODOIST_TOKEN_FILE
)
  throw new Error(
    "Todoist credentials are required; demo requires TODOIST_MODE=fake",
  );
const { default: handler } = await import("../dist/server/server.js");
const root = resolve("dist/client");
const mime = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host ?? "";
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    const allowed = process.env.ALLOWED_HOSTS?.split(",").map((value) =>
      value.trim(),
    );
    if (allowed && !allowed.includes(url.hostname)) {
      res.writeHead(403);
      res.end("Unrecognized host");
      return;
    }
    const file = resolve(root, "." + decodeURIComponent(url.pathname));
    if (
      file.startsWith(root + sep) &&
      existsSync(file) &&
      (await stat(file)).isFile()
    ) {
      if (!["GET", "HEAD"].includes(req.method ?? "")) {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": mime[extname(file)] ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": url.pathname.startsWith("/assets/")
          ? "public,max-age=31536000,immutable"
          : "public,max-age=3600",
      });
      res.end(req.method === "HEAD" ? undefined : await readFile(file));
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (value)
        for (const item of Array.isArray(value) ? value : [value])
          headers.append(name, item);
    // The bridge proxy owns forwarded protocol. Host is still checked above.
    const protocol = process.env.COOKIE_SECURE === "true" ? "https:" : "http:";
    url.protocol = protocol;
    const request = new Request(url, {
      method: req.method,
      headers,
      ...(["GET", "HEAD"].includes(req.method ?? "")
        ? {}
        : { body: Readable.toWeb(req), duplex: "half" }),
    });
    const response = await handler.fetch(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key !== "set-cookie") res.setHeader(key, value);
    });
    if (response.headers.getSetCookie().length)
      res.setHeader("set-cookie", response.headers.getSetCookie());
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch {
    res.writeHead(500);
    res.end("Request failed");
  }
});
server.listen(
  Number(process.env.PORT ?? 8789),
  process.env.HOST ?? "0.0.0.0",
  () => console.log("Dinner Planner HTTP server ready"),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 20000).unref();
  });
