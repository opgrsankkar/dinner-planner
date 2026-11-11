# Recipes and prep reminders API

A recipe is optional detail on one **library meal**. It has no name of its own: the meal's name (and alternate names) are the recipe's names. Renaming a meal keeps its recipe; removing the meal from the library removes its recipe. Text is stored as given (trimmed, Unicode NFC), so Tamil and other scripts work everywhere.

A meal can hold up to **four variants**: complete recipes of their own (ingredients, steps, prep, notes, servings…) with a short label such as `Non-fry` / `Fry`. They are full copies, not a base plus differences. Exactly one variant is the **default**. A meal with a single recipe has one variant, normally with an empty label, and every response below looks as it did before variants (plus the `variant`/`variants` fields). The variant is chosen when cooking (planned cards do not pin one); prep reminders use the default variant only.

Base URL: `https://meals.happydaysblr.ddns.net` (home network and tailnet only). All bodies are JSON (`Content-Type: application/json`). All times are **Asia/Kolkata** (`+05:30`).

None of the endpoints below return the private calendar-feed link or any other secret. (`GET /api/board` still does, in `calendarUrl`; clients that only need recipes and prep should not use it.)

## Who may write

Reads (`GET`) need nothing beyond network access. Every write (`POST`, `PUT`, `DELETE`) must carry the planner's own origin, exactly as the web app's own requests do:

```
Origin: https://meals.happydaysblr.ddns.net
```

Requests whose `Origin` is missing or different get `403 {"error":"Invalid request origin"}`. A browser always sends the true `Origin` of the page that made a request and a page cannot forge it, so other websites still cannot write through the user's browser. A local program such as Hermes is not a browser and simply sends the header itself. There is no token or login; the only gate is Caddy's LAN/tailnet rule.

The container is reachable only through Caddy (it is not published on the host or the docker bridge), so local programs on x1c use the public hostname, as above. The `Host` must be `meals.happydaysblr.ddns.net` (curl sets it from the URL).

## Recipe shape

```json
{
  "servings": "4",
  "totalMinutes": 40,
  "notes": "Batter keeps 3 days in the fridge.",
  "sourceUrl": "https://example.com/dosa",
  "ingredients": [
    { "amount": "3 cups", "item": "இட்லி அரிசி (idli rice)" },
    { "amount": "to taste", "item": "salt" },
    { "amount": "", "item": "gingelly oil for the tawa" }
  ],
  "steps": [
    { "text": "Heat the tawa and wipe it with oil." },
    { "text": "Cook until golden and crisp.", "timerMinutes": 2 }
  ],
  "prep": [
    { "text": "Soak rice and urad dal", "hoursBefore": 20 },
    { "text": "Grind and leave the batter to ferment", "hoursBefore": 12 }
  ]
}
```

| Field | Type | Rules |
|---|---|---|
| `servings` | string (a positive number is accepted and stored as text) | optional, ≤ 40 chars, free text ("4", "4–6 people") |
| `totalMinutes` | whole number or `null` | optional, 1–10080 |
| `notes` | string | optional, ≤ 4000 chars, newlines kept |
| `sourceUrl` | string | optional, `http(s)://…`, ≤ 2000 chars |
| `ingredients[]` | `{ amount, item }` in order | ≤ 100; `item` required (≤ 200), `amount` free text or `""` (≤ 60). No units system. |
| `steps[]` | `{ text, timerMinutes? }` in order | ≤ 60; `text` required (≤ 2000); `timerMinutes` optional number > 0, ≤ 1440 (fractions allowed: `0.5` = 30 s) |
| `prep[]` | `{ text, hoursBefore }` in order | ≤ 20; `text` required (≤ 300); `hoursBefore` number > 0, ≤ 168 (fractions allowed: `0.5` = 30 min) |

- Missing optional fields default to `""`, `null` or `[]`. A recipe must have at least one ingredient, step, prep item, note or source link.
- Shortcuts on input: an ingredient may be a plain string (the item, empty amount) and a step may be a plain string (its text).
- Unknown fields are rejected (so `"instructions"` or `"timer"` typos fail loudly). `updatedAt` is accepted and ignored, so a fetched recipe can be sent back.
- Responses add `updatedAt` (ISO 8601 UTC) to the recipe.

Validation failures return `400`:

