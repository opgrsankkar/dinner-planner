# Settings section handoff

This prerequisite extraction preserves the scrolling Settings page and its DOM,
classes, API paths, feedback, confirmation, Save/Revert, and Motion sorting.
Navigation and library Add are follow-up work.

## Contracts and state

- `src/settings.tsx`: shell receives `board: Board`, `post(path, body): Promise<unknown>`, and `refresh(): Promise<void>`. Owns keyboard navigation styling and shared feedback. Its `action(path, body): Promise<void>` posts, refreshes, and catches errors into shared feedback, exactly as before. Future section selection belongs here or in routes.
- `AppearanceSettings`: `theme: Settings["theme"]`, `onThemeChange(theme): Promise<void>`. No local state.
- `MealLibrarySettings`: `library: Meal[]`, `action(path, body): Promise<void>`. Owns search. The same action supports the existing remove endpoint and future Add without changing shell props. The callback handles errors; resolution alone is not proof of mutation success.
- `MealSlotSettings`: `initialSlots: Slot[]`, `initialRevision: number`, `post(path, body): Promise<unknown>`, `refresh(): Promise<void>`, `setFeedback(message): void`. Owns baseline, draft, revision, save state, reorder menu, and private Motion row helper. Initial props seed state only, matching the original page behavior. Keep this component mounted during section switching (hide inactive sections) to preserve drafts and pending saves. Keep the library mounted too to preserve search.

Paths below are relative to `typescript/`.

## Exclusive writer ownership

| Writer | Files |
| --- | --- |
| Navigation | `src/settings.tsx`, `src/routes/settings.tsx`, `public/static/app.css`, `scripts/smoke.ts` |
| Library | `src/settings/MealLibrarySettings.tsx`; new `src/settings/MealLibrarySettings.css` if needed (import it in the section); new `scripts/library-settings-smoke.ts` for browser checks or `tests/library-settings.test.ts` for non-browser tests |
| Reserved / unchanged | `src/settings/AppearanceSettings.tsx`, `src/settings/MealSlotSettings.tsx`, planner components, shared mutation/server modules, `package.json`, existing backend tests |

Library writer must not edit the planner library: it retains its current controls.
Navigation writer owns changes to existing smoke locators. Library browser checks
should navigate via the finished settings UI rather than assume the old scroll
layout. Coordinate any necessary shared API change before editing reserved files;
no shared mutation API changes are needed for this extraction.
