import { useEffect, useRef, useState } from "react";
import { SwipeMealRow } from "./SwipeMealRow";
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
  const submitting = useRef(false);
  const pendingRemovals = useRef(new Set<string>());
  const input = useRef<HTMLInputElement>(null);

  const feedbackAnimations = useRef<Animation[]>([]);
  useEffect(() => () => feedbackAnimations.current.forEach(animation => animation.cancel()), []);

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
    }
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
      <p className="folio-library-hint">Swipe right to edit, left to delete. Or focus a meal and Tab to its actions.</p>
      <div className="folio-library-list">
        {library.filter(meal => meal.name.toLowerCase().includes(search.trim().toLowerCase())).map(meal => (
          <SwipeMealRow key={meal.id} meal={meal} hint={meal.id === library[0]?.id}
            removing={removing.includes(meal.id)} remove={() => void removeMeal(meal)} action={action} />
        ))}
      </div>
      <div className="folio-library-feedback" role={error ? "alert" : "status"}>{error || feedback}</div>
    </section>
  );
}