```json
{
  "error": "Invalid recipe: steps[0]: unknown field \"txt\" (allowed: text, timerMinutes); steps[0].text is required",
  "issues": ["steps[0]: unknown field \"txt\" (allowed: text, timerMinutes)", "steps[0].text is required"]
}
```

## How a planned meal finds its recipe

Planned cards store the meal name they were planned with, not a library id. The server resolves each card to a library meal with one rule (`resolveCardMeal` in `typescript/src/server/recipes.ts`), used by the board and by prep reminders:

1. A card planned from the library since recipes shipped records that meal's id; if the meal still exists, that is the meal, even after a rename.
2. Otherwise the card's name is matched to a meal **name**, then to a meal's **alternate names**, ignoring case and repeated spaces. Names and alternate names are unique across the library, so at most one meal matches.
3. A card that matches nothing has no library meal and no recipe.

`GET /api/board?week=YYYY-MM-DD` reports this per card:

```json
{ "id": "…", "name": "Dosa", "date": "2026-11-11", "time": "08:00", "slotId": "…",
  "libraryMealId": "5176459e-73ac-487f-827c-4f7b5bfb9667", "hasRecipe": true, … }
```

`libraryMealId` is `null` when nothing matches. When `hasRecipe` is true, fetch `GET /api/recipes/<libraryMealId>`. (Ignore the older per-card `mealId` field; it is not resolved.) Cards and library entries in the board also carry `variantCount` (`0` without a recipe), and library entries carry `hasRecipe`.

## Endpoints

In the examples, `B=https://meals.happydaysblr.ddns.net`.

### `GET /api/recipes` — library meals and which have recipes

Optional `?name=` returns only the meal that name (or alternate name) resolves to, or an empty list.

```sh
curl -s "$B/api/recipes?name=dosa"
```
```json
{ "meals": [ { "id": "5176459e-…", "name": "தோசை", "aliases": ["Dosa"], "hasRecipe": true, "variantCount": 1 } ] }
```

Without `name`, every library meal is listed alphabetically.

### `GET /api/recipes/<mealId>` — the default recipe (or one variant, or all)

```sh
curl -s "$B/api/recipes/5176459e-73ac-487f-827c-4f7b5bfb9667"
```
```json
{ "meal": { "id": "5176459e-…", "name": "Tomato Sambar", "aliases": [], "hasRecipe": true, "variantCount": 2 },
  "recipe": { "servings": "4", "totalMinutes": 40, "notes": "…", "sourceUrl": "…",
              "ingredients": […], "steps": […], "prep": […], "updatedAt": "2026-11-10T17:05:31.076Z" },
  "variant": { "id": "0b6c…", "label": "Non-fry", "isDefault": true, "updatedAt": "2026-11-10T17:05:31.076Z" },
  "variants": [
    { "id": "0b6c…", "label": "Non-fry", "isDefault": true, "updatedAt": "2026-11-10T17:05:31.076Z" },
    { "id": "9e21…", "label": "Fry", "isDefault": false, "updatedAt": "2026-11-11T08:12:40.511Z" } ] }
```

- `recipe` is the **default** variant's recipe, in the same shape as before variants; `variant` says which variant it is; `variants` lists all of them in display order (`id`, `label`, `isDefault`, `updatedAt`).
- `?variant=<variantId>` (or `GET /api/recipes/<mealId>/variants/<variantId>`) returns that variant in `recipe`/`variant` instead.
- `?all=1` adds each variant's full `recipe` to its `variants[]` entry. **Offline caches use this**: one request per meal gets every variant, consistent with each other, and `recipe` still holds the default for older readers. (The wall display fetches today's and tomorrow's meals this way.)

`404 {"error":"This meal has no recipe"}` when the meal exists without one; `404 {"error":"Meal not found"}` when the id is not in the library; `404 {"error":"Variant not found"}` for an unknown variant of the meal; `400 {"error":"Invalid meal ID"}` / `"Invalid variant ID"` for a malformed id.

Every write below answers with this same shape (without `all`), for the variant it wrote.

### `PUT /api/recipes/<mealId>` — create or replace the default recipe

The body is the recipe object. Anything not sent is cleared (it replaces, it does not merge). It writes the **default variant**, keeping its id and label; a meal without a recipe gets it as its single, unlabeled variant. `?variant=<variantId>` writes that variant instead (same as `PUT /api/recipes/<mealId>/variants/<variantId>`).

