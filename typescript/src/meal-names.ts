import type { Meal } from "./types";

export const maxMealNameLength = 120;
export const maxMealAliases = 10;

// Meal names compare ignoring case and repeated whitespace.
export function mealNameKey(name: string) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

// The library meal that a typed name refers to, by its name or any alias.
export function findMealByName<T extends Meal>(meals: readonly T[], name: string): T | undefined {
  const key = mealNameKey(name);
  return meals.find((meal) => mealNameKey(meal.name) === key)
    ?? meals.find((meal) => meal.aliases.some((alias) => mealNameKey(alias) === key));
}

// Whether a search shows this meal, and the alternate name it matched when the
// main name did not, so the result can say why it is listed.
export function searchMeal(meal: Meal, query: string): { match: boolean; alias?: string } {
  const key = mealNameKey(query);
  if (!key || mealNameKey(meal.name).includes(key)) return { match: true };
  const alias = meal.aliases.find((name) => mealNameKey(name).includes(key));
  return alias ? { match: true, alias } : { match: false };
}

// "Kozhukattai, modak" → ["Kozhukattai", "modak"]
export function parseAliases(text: string) {
  return text.split(",").map((name) => name.trim()).filter(Boolean);
}
