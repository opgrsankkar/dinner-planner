# Dinner Planner: authoritative project workflow

## Scope and precedence

Use for `opgrsankkar/dinner-planner` and its self-hosted site `https://meals.happydaysblr.ddns.net`. This project-specific workflow supersedes the old Luna/xhigh stacked-PR workflow and older migration notes requiring user review, prohibiting merge/deployment, or treating experimental dependencies as blockers. It does not change workflows for other projects. The user's latest instructions always take precedence.

## Goal and tolerance

This is a single-user pet project for experimenting, not a production-hardening programme. Complete the full-stack TypeScript migration and deliver a working site. Keep checks proportionate; do not spend milestones proving experimental tooling suitable for enterprise production. Rewrite the application as idiomatic full-stack TypeScript that covers the same user functionality; do not translate Python line-by-line or preserve backend/API/frontend implementation structures merely for parity. Frontend components, state management, data fetching, routing, and interactions' internal implementation may be rewritten as needed. Preserve the accepted UI design (visual layout, styling, appearance, and user-facing interaction intent); preserving frontend code is not a requirement. Existing source and tests are behavior references, not architecture constraints.

## Stack

- TanStack Start, React, strict TypeScript.
- Node.js 26, Prisma ORM 8, SQLite. Experimental Prisma SQLite support is explicitly acceptable. Do not substitute Node LTS, Drizzle, PostgreSQL, or another stack without user agreement.
- Todoist remains authoritative for planned meals. SQLite owns settings, reusable meal library, slots, durable outbox, and temporary cache/optimistic state.
- Retain self-hosted Docker Compose and Caddy deployment unless a concrete implementation requirement warrants a scoped change.

## Team and execution

- Hermes/Sol orchestrates architecture, bounded tasks, independent verification, review fixes, merge, and deployment.
- Codex CLI agents actually write the code using exact model `gpt-6.1-sol` and reasoning effort `low`. Use a fresh concise conversation per coherent milestone, reusing it for that milestone's fixes. One active writer per worktree.
- Gemini through Antigravity (`agy`) reviews the exact implementation diff. Inspect the harness's actual Gemini model and report it honestly; do not silently substitute a non-Gemini reviewer.
- Confirm actual model/effort and working harness before delegation. If auth, sandbox, or model invocation fails, fix the concrete blocker or report it; do not silently implement through a different model/harness and attribute it to Codex.
- Use bounded tasks/timeouts and completion notifications. No endless agent polling, recursive agent spawning, history-heavy unrelated conversations, or open-ended improvement loops. Ask before escalating model effort or incurring materially greater cost beyond the agreed work.

## Restart and development sequence

1. Inspect live GitHub and local worktrees before cleanup. The abandoned Luna migration was a stacked set of PRs #5 through #11 and `migration/*` branches, last observed at `migration/todoist-write-client`; re-read state rather than assuming these observations remain current.
2. Close abandoned migration PRs and remove their migration branches under the user's authorization. Preserve unrelated branches, merged work, deployment data, and the currently running app. Preserve a local git bundle or equivalent rollback record of abandoned commits before deleting refs; do not reuse rejected code as the new branch base.
3. Create one fresh migration branch from updated `master` in a separate development checkout. Keep project-local `AGENTS.md` aligned with this reference so Codex and reviewers receive the same rules.
4. Prefer coherent commits and one integration PR, not another long unmerged tower of dependent PRs. Build a runnable vertical slice early: login, weekly board, place meal, immediate feedback, durable outbox, and background sync acknowledgement. Use fake Todoist with delays/errors during development.
5. Complete move/delete/retry/restart recovery, settings/library/slot behavior, history/reconciliation, and remaining parity. Keep interfaces and modules simple; avoid speculative abstractions and generic frameworks.
6. Gemini reviews meaningful milestones; Hermes evaluates findings, directs fixes, and verifies the corrected result. Reviewer approval is not a substitute for executing checks.

## Verification and deployment

- Run clean dependency installation, typecheck, relevant tests, production build/container checks, and real desktop/mobile browser interactions. Check actual drag and non-drag alternatives, settings save/revert, and small per-card spinner/check feedback.
- Exercise delayed/failed Todoist responses, retries, reloads, and worker restarts. Protect stable request IDs, project ownership, and duplicate-write prevention. Successful DELETE/404 is acknowledgement; do not immediately GET after deletion and misread stale provider state.
- Keep passwords and Todoist credentials server-side and out of agent logs, prompts, commits, and review output. Retain proportionate authentication and mutation protections.
- Before live cutover, take a consistent SQLite backup, retain the old deployable artifact/configuration, and use a practical data-preserving migration/restore plan. Ensure only one active Todoist mutation worker operates across the cutover. No elaborate enterprise stability programme is required.
- User has authorized the full migration, required project PR publication, merge, and deployment. Do not wait for their routine code review or ask for approval at every milestone. Escalate only genuine blockers, destructive deviations, or significant product decisions.
- Verify remote writes with exact GitHub read-back. Verify deployment via live health/authenticated browser behavior, not build output alone. Report what actually works, review outcome, deployed revision, and any remaining limitation.
