// `aliases` are alternate names; search finds a meal by any of them.
export type Meal = { id: string; name: string; aliases: string[]; hasRecipe?: boolean };
export type Slot = { id: string; name: string; time: string };
export type Placement = {
  mealId: string;
  name: string;
  date: string;
  slotId: string;
  time: string;
  projectId: string;
  // Persisted intent, decided at submission: create the meal then mark it
  // complete because its date+slot time had already passed.
  complete?: boolean;
};
export type RemoteMeal = {
  id: string;
  projectId: string;
  name: string;
  date: string;
  time: string;
  requestId: string;
  completed?: boolean;
  description?: string;
  dueError?: string;
  // Library meal the card was planned from (local mode, newer cards only).
  // Use Card.libraryMealId, which falls back to the name, rather than this.
  mealId?: string;
};
export type Card = RemoteMeal & {
  state: "pending" | "saved";
  error: string;
  confirmedAt: number;
  deleting?: boolean;
  slotId?: string;
  // The library meal this card resolves to (see resolveCardMeal), or null.
  libraryMealId?: string | null;
  hasRecipe?: boolean;
};
export type Board = {
  library: Meal[];
  slots: Slot[];
  cards: Card[];
  // Subscription URL for the read-only meals calendar; empty when disabled.
  calendarUrl?: string;
  settings: Settings;
  receivedRequests: string[];
  projectId: string;
  integrationError?: string;
};

export type Settings = {
  theme: "system" | "light" | "dark";
  slotOrder: string[];
  libraryOrder: string[];
  aliases: Record<string, string>;
  revision: number;
};
export type Mutation = Placement & {
  kind?: "move" | "delete";
  taskId?: string;
};
