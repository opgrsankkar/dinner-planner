# Dinner Planner agent instructions

Read `docs/agent-workflow.md` before working. That project-specific workflow overrides old migration notes.

- Single-user experimental pet project: TanStack Start, React, strict TypeScript, Node 26, direct SQLite via `node:sqlite`. The user approved removing Prisma; retain the rest of the stack.
- Any agent may write the code itself. There is no designated implementer model or harness; the user names a specific model/agent when they want one. Gemini/Antigravity review is waived; do not launch it or wait for reviewer approval.
- Carry work through to the end: implement, test, open the PR, merge, and deploy. A review or investigation that finds good fixes should implement, verify, merge and deploy them rather than stop at a report. Stop earlier only when the user explicitly asks for that.
- Start clean from master; do not reuse abandoned Luna migration code. Rewrite as idiomatic full-stack TypeScript covering the same functionality, not a Python-to-Node translation. Frontend components, routing, state, fetching, and API architecture may change freely. Preserve the accepted UI design/layout/styling and user-facing interaction intent, not frontend implementation. Discard generated implementation if it anchors the wrong architecture.
- In default/live mode, Todoist is authoritative for planned meals; local DB holds library/settings/slots/outbox/cache only. The user-authorized standalone `TODOIST_MODE=local` deployment stores planned meals and replay receipts in SQLite without accessing Todoist. Keep its database separate from live/fake deployments.
- One active writer; coherent commits; runnable vertical slices; no long dependent PR stack.
- The user has authorized PR publication, merge, and deployment for this project (see the deployment steps in `docs/agent-workflow.md`).
- Never read deployment secrets/data or access live Todoist. Tests use synthetic DBs and fake Todoist.
- Preserve stable request IDs, project ownership checks, retries and pending state. Successful DELETE/404 is acknowledgement, not followed by an immediate GET.
- Preserve small card spinner/check feedback, theme settings, settings Save/Revert, drag and non-drag alternatives.
- Run real tests/typecheck/build and report actual results. Keep code simple; avoid speculative generic frameworks. Do not claim model/harness execution that failed.
