import { createFileRoute } from "@tanstack/react-router";
import { Planner } from "./index";
export const Route = createFileRoute("/recipes/$mealId_/edit")({ component: Planner });
