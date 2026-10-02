# Issue #31 comparison candidate

Model/effort: `gpt-6.1-sol` / `medium` (assigned session).
Branch: `comparison/easy-sol-31`. Base: `3ee0021f0b1e9361751c2e33ab6cf7929fc4dc00` (`origin/master` at start).

Removed only the visible Name/Time heading row and its desktop/mobile CSS rules.
The input grids need no adjustment: they independently define their tracks.
The Meal slots heading, numeric prefixes, individual hidden labels, and editing
handlers remain intact. The existing slot browser smoke gained focused assertions
for heading removal, preserved labels/numbers, and Tab navigation/name Revert.

Commands executed from `typescript/` using Node `v26.10.0` and npm `11.19.1`:

| Command | Actual result |
| --- | --- |
| `npm ci` | Passed; 477 packages installed from lockfile. Reported 13 dependency vulnerabilities (5 moderate, 8 high) and uncovered esbuild/workerd install-script notices. No dependency changes made. |
| `npm run build` (before UI fix, after regression assertions) | Passed. |
| `SLOT_VIDEO_DIR="$PWD/.local/easy-comparison/pre-fix" npx tsx scripts/folio-slots-smoke.ts` | Expected failure, exit 1: `No Name/Time column heading row`, actual 1, expected 0. |
| `npm run typecheck` | Passed, exit 0. |
| `npm test` | Passed: 37 tests, 0 failures/skips. |
| `npm run build` (after UI fix) | Passed: client and SSR production bundles. |
| `SLOT_VIDEO_DIR="$PWD/.local/easy-comparison/post-fix" npx tsx scripts/folio-slots-smoke.ts` | Passed, exit 0: 375/390/1280px responsive desktop contexts and 375/390px touch-mobile contexts. |
| `git diff --check` | Passed. |

Browser verification ran the production application through `scripts/serve.mjs`,
with generated authentication, isolated synthetic SQLite databases, and fake
Todoist. It exercised label lookup, keyboard Tab, name editing/Revert, time edits
and chronological sorting, Add/delete, Save failure/retry, persisted save after
reload, and reduced motion. Save/Revert/Add remain on one line; no horizontal
overflow or browser page errors were reported. The save-failure case uses a
synthetic intercepted 503; the successful save runs through the real app backend.

Screenshots/videos are ignored local artifacts under
`typescript/.local/easy-comparison/post-fix/`, including `slots-1280.png`,
`slots-375.png`, `slots-390.png`, `slots-375-mobile.png`, and
`slots-390-mobile.png`, with retry/reduced-motion screenshots and interaction videos.
Desktop and 375px responsive/touch screenshots were visually inspected: no column
heading row, retained section heading/prefixes, and aligned usable fields/actions.

Limitations: Chromium only, with mobile emulation rather than physical devices.
Native partial time-segment typing is skipped in the two touch contexts because
they expose a picker; it passed at all three responsive desktop widths. No live
services, deployment data, merge, deployment, or reviewer feedback repair loop.

Comparison candidate; do not merge until user chooses.
