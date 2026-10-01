import { useState } from "react";
import type { Meal } from "../types";

export interface MealLibrarySettingsProps {
  library: Meal[];
  action: (path: string, body: unknown) => Promise<void>;
}

export function MealLibrarySettings({ library, action }: MealLibrarySettingsProps) {
  const [search, setSearch] = useState("");
  return (
      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h2>Manage meal library</h2>
            <p>
              Remove reusable choices here. Meals already planned stay
              unchanged.
            </p>
          </div>
          <span className="settings-count">{library.length}</span>
        </div>
        <label htmlFor="manage-search">Find a meal</label>
        <input
          id="manage-search"
          className="library-manager-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="manage-library-list">
          {library
            .filter((meal) =>
              meal.name.toLowerCase().includes(search.toLowerCase()),
            )
            .map((meal) => (
              <div className="manage-meal-row" key={meal.id}>
                <span className="manage-meal-name">{meal.name}</span>
                <button
                  className="manage-remove-meal"
                  aria-label={`Remove ${meal.name} from library`}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove “${meal.name}” from the reusable library? Planned meals will stay unchanged.`,
                      )
                    )
                      void action("/api/library/remove", { mealId: meal.id });
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
        </div>
      </section>
  );
}
