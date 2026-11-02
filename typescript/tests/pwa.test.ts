import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const publicFile = (path: string) => new URL(`../public${path}`, import.meta.url);

function pngSize(path: string) {
  const data = readFileSync(publicFile(path));
  assert.equal(data.subarray(1, 4).toString("ascii"), "PNG", `${path} is not a PNG`);
  return `${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`;
}

test("manifest is installable and every icon matches its declared type and size", () => {
  const manifest = JSON.parse(readFileSync(publicFile("/manifest.webmanifest"), "utf8"));
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.name && manifest.short_name);
  const icons: { src: string; sizes: string; type: string; purpose: string }[] = manifest.icons;
  for (const icon of icons) {
    assert.ok(existsSync(publicFile(icon.src)), `${icon.src} is missing`);
    if (icon.type === "image/png") assert.equal(pngSize(icon.src), icon.sizes, icon.src);
    else assert.match(readFileSync(publicFile(icon.src), "utf8"), /^<svg /, icon.src);
  }
  for (const size of ["192x192", "512x512"])
    for (const purpose of ["any", "maskable"])
      assert.ok(icons.some((icon) => icon.sizes === size && icon.purpose === purpose), `${size} ${purpose}`);
  assert.equal(pngSize("/icons/apple-touch-icon.png"), "180x180");
  assert.equal(pngSize("/icons/favicon-32.png"), "32x32");
});

test("service worker handles navigations only and precaches just the offline page", () => {
  const worker = readFileSync(publicFile("/service-worker.js"), "utf8");
  assert.match(worker, /request\.mode !== "navigate"\) return;/);
  assert.doesNotMatch(worker, /cache\.put|addAll/);
  assert.ok(existsSync(publicFile("/offline.html")));
});
