# Dinner Planner agent instructions

Read `docs/agent-workflow.md` before working. That project-specific workflow overrides old migration notes.

- Single-user experimental pet project: TanStack Start, React, strict TypeScript, Node 26, Prisma ORM 8, SQLite. Experimental SQLite support is accepted; do not change the stack.
- Codex `gpt-6.1-sol` at `low` actually writes code. Hermes/Sol orchestrates; Gemini via Antigravity reviews.
- Start clean from master; do not reuse abandoned Luna migration code. Rewrite as idiomatic full-stack TypeScript covering the same functionality, not a Python-to-Node translation. Frontend components, routing, state, fetching, and API architecture may change freely. Preserve the accepted UI design/layout/styling and user-facing interaction intent, not frontend implementation. Discard generated implementation if it anchors the wrong architecture.
- Todoist is authoritative for planned meals. Local DB holds library/settings/slots/outbox/cache only.
- One active writer; coherent commits; runnable vertical slices; no long dependent PR stack.
- User authorizes completion, PR publication, merge, and deployment. Hermes handles review and deployment; implementation agents must stop at the boundary specified in their task.
- Never read deployment secrets/data, access live Todoist, deploy, or merge unless your particular task explicitly permits it. Tests use synthetic DBs and fake Todoist.
- Preserve stable request IDs, project ownership checks, retries and pending state. Successful DELETE/404 is acknowledgement, not followed by an immediate GET.
- Preserve small card spinner/check feedback, theme settings, settings Save/Revert, drag and non-drag alternatives.
- Run real tests/typecheck/build and report actual results. Keep code simple; avoid speculative generic frameworks. Do not claim model/harness execution that failed.
