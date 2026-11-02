// Renders the PNG app icons from public/icons/icon.svg. Run after editing the SVG.
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";

const svg = await readFile(new URL("../public/icons/icon.svg", import.meta.url), "utf8");
// Manifest icons keep the maskable safe zone; the favicon and the iOS icon
// (which iOS only rounds) are cropped tighter so the card reads at small sizes.
const icons: [name: string, size: number, viewBox: string][] = [
  ["icon-192.png", 192, "0 0 512 512"],
  ["icon-512.png", 512, "0 0 512 512"],
  ["apple-touch-icon.png", 180, "73 69 360 360"],
  ["favicon-32.png", 32, "123 119 260 260"],
];
const browser = await chromium.launch();
for (const [name, size, viewBox] of icons) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>*{margin:0}svg{display:block;width:100vw;height:100vh}</style>${svg.replace('viewBox="0 0 512 512"', `viewBox="${viewBox}"`)}`);
  await page.screenshot({ path: new URL(`../public/icons/${name}`, import.meta.url).pathname });
  await page.close();
}
await browser.close();