```sh
curl -s -X PUT "$B/api/recipes/5176459e-73ac-487f-827c-4f7b5bfb9667" \
  -H "Origin: $B" -H "Content-Type: application/json" \
  -d '{"servings":"4","ingredients":[{"amount":"3 cups","item":"idli rice"}],"steps":["Soak, grind, ferment, cook."]}'
```

`200` with the same shape as `GET`. `404` if the meal is not in the library.

### `POST /api/recipes` — add a recipe by meal name (creating the meal if needed)

For an assistant adding "a recipe for X". The name is resolved like a card's (name, then alternate name). If no meal matches, a library meal with that name is created.

```sh
curl -s -X POST "$B/api/recipes" -H "Origin: $B" -H "Content-Type: application/json" -d '{
  "name": "வெண் பொங்கல்",
  "recipe": {
    "servings": 3,
    "ingredients": [{"amount": "1 cup", "item": "raw rice"}, {"amount": "½ cup", "item": "moong dal"}],
    "steps": [{"text": "Dry roast the moong dal.", "timerMinutes": 4}, "Pressure cook rice and dal with 4 cups water."],
    "prep": [{"text": "Soak the rice", "hoursBefore": 0.5}]
  }
}'
```

- `201 {"created": true, "meal": {…}, "recipe": {…}, "variant": {…}, "variants": […]}` when the meal was created.
- `200 {"created": false, …}` when an existing meal had no recipe, or `"replace": true` was sent.
- `409 {"error": "<meal> already has a recipe. Send \"replace\": true to overwrite it, or PUT /api/recipes/<id>"}` when the meal already has a recipe and `replace` is not `true`.
- `400` for a missing/over-long `name` (1–120 characters) or an invalid recipe.

**Variants by label.** Add `"variant": "<label>"` to write the variant with that label (compared ignoring case and repeated spaces): if the meal has no variant by that label it is **added** (`"Add a Fry variant of Tomato Sambar"`); if it has one, `409` unless `"replace": true`, which replaces that variant. When the meal so far has one unlabeled recipe, send `"existingLabel": "Non-fry"` to label that one too (it becomes `"Original"` if omitted). Without `variant`, the call acts on the default recipe as above.

```sh
curl -s -X POST "$B/api/recipes" -H "Origin: $B" -H "Content-Type: application/json" \
  -d '{"name": "Tomato Sambar", "variant": "Fry", "existingLabel": "Non-fry", "recipe": {…}}'
```

### `DELETE /api/recipes/<mealId>` — remove the default recipe (the meal stays)

```sh
curl -s -X DELETE "$B/api/recipes/5176459e-73ac-487f-827c-4f7b5bfb9667" -H "Origin: $B"
```

Removes the **default variant**: for a single-recipe meal that is the whole recipe. If other variants remain, the first of them becomes the default. `?all=1` removes every variant. `200 {"deleted": true, "variants": [ …what remains… ]}`, or `{"deleted": false, …}` if there was nothing to remove (repeating a delete is safe). `404` if the meal is not in the library.

## Variants

Labels: 1–40 characters, trimmed, unique within a meal ignoring case (`Fry` and `fry` clash; another meal may use `Fry`). Every variant needs a label while a meal has two or more; a meal's only variant may have an empty label (the planner and the wall display show no label then). At most 4 variants per meal (`409` beyond that). Variant ids are stable: replacing, renaming or making default keeps them.

### `POST /api/recipes/<mealId>/variants` — add a variant

```json
{ "label": "Fry", "recipe": { …full recipe… }, "existingLabel": "Non-fry", "isDefault": false }
```

