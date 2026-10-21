import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
// app.css is served from /static with a one-hour cache; versioning its URL by
// content makes each deploy's stylesheet load at once.
const cssVersion = createHash("sha256").update(readFileSync(new URL("public/static/app.css", import.meta.url))).digest("hex").slice(0, 10);
export default defineConfig({
  plugins: [tanstackStart(), react()],
  define: { __CSS_VERSION__: JSON.stringify(cssVersion) },
  server: { host: "127.0.0.1", port: 3000, strictPort: true },
});
