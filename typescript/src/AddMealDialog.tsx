import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Meal, Slot } from "./types";

export type CellTarget = { date: string; label: string; slot: Slot; past: boolean };

// Opened from a calendar cell's "+": the day and slot are already known, so
// picking a meal plans it at once. A name not in the library is added first.
export function AddMealDialog({
  target,
  meals,
  focusSearch,
  onPick,
  onCreate,
  onClose,
  onKeyDown,
}: {
  target: CellTarget | null;
  meals: Meal[];
  focusSearch: boolean;
  onPick: (meal: Meal, target: CellTarget) => void;
  onCreate: (name: string) => Promise<Meal>;
  onClose: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDialogElement>) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!target || dialog.current?.open) return;
    setSearch("");
    setError("");
    dialog.current?.showModal();
    // On phones, focusing the search would cover the list with the keyboard.
    (focusSearch ? searchInput.current : heading.current)?.focus();
  }, [target, focusSearch]);
  const query = search.trim();
  const matches = meals.filter((meal) => meal.name.toLowerCase().includes(query.toLowerCase()));
  const canCreate = !!query && !meals.some((meal) => meal.name.trim().toLowerCase() === query.toLowerCase());
  function pick(meal: Meal) {
    if (!target) return;
    dialog.current?.close();
    onPick(meal, target);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!target || creating) return;
    if (!canCreate) {
      if (matches.length === 1) pick(matches[0]);
      return;
    }
    setCreating(true);
    setError("");
    try {
      const meal = await onCreate(query);
      pick(meal);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add meal. Please try again.");
    } finally {
      setCreating(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="confirm-dialog action-dialog add-meal-dialog"
      aria-labelledby="add-meal-title"
      onKeyDown={onKeyDown}
      onClose={onClose}
    >
      <form className="planner-action-form" onSubmit={submit}>
        <h2 id="add-meal-title" tabIndex={-1} ref={heading}>
          Add to {target?.label}
        </h2>
        {target?.past && (
          <p className="add-meal-note">This time has passed, so the meal will be marked as done.</p>
        )}
        <label htmlFor="add-meal-search">Meal</label>
        <input
          id="add-meal-search"
          ref={searchInput}
          type="search"
          autoComplete="off"
          placeholder="Search or type a new meal…"
          value={search}
          disabled={creating}
          onChange={(e) => {
            setSearch(e.target.value);
            setError("");
          }}
        />
        {canCreate && (
          <button className="primary-button add-meal-create" type="submit" disabled={creating}>
            {creating ? "Adding…" : `Add “${query}” and plan it`}
          </button>
        )}
        {error && <p className="add-meal-error" role="alert">{error}</p>}
        {matches.length > 0 ? (
          <ul className="add-meal-options" aria-label="Meal library">
            {matches.map((meal) => (
              <li key={meal.id}>
                <button type="button" disabled={creating} onClick={() => pick(meal)}>
                  {meal.name}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          !query && <p className="add-meal-note">Type a meal name to add it.</p>
        )}
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
