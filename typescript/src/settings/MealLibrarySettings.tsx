import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import type { Meal } from "../types";
import "./MealLibrarySettings.css";

export interface MealLibrarySettingsProps {
  library: Meal[];
  action: (path: string, body: unknown) => Promise<boolean>;
}

export function MealLibrarySettings({ library, action }: MealLibrarySettingsProps) {
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<{ id: string; side: "edit" | "delete" } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [hinting, setHinting] = useState(false);
  const submitting = useRef(false);
  const pendingRemovals = useRef(new Set<string>());
  const input = useRef<HTMLInputElement>(null);
  const editInput = useRef<HTMLInputElement>(null);
  const hintPlayed = useRef(false);
  const gesture = useRef<{ id: string; x: number; y: number; offset: number; horizontal: boolean } | null>(null);

  const feedbackAnimations = useRef<Animation[]>([]);
  useEffect(() => () => feedbackAnimations.current.forEach(animation => animation.cancel()), []);
  useEffect(() => {
    if (hintPlayed.current) { setHinting(false); return; }
    if (!library.length) return;
    hintPlayed.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setHinting(true);
    const timer = window.setTimeout(() => setHinting(false), 2300);
    return () => window.clearTimeout(timer);
  }, [library.length]);

  function animateInvalid(reset = false) {
    const field = input.current;
    if (!field) return;
    const previousColor = getComputedStyle(field).color;
    feedbackAnimations.current.forEach(animation => animation.cancel());
    const ink = getComputedStyle(field).color;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const red = document.documentElement.dataset.theme === "dark" ? "#ff8c9c" : "#b42335";
    // Hold red through the wiggle, then fade independently of aria-invalid.
    // Reduced motion keeps a brief 40ms red cue before the 200ms fade.
    feedbackAnimations.current = [field.animate([
      { color: reset ? previousColor : red, offset: 0 },
      { color: reset ? previousColor : red, offset: reset ? 0 : reduced ? 1 / 6 : .5, easing: "ease-out" },
      { color: ink, offset: 1 },
    ], { duration: reset ? 180 : reduced ? 240 : 600, easing: "linear" })];
    if (!reset && !reduced) feedbackAnimations.current.push(field.animate([
      { transform: "translateX(0)" }, { transform: "translateX(-4px)" },
      { transform: "translateX(4px)" }, { transform: "translateX(-4px)" },
      { transform: "translateX(0)" },
    ], { duration: 300, easing: "ease-in-out" }));
  }

  async function addMeal() {
    if (submitting.current) return;
    const trimmed = search.trim();
    if (!trimmed) {
      setInvalid(true);
      animateInvalid();
      input.current?.focus();
      return;
    }
    submitting.current = true;
    setAdding(true);
    setFeedback("");
    setError("");
    try {
      if (await action("/api/library", { name: trimmed }) === true) {
        setSearch("");
        setFeedback(`Added ${trimmed} to the meal library.`);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not add meal. Please try again.");
    } finally {
      submitting.current = false;
      setAdding(false);
    }
  }

  async function removeMeal(meal: Meal) {
    if (pendingRemovals.current.has(meal.id)) return;
    if (!window.confirm(`Remove “${meal.name}” from the reusable library? Planned meals will stay unchanged.`)) return;
    pendingRemovals.current.add(meal.id);
    setRemoving([...pendingRemovals.current]);
    setFeedback("");
    setError("");
    try {
      if (await action("/api/library/remove", { mealId: meal.id }) === true) {
        setFeedback(`Removed ${meal.name} from the meal library.`);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not remove meal. Please try again.");
    } finally {
      pendingRemovals.current.delete(meal.id);
      setRemoving([...pendingRemovals.current]);
      setRevealed(null);
    }
  }

  function startEdit(meal: Meal) {
    setRevealed(null);
    setEditing(meal.id);
    setEditName(meal.name);
    setError("");
    requestAnimationFrame(() => editInput.current?.focus());
  }

  async function saveEdit(meal: Meal) {
    if (savingEdit) return;
    const name = editName.trim().replace(/\s+/g, " ");
    if (!name || name.length > 120) {
      setError("Use a meal name between 1 and 120 characters.");
      editInput.current?.focus();
      return;
    }
    setSavingEdit(true);
    setError("");
    try {
      const ok = await action("/api/library/rename", { mealId: meal.id, name });
      if (ok) {
        setEditing(null);
        setFeedback(`Renamed ${meal.name} to ${name}.`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename meal. Please try again.");
    } finally {
      setSavingEdit(false);
    }
  }

  function beginGesture(event: PointerEvent<HTMLDivElement>, mealId: string) {
    if (event.pointerType === "mouse" || editing === mealId) return;
    setHinting(false);
    gesture.current = { id: mealId, x: event.clientX, y: event.clientY, offset: 0, horizontal: false };
  }

  function moveGesture(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.currentTarget.dataset.mealId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.horizontal && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) current.horizontal = true;
    if (!current.horizontal) return;
    current.offset = Math.max(-88, Math.min(88, dx));
    event.currentTarget.style.setProperty("--swipe-offset", `${current.offset}px`);
    event.currentTarget.classList.add("is-swiping");
  }

  function endGesture(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.currentTarget.dataset.mealId) return;
    gesture.current = null;
    event.currentTarget.classList.remove("is-swiping");
    event.currentTarget.style.removeProperty("--swipe-offset");
    if (current.horizontal && Math.abs(current.offset) >= 48) {
      setRevealed({ id: current.id, side: current.offset < 0 ? "delete" : "edit" });
      setFeedback(""); setError("");
    }
  }

  function cancelGesture(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current?.id !== event.currentTarget.dataset.mealId) return;
    gesture.current = null;
    event.currentTarget.classList.remove("is-swiping");
    event.currentTarget.style.removeProperty("--swipe-offset");
  }

  return (
    <section className="folio-library" aria-label="Meal library">
      <form className="folio-library-tools" onSubmit={event => { event.preventDefault(); void addMeal(); }}>
        <input
          ref={input}
          type="search"
          aria-label="Search meals"
          aria-invalid={invalid}
          placeholder="Search meals"
          value={search}
          disabled={adding}
          onChange={event => { setSearch(event.target.value); setInvalid(false); animateInvalid(true); setFeedback(""); setError(""); }}
        />
        <button className="folio-library-add" type="submit" disabled={adding}>
          {adding ? "Adding…" : "＋ Add Meal"}
        </button>
      </form>
      <p className="folio-library-hint">Swipe left to delete or right to edit. Select an icon to continue.</p>
      <div className="folio-library-list">
        {library.filter(meal => meal.name.toLowerCase().includes(search.trim().toLowerCase())).map((meal, index) => {
          const isRevealed = revealed?.id === meal.id;
          const busy = removing.includes(meal.id);
          return (
            <div className={`folio-library-row${isRevealed ? ` is-revealed-${revealed.side}` : ""}${editing === meal.id ? " is-editing" : ""}${hinting && index === 0 ? " is-hinting" : ""}`}
              key={meal.id} data-meal-id={meal.id} onPointerDown={event => beginGesture(event, meal.id)}
              onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={cancelGesture}>
              <button className="folio-library-action folio-library-edit" type="button"
                aria-label={`Edit ${meal.name}`} onClick={() => startEdit(meal)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m4 16.5-.8 4.3 4.3-.8L20 7.5 16.5 4 4 16.5Z"/><path d="m14.8 5.7 3.5 3.5"/></svg>
              </button>
              <button className="folio-library-action folio-library-delete" type="button"
                aria-label={`Delete ${meal.name}`} disabled={busy} aria-busy={busy} onClick={() => void removeMeal(meal)}>
                {busy ? <span className="folio-library-spinner" aria-hidden="true" /> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></svg>}
              </button>
              <div className="folio-library-content">
                {editing === meal.id ? <form className="folio-library-edit-form" onSubmit={event => { event.preventDefault(); void saveEdit(meal); }}>
                  <input ref={editInput} aria-label={`New name for ${meal.name}`} value={editName} maxLength={120}
                    disabled={savingEdit} onChange={event => { setEditName(event.target.value); setError(""); }} />
                  <button type="submit" className="folio-library-save" disabled={savingEdit}>{savingEdit ? "Saving…" : "Save"}</button>
                  <button type="button" className="folio-library-cancel" disabled={savingEdit} onClick={() => { setEditing(null); setError(""); }}>Cancel</button>
                </form> : <span className="folio-library-name">{meal.name}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="folio-library-feedback" role={error ? "alert" : "status"}>{error || feedback}</div>
    </section>
  );
}
