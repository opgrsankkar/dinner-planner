// A recipe is optional detail on one library meal. Shared by the server (which
// validates every write) and the editor (which checks drafts the same way).

export type Ingredient = { amount: string; item: string };
export type RecipeStep = { text: string; timerMinutes?: number };
// Work done ahead of the meal: soak, ferment, marinate, thaw.
export type PrepItem = { text: string; hoursBefore: number };
export type Recipe = {
  servings: string;
  totalMinutes: number | null;
  notes: string;
  sourceUrl: string;
  ingredients: Ingredient[];
  steps: RecipeStep[];
  prep: PrepItem[];
};
export type StoredRecipe = Recipe & { updatedAt: string };

export const recipeLimits = {
  servings: 40,
  notes: 4000,
  sourceUrl: 2000,
  ingredients: 100,
  amount: 60,
  item: 200,
  steps: 60,
  stepText: 2000,
  timerMinutes: 1440,
  prep: 20,
  prepText: 300,
  hoursBefore: 168,
  totalMinutes: 10080,
} as const;

export class RecipeInputError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid recipe: ${issues.slice(0, 3).join("; ")}${issues.length > 3 ? ` (and ${issues.length - 3} more)` : ""}`);
  }
}

const recipeKeys = ["servings", "totalMinutes", "notes", "sourceUrl", "ingredients", "steps", "prep"];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Validates and normalises a recipe body. Strings are trimmed and NFC
// normalised (Tamil and other scripts are kept as they are). For convenience an
// ingredient may be a plain string (the item) and a step a plain string (its text).
// Throws RecipeInputError listing every problem with its field path.
export function parseRecipe(input: unknown): Recipe {
  const issues: string[] = [];
  if (!isObject(input)) throw new RecipeInputError(["body must be a JSON object"]);
  for (const key of Object.keys(input))
    // updatedAt is accepted and ignored so a fetched recipe can be sent back.
    if (!recipeKeys.includes(key) && key !== "updatedAt")
      issues.push(`unknown field "${key}" (allowed: ${recipeKeys.join(", ")})`);
  const text = (value: unknown, path: string, max: number, required = false): string => {
    if (value === undefined || value === null) {
      if (required) issues.push(`${path} is required`);
      return "";
    }
    if (typeof value !== "string") {
      issues.push(`${path} must be a string`);
      return "";
    }
    const cleaned = value.normalize("NFC").trim();
    if (required && !cleaned) issues.push(`${path} must not be empty`);
    if (cleaned.length > max) issues.push(`${path} must be at most ${max} characters`);
    return cleaned;
  };
  const number = (value: unknown, path: string, max: number, integer = false): number | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max || (integer && !Number.isInteger(value))) {
      issues.push(`${path} must be ${integer ? "a whole number" : "a number"} greater than 0 and at most ${max}`);
      return undefined;
    }
    return value;
  };
  const list = (value: unknown, path: string, max: number): unknown[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      issues.push(`${path} must be an array`);
      return [];
    }
    if (value.length > max) issues.push(`${path} may have at most ${max} entries`);
    return value.slice(0, max);
  };
  const fields = (value: Record<string, unknown>, path: string, allowed: string[]) => {
    for (const key of Object.keys(value))
      if (!allowed.includes(key)) issues.push(`${path}: unknown field "${key}" (allowed: ${allowed.join(", ")})`);
  };

  const servings =
    typeof input.servings === "number" && Number.isFinite(input.servings) && input.servings > 0
      ? String(input.servings)
      : text(input.servings, "servings", recipeLimits.servings);
  const totalMinutes =
    input.totalMinutes === undefined || input.totalMinutes === null
      ? null
      : number(input.totalMinutes, "totalMinutes", recipeLimits.totalMinutes, true) ?? null;
  const notes = text(input.notes, "notes", recipeLimits.notes);
  const sourceUrl = text(input.sourceUrl, "sourceUrl", recipeLimits.sourceUrl);
  if (sourceUrl) {
    let ok = false;
    try {
      ok = ["http:", "https:"].includes(new URL(sourceUrl).protocol);
    } catch {}
    if (!ok) issues.push("sourceUrl must be an http(s) URL");
  }
  const ingredients = list(input.ingredients, "ingredients", recipeLimits.ingredients).map((entry, index): Ingredient => {
    const path = `ingredients[${index}]`;
    if (typeof entry === "string") return { amount: "", item: text(entry, `${path}.item`, recipeLimits.item, true) };
    if (!isObject(entry)) {
      issues.push(`${path} must be an object like {"amount": "1 cup", "item": "rice"}`);
      return { amount: "", item: "" };
    }
    fields(entry, path, ["amount", "item"]);
    return {
      amount: text(entry.amount, `${path}.amount`, recipeLimits.amount),
      item: text(entry.item, `${path}.item`, recipeLimits.item, true),
    };
  });
  const steps = list(input.steps, "steps", recipeLimits.steps).map((entry, index): RecipeStep => {
    const path = `steps[${index}]`;
    if (typeof entry === "string") return { text: text(entry, `${path}.text`, recipeLimits.stepText, true) };
    if (!isObject(entry)) {
      issues.push(`${path} must be an object like {"text": "…", "timerMinutes": 10}`);
      return { text: "" };
    }
    fields(entry, path, ["text", "timerMinutes"]);
    const step: RecipeStep = { text: text(entry.text, `${path}.text`, recipeLimits.stepText, true) };
    if (entry.timerMinutes !== undefined && entry.timerMinutes !== null) {
      const minutes = number(entry.timerMinutes, `${path}.timerMinutes`, recipeLimits.timerMinutes);
      if (minutes !== undefined) step.timerMinutes = minutes;
    }
    return step;
  });
  const prep = list(input.prep, "prep", recipeLimits.prep).map((entry, index): PrepItem => {
    const path = `prep[${index}]`;
    if (!isObject(entry)) {
      issues.push(`${path} must be an object like {"text": "Soak urad dal", "hoursBefore": 12}`);
      return { text: "", hoursBefore: 0 };
    }
    fields(entry, path, ["text", "hoursBefore"]);
    return {
      text: text(entry.text, `${path}.text`, recipeLimits.prepText, true),
      hoursBefore: number(entry.hoursBefore, `${path}.hoursBefore`, recipeLimits.hoursBefore) ?? 0,
    };
  });
  if (!issues.length && !ingredients.length && !steps.length && !prep.length && !notes && !sourceUrl)
    issues.push("recipe is empty: add ingredients, steps, prep, notes or a sourceUrl (DELETE removes a recipe)");
  if (issues.length) throw new RecipeInputError(issues);
  return { servings, totalMinutes, notes, sourceUrl, ingredients, steps, prep };
}

export function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return hours ? (rest ? `${hours} h ${rest} min` : `${hours} h`) : `${rest} min`;
}

export function formatHoursBefore(hours: number) {
  if (hours < 1) return `${Math.round(hours * 60)} min before`;
  if (hours >= 24 && hours % 24 === 0) return hours === 24 ? "1 day before" : `${hours / 24} days before`;
  return `${Number(hours.toFixed(2))} h before`;
}
