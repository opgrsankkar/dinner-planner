# Recipes and prep reminders API

A recipe is optional detail on one **library meal**. It has no name of its own: the meal's name (and alternate names) are the recipe's names. Renaming a meal keeps its recipe; removing the meal from the library removes its recipe. Text is stored as given (trimmed, Unicode NFC), so Tamil and other scripts work everywhere.

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

`libraryMealId` is `null` when nothing matches. When `hasRecipe` is true, fetch `GET /api/recipes/<libraryMealId>`. (Ignore the older per-card `mealId` field; it is not resolved.) Library entries in the board also carry `hasRecipe`.

## Endpoints

In the examples, `B=https://meals.happydaysblr.ddns.net`.

### `GET /api/recipes` — library meals and which have recipes

Optional `?name=` returns only the meal that name (or alternate name) resolves to, or an empty list.

```sh
curl -s "$B/api/recipes?name=dosa"
```
```json
{ "meals": [ { "id": "5176459e-…", "name": "தோசை", "aliases": ["Dosa"], "hasRecipe": true } ] }
```

Without `name`, every library meal is listed alphabetically.

### `GET /api/recipes/<mealId>` — one recipe

```sh
curl -s "$B/api/recipes/5176459e-73ac-487f-827c-4f7b5bfb9667"
```
```json
{ "meal": { "id": "5176459e-…", "name": "தோசை", "aliases": ["Dosa"], "hasRecipe": true },
  "recipe": { "servings": "4", "totalMinutes": 40, "notes": "…", "sourceUrl": "…",
              "ingredients": […], "steps": […], "prep": […], "updatedAt": "2026-11-10T17:05:31.076Z" } }
```

`404 {"error":"This meal has no recipe"}` when the meal exists without one; `404 {"error":"Meal not found"}` when the id is not in the library; `400 {"error":"Invalid meal ID"}` for a malformed id.

### `PUT /api/recipes/<mealId>` — create or replace a meal's whole recipe

The body is the recipe object. Anything not sent is cleared (it replaces, it does not merge).

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

- `201 {"created": true, "meal": {…}, "recipe": {…}}` when the meal was created.
- `200 {"created": false, …}` when an existing meal had no recipe, or `"replace": true` was sent.
- `409 {"error": "<meal> already has a recipe. Send \"replace\": true to overwrite it, or PUT /api/recipes/<id>"}` when the meal already has a recipe and `replace` is not `true`.
- `400` for a missing/over-long `name` (1–120 characters) or an invalid recipe.

### `DELETE /api/recipes/<mealId>` — remove a recipe (the meal stays)

```sh
curl -s -X DELETE "$B/api/recipes/5176459e-73ac-487f-827c-4f7b5bfb9667" -H "Origin: $B"
```

`200 {"deleted": true}`, or `{"deleted": false}` if there was no recipe (repeating a delete is safe). `404` if the meal is not in the library.

### `GET /api/prep` — prep reminders in a time window

Every planned meal (from two weeks back onward) that resolves to a recipe with `prep` items yields one reminder per item, due at the meal's slot time minus `hoursBefore` (rounded to the minute). Meals that are being deleted are skipped. Results are sorted by due time.

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

Every error is `{"error": "<message>"}` with a status: `400` invalid input (recipe errors add `issues`), `403` wrong host or missing/foreign `Origin` on a write, `404` unknown meal/recipe/endpoint, `409` recipe already exists (`POST /api/recipes` without `replace`), `413` body over 256 KiB.