- `label` (required) and either `recipe` (a full recipe object) or `copyFrom: "<variantId>"` (start as a copy of another variant, which the planner's "+ Add variant" does).
- `existingLabel` (optional): label for the meal's existing unlabeled recipe, if it has one; else `"Original"`.
- `isDefault: true` (optional) makes the new variant the default. A meal's first variant is always the default.
- `201` with the recipe response for the new variant. `409` for a taken label or a fifth variant; `400` for unknown fields or an invalid recipe.

### `PUT /api/recipes/<mealId>/variants/<variantId>` — replace one variant's recipe

Body: the recipe object (replaces it whole). The label and default flag are unchanged.

### `PATCH /api/recipes/<mealId>/variants/<variantId>` — rename or make default

```sh
curl -s -X PATCH "$B/api/recipes/<mealId>/variants/<variantId>" -H "Origin: $B" -H "Content-Type: application/json" \
  -d '{"label": "Roasted masala", "isDefault": true}'
```

`label` renames (`409` if another variant of the meal has it); `isDefault: true` makes this the default and the previous default an ordinary variant (`isDefault: false` is rejected: make another variant the default instead). Either or both.

### `DELETE /api/recipes/<mealId>/variants/<variantId>` — delete one variant

`200 {"deleted": true, "variants": [ …what remains… ]}`. Deleting the default makes the first remaining variant the default; deleting the last variant leaves the meal without a recipe. An unknown variant id answers `{"deleted": false, …}`, so repeating is safe.

### `GET /api/prep` — prep reminders in a time window

Every planned meal (from two weeks back onward) whose meal's **default** variant has `prep` items yields one reminder per item (other variants' prep is never reminded), due at the meal's slot time minus `hoursBefore` (rounded to the minute). Meals that are being deleted are skipped. Results are sorted by due time.

| Query | Meaning |
|---|---|
| `from` | Window start (inclusive). Default: now. |
| `to` | Window end (exclusive). Default: midnight at the end of **tomorrow** (Asia/Kolkata), i.e. "now until tomorrow night". |
| `overdue=1` | Also include items that fell due **before** `from` for meals that start after `from`, with `"overdue": true` (prep that was missed but still matters). |

`from`/`to` are ISO 8601 date-times with `Z` or an offset (`2026-11-10T18:00:00+05:30`, `2026-11-10T12:30:00Z`), or a local `YYYY-MM-DDTHH:MM[:SS]` read as Asia/Kolkata. Remember to URL-encode `+` as `%2B`. The window may span at most 14 days; `to` must be after `from`.

The wall display's "what should I start tonight or tomorrow" is the default call:

```sh
curl -s "$B/api/prep?overdue=1"
```
```json
{
  "from": "2026-11-10T22:36:12+05:30",
  "to": "2026-11-12T00:00:00+05:30",
  "reminders": [
    {
      "dueAt": "2026-11-11T12:00:00+05:30", "dueDate": "2026-11-11", "dueTime": "12:00",
      "text": "Soak rice and urad dal", "hoursBefore": 20,
      "mealName": "தோசை", "libraryMealId": "5176459e-…", "cardId": "c3b7a9fa-…",
      "date": "2026-11-12", "slotId": "059656cc-…", "slotName": "Breakfast", "slotTime": "08:00",
      "mealAt": "2026-11-12T08:00:00+05:30", "overdue": false
    }
  ]
}
```

`mealName` is the name on the planned card; `date`/`slotName`/`slotTime`/`mealAt` say which meal the prep is for. `slotId` is `null` (and `slotName` empty) when the card's time matches no current slot. A prep item can fall on an earlier day than its meal (`dueDate` < `date`), e.g. a 12-hour ferment for an 08:00 breakfast is due at 20:00 the evening before.

## Errors

Every error is `{"error": "<message>"}` with a status: `400` invalid input (recipe errors add `issues`), `403` wrong host or missing/foreign `Origin` on a write, `404` unknown meal/recipe/variant/endpoint, `409` recipe or variant label already exists (without `replace`), a taken label, or a fifth variant, `413` body over 256 KiB.

## Storage and rollback

Variants live in the `recipe` table, one row per variant (`id`, `mealId`, `label`, `isDefault`, `position`, `body`, `updatedAt`; a partial unique index allows one default per meal). Database schema 2 introduced it: on first start, the schema-1 table (one row per meal) is rebuilt in place, each recipe becoming its meal's unlabeled default variant with the same body and `updatedAt`. Builds before variants refuse schema 2 (they fail closed on a newer version). To roll back while keeping recipes, stop the container, keep only default variants and return to schema 1 on a copy of the database, then start the old build:

```sql
BEGIN;
CREATE TABLE recipe_v1 ("mealId" CHARACTER NOT NULL PRIMARY KEY REFERENCES "library" ("id") ON DELETE CASCADE, "body" TEXT NOT NULL, "updatedAt" TEXT NOT NULL);
INSERT INTO recipe_v1 SELECT "mealId", "body", "updatedAt" FROM "recipe" WHERE "isDefault" = 1;
DROP TABLE "recipe"; ALTER TABLE recipe_v1 RENAME TO "recipe";
PRAGMA user_version=1;
COMMIT;
```
