import { useRef, useState } from "react";
import type { Meal } from "../types";
import "./MealLibrarySettings.css";

export interface MealLibrarySettingsProps {
  library: Meal[];
  action: (path: string, body: unknown) => Promise<unknown>;
}

export function MealLibrarySettings({ library, action }: MealLibrarySettingsProps) {
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState("");
  const [addError, setAddError] = useState("");
  const submitting = useRef(false);

  async function addMeal() {
    const trimmed = name.trim();
    if (!trimmed || submitting.current) return;
    submitting.current = true;
    setAdding(true);
    setAdded("");
    setAddError("");
    try {
      if ((await action("/api/library", { name: trimmed })) === true) {
        setName("");
        setAdded(`Added ${trimmed} to the meal library.`);
      }
    } catch (error) {
      setAddError(error instanceof Error ? error.message : "Could not add meal. Please try again.");
    } finally {
      submitting.current = false;
      setAdding(false);
    }
  }

  return (
    <section className="settings-section meal-library-settings">
      <div className="settings-section-heading">
        <div>
          <h2>Manage meal library</h2>
          <p>Add or remove reusable choices here. Meals already planned stay unchanged.</p>
        </div>
        <span className="settings-count">{library.length}</span>
      </div>
      <form className="meal-library-add" onSubmit={(event) => {
        event.preventDefault();
        void addMeal();
      }}>
        <label htmlFor="manage-add-meal">Add a meal</label>
        <div className="meal-library-add-controls">
          <input
            id="manage-add-meal"
            value={name}
            disabled={adding}
            onChange={(event) => { setName(event.target.value); setAdded(""); setAddError(""); }}
            placeholder="Meal name"
          />
          <button type="submit" disabled={adding || !name.trim()}>
            {adding ? "Adding…" : "Add meal"}
          </button>
        </div>
        <div className="meal-library-add-feedback" role={addError ? "alert" : "status"}>
          {addError || added}
        </div>
      </form>
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
          .filter((meal) => meal.name.toLowerCase().includes(search.toLowerCase()))
          .map((meal) => (
            <div className="manage-meal-row" key={meal.id}>
              <span className="manage-meal-name">{meal.name}</span>
              <button
                className="manage-remove-meal"
                aria-label={`Remove ${meal.name} from library`}
                onClick={() => {
                  if (window.confirm(
                    `Remove “${meal.name}” from the reusable library? Planned meals will stay unchanged.`,
                  )) void action("/api/library/remove", { mealId: meal.id });
                }}
              >Remove</button>
            </div>
          ))}
      </div>
    </section>
  );
}
