# Dinner Planner agent instructions

Read `docs/agent-workflow.md` before working. That project-specific workflow overrides old migration notes.

- Single-user experimental pet project: TanStack Start, React, strict TypeScript, Node 26, direct SQLite via `node:sqlite`. The user approved removing Prisma; retain the rest of the stack.
- Any agent may write the code itself. There is no designated implementer model or harness; the user names a specific model/agent when they want one. Gemini/Antigravity review is waived; do not launch it or wait for reviewer approval.
- Carry work through to the end: implement, test, open the PR, merge, and deploy. A review or investigation that finds good fixes should implement, verify, merge and deploy them rather than stop at a report. Stop earlier only when the user explicitly asks for that.
- Start clean from master; do not reuse abandoned Luna migration code. Rewrite as idiomatic full-stack TypeScript covering the same functionality, not a Python-to-Node translation. Frontend components, routing, state, fetching, and API architecture may change freely. Preserve the accepted UI design/layout/styling and user-facing interaction intent, not frontend implementation. Discard generated implementation if it anchors the wrong architecture.
- SQLite is the only store: each change is one transaction made while its request is handled (no outbox, worker or Todoist provider; removed by user decision 2026-11-13, schema v3). There is no login; Caddy admits only LAN/tailnet, plus the token-protected calendar feed.
- One active writer; coherent commits; runnable vertical slices; no long dependent PR stack.
- The user has authorized PR publication, merge, and deployment for this project (see the deployment steps in `docs/agent-workflow.md`).
- Never read deployment secrets/data. Tests use synthetic databases.
- Preserve stable request IDs (a placement's request ID is its planned meal's id, which makes retries safe), idempotent move/delete (deleting a missing meal succeeds), and the client-side pending/retry state. Do not reintroduce a write queue or worker.
- Preserve small card spinner/check feedback, theme settings, settings Save/Revert, drag and non-drag alternatives.
- Run real tests/typecheck/build and report actual results. Keep code simple; avoid speculative generic frameworks. Do not claim model/harness execution that failed.
