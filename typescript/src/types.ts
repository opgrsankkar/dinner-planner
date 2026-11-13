// `aliases` are alternate names; search finds a meal by any of them.
// `variantCount` is how many recipe variants the meal has (0 without a recipe).
export type Meal = { id: string; name: string; aliases: string[]; hasRecipe?: boolean; variantCount?: number };
export type Slot = { id: string; name: string; time: string };
// A planned meal as the board returns it. `completed` follows the clock: a
// meal counts as eaten once its date and slot time have passed.
export type Card = {
  id: string;
  name: string;
  date: string;
  time: string;
  completed?: boolean;
  // Library meal the card was planned from (newer cards only). Use
  // libraryMealId, which falls back to the name, rather than this.
  mealId?: string;
  slotId?: string;
  // The library meal this card resolves to (see resolveCardMeal), or null.
  libraryMealId?: string | null;
  hasRecipe?: boolean;
  variantCount?: number;
};
export type Board = {
  library: Meal[];
  slots: Slot[];
  cards: Card[];
  // Subscription URL for the read-only meals calendar; empty when disabled.
  calendarUrl?: string;
  settings: Settings;
};

export type Settings = {
  theme: "system" | "light" | "dark";
  slotOrder: string[];
  libraryOrder: string[];
  aliases: Record<string, string>;
  revision: number;
};
