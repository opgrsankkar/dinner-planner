import { parseRecipe, RecipeInputError, type Recipe, type StoredRecipe } from "../recipe";
import type { Meal } from "../types";
import { requestId } from "../request-id";

export type RecipeResponse = { meal: Meal; recipe: StoredRecipe };

export class RecipeApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function recipeRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new RecipeApiError(result.error ?? "Request failed", response.status);
  return result as T;
}

// Editor rows carry a stable key for React and reordering; numbers stay text
// while typed so a half-typed value is not lost.
export type IngredientRow = { key: string; amount: string; item: string };
export type StepRow = { key: string; text: string; timerMinutes: string };
export type PrepRow = { key: string; text: string; hoursBefore: string };
export type RecipeDraft = {
  servings: string;
  totalMinutes: string;
  notes: string;
  sourceUrl: string;
  ingredients: IngredientRow[];
  steps: StepRow[];
  prep: PrepRow[];
};

export const emptyIngredient = (): IngredientRow => ({ key: requestId(), amount: "", item: "" });
export const emptyStep = (): StepRow => ({ key: requestId(), text: "", timerMinutes: "" });
export const emptyPrep = (): PrepRow => ({ key: requestId(), text: "", hoursBefore: "" });

const numberText = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));

export function draftFromRecipe(recipe: Recipe | null): RecipeDraft {
  return {
    servings: recipe?.servings ?? "",
    totalMinutes: numberText(recipe?.totalMinutes),
    notes: recipe?.notes ?? "",
    sourceUrl: recipe?.sourceUrl ?? "",
    ingredients: recipe ? recipe.ingredients.map((entry) => ({ key: requestId(), ...entry })) : [emptyIngredient()],
    steps: recipe ? recipe.steps.map((entry) => ({ key: requestId(), text: entry.text, timerMinutes: numberText(entry.timerMinutes) })) : [emptyStep()],
    prep: recipe ? recipe.prep.map((entry) => ({ key: requestId(), text: entry.text, hoursBefore: numberText(entry.hoursBefore) })) : [],
  };
}

const toNumber = (text: string) => (text.trim() === "" ? undefined : Number(text.trim().replace(",", ".")));

// The JSON the API receives. Rows left completely blank are dropped, so an
// added but unused row never blocks saving.
export function draftPayload(draft: RecipeDraft) {
  return {
    servings: draft.servings,
    totalMinutes: toNumber(draft.totalMinutes) ?? null,
    notes: draft.notes,
    sourceUrl: draft.sourceUrl,
    ingredients: draft.ingredients
      .filter((row) => row.amount.trim() || row.item.trim())
      .map(({ amount, item }) => ({ amount, item })),
    steps: draft.steps
      .filter((row) => row.text.trim() || row.timerMinutes.trim())
      .map(({ text, timerMinutes }) => ({ text, ...(timerMinutes.trim() ? { timerMinutes: toNumber(timerMinutes) } : {}) })),
    prep: draft.prep
      .filter((row) => row.text.trim() || row.hoursBefore.trim())
      .map(({ text, hoursBefore }) => ({ text, hoursBefore: toNumber(hoursBefore) })),
  };
}

// "ingredients[2].item must not be empty" → "Ingredient 3: item must not be empty"
function humanIssue(issue: string) {
  return issue
    .replace(/^ingredients\[(\d+)\]\.?/, (_, n) => `Ingredient ${Number(n) + 1}: `)
    .replace(/^steps\[(\d+)\]\.?/, (_, n) => `Step ${Number(n) + 1}: `)
    .replace(/^prep\[(\d+)\]\.?/, (_, n) => `Ahead ${Number(n) + 1}: `)
    .replace(/^totalMinutes /, "Total time ")
    .replace(/^sourceUrl /, "Source link ")
    .replace(/timerMinutes /, "timer minutes ")
    .replace(/hoursBefore /, "hours before ")
    .replace(/: : /, ": ")
    .replace(/^recipe is empty.*$/, "Add an ingredient, a step or a note");
}

// Problems the server would report, in words for the editor.
export function draftIssues(draft: RecipeDraft): string[] {
  try {
    parseRecipe(draftPayload(draft));
    return [];
  } catch (error) {
    return error instanceof RecipeInputError ? error.issues.map(humanIssue) : [String(error)];
  }
}

export function sameDraft(a: RecipeDraft, b: RecipeDraft) {
  return JSON.stringify(draftPayload(a)) === JSON.stringify(draftPayload(b));
}

// Goes back to the previous planner page when there is one, else to `fallback`.
export function goBack(fallback: string) {
  try {
    if (document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1) {
      history.back();
      return;
    }
  } catch {}
  location.href = fallback;
}
