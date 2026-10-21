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
  onShuffle,
  onClose,
  onKeyDown,
}: {
  target: CellTarget | null;
  meals: Meal[];
  focusSearch: boolean;
  onPick: (meal: Meal, target: CellTarget) => void;
  onCreate: (name: string) => Promise<Meal>;
  onShuffle: () => Promise<void>;
  onClose: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDialogElement>) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [shuffling, setShuffling] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!target || dialog.current?.open) return;
    setSearch("");
    setError("");
    dialog.current?.showModal();
    // On phones, focusing the search would cover the list with the keyboard.
    (focusSearch ? searchInput.current : heading.current)?.focus();
  }, [target, focusSearch]);
  // iOS keeps the page height when the keyboard opens and only shrinks the
  // visual viewport; size the dialog to what is actually visible.
  useEffect(() => {
    const viewport = window.visualViewport;
    const node = dialog.current;
    if (!target || !viewport || !node) return;
    const fit = () => {
      node.style.setProperty("--visible-height", `${viewport.height}px`);
      node.style.setProperty("--visible-top", `${viewport.offsetTop}px`);
    };
    fit();
    viewport.addEventListener("resize", fit);
    viewport.addEventListener("scroll", fit);
    return () => {
      viewport.removeEventListener("resize", fit);
      viewport.removeEventListener("scroll", fit);
    };
  }, [target]);
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
      onClick={(e) => {
        // Tapping the backdrop closes the dialog.
        if (e.target !== e.currentTarget) return;
        const box = e.currentTarget.getBoundingClientRect();
        if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom)
          e.currentTarget.close();
      }}
    >
      <form className="planner-action-form add-meal-form" onSubmit={submit}>
        <h2 id="add-meal-title" tabIndex={-1} ref={heading}>
          Add to {target?.label}
        </h2>
        {target?.past && (
          <p className="add-meal-note">This time has passed, so the meal will be marked as done.</p>
        )}
        <label htmlFor="add-meal-search" className="visually-hidden">Meal</label>
        <div className="add-meal-search-row">
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
          <button
            className="add-meal-shuffle"
            type="button"
            aria-label="Shuffle meal library"
            title="Shuffle meal library"
            disabled={shuffling}
            onClick={async () => {
              setShuffling(true);
              setError("");
              try {
                await onShuffle();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not shuffle. Please try again.");
              } finally {
                setShuffling(false);
              }
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m18 3 3 3-3 3M18 15l3 3-3 3M3 6h3c5 0 7 12 12 12h3M3 18h3c2 0 4-2 6-6s4-6 6-6h3" />
            </svg>
          </button>
        </div>
        {error && <p className="add-meal-error" role="alert">{error}</p>}
        {matches.length > 0 || canCreate ? (
          <ul className="add-meal-options" aria-label="Meal library">
            {matches.map((meal) => (
              <li key={meal.id}>
                <button type="button" disabled={creating} onClick={() => pick(meal)}>
                  {meal.name}
                </button>
              </li>
            ))}
            {canCreate && (
              <li>
                <button className="add-meal-create" type="submit" disabled={creating}>
                  {creating ? "Adding…" : `+ Add “${query}” and plan it`}
                </button>
              </li>
            )}
          </ul>
        ) : (
          <p className="add-meal-note">Type a meal name to add it.</p>
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
