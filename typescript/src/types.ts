export type Meal = { id: string; name: string };
export type Slot = Meal & { time: string };
export type Placement = {
  mealId: string;
  name: string;
  date: string;
  slotId: string;
  time: string;
  projectId: string;
};
export type RemoteMeal = {
  id: string;
  projectId: string;
  name: string;
  date: string;
  time: string;
  requestId: string;
};
export type Card = RemoteMeal & {
  state: "pending" | "saved";
  error: string;
  confirmedAt: number;
  deleting?: boolean;
  slotId?: string;
};
export type Board = {
  library: Meal[];
  slots: Slot[];
  cards: Card[];
  csrf: string;
  settings: Settings;
  receivedRequests: string[];
  projectId: string;
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
