import { useEffect, useRef, useState } from "react";
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
      <div className="folio-library-list" role="list">
        {library.filter(meal => meal.name.toLowerCase().includes(search.trim().toLowerCase())).map((meal, i) => (
          <MealRow key={meal.id} meal={meal} action={action}
            removing={removing.includes(meal.id)}
            onRemove={() => void removeMeal(meal)}
            setFeedback={setFeedback} setError={setError}
            isFirst={i === 0 && !search.trim()} />
        ))}
      </div>
      <div className="folio-library-feedback" role={error ? "alert" : "status"}>{error || feedback}</div>
    </section>
  );
}

function MealRow({ meal, action, removing, onRemove, setFeedback, setError, isFirst }: {
  meal: Meal; action: MealLibrarySettingsProps["action"];
  removing: boolean; onRemove: () => void;
  setFeedback: (msg: string) => void; setError: (msg: string) => void;
  isFirst: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(meal.name);
  const [saving, setSaving] = useState(false);
  const touchStart = useRef({ x: 0, y: 0 });
  const touchState = useRef<'none'|'horizontal'|'vertical'>('none');
  const [intro, setIntro] = useState(isFirst);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (intro) {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) {
        setIntro(false);
        return;
      }
      const t = setTimeout(() => {
        if (!rowRef.current) return;
        const anim = rowRef.current.animate([
          { transform: "translateX(0)" },
          { transform: "translateX(-20px)", offset: 0.2 },
          { transform: "translateX(0)", offset: 0.4 },
          { transform: "translateX(20px)", offset: 0.6 },
          { transform: "translateX(0)" }
        ], { duration: 1200, easing: "ease-in-out" });
        anim.onfinish = () => setIntro(false);
      }, 500);
      return () => clearTimeout(t);
    }
  }, [intro]);

  function onTouchStart(e: React.TouchEvent) {
    if (editing || removing || saving) return;
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    touchState.current = 'none';
  }

  function onTouchMove(e: React.TouchEvent) {
    if (editing || removing || saving) return;
    const dx = e.touches[0].clientX - touchStart.current.x;
    const dy = e.touches[0].clientY - touchStart.current.y;
    if (touchState.current === 'none') {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 5) {
        touchState.current = 'vertical';
        return;
      }
      if (Math.abs(dx) > 5) {
        touchState.current = 'horizontal';
      }
    }
    if (touchState.current === 'horizontal') {
      if (e.cancelable) e.preventDefault();
      setOffset(Math.max(-80, Math.min(80, dx)));
    }
  }

  function onTouchEnd() {
    if (touchState.current === 'horizontal') {
      if (offset > 40) setOffset(60);
      else if (offset < -40) setOffset(-60);
      else setOffset(0);
    }
    touchState.current = 'none';
  }

  async function saveEdit() {
    const trimmed = editName.trim();
    if (!trimmed) {
      setEditing(false);
      setEditName(meal.name);
      return;
    }
    if (trimmed === meal.name) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError("");
    setFeedback("");
    try {
      if (await action("/api/library/edit", { mealId: meal.id, name: trimmed }) === true) {
        setFeedback(`Renamed to ${trimmed}.`);
        setEditing(false);
        setOffset(0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename meal.");
      setEditName(meal.name);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="folio-library-row-wrapper" role="listitem">
      <div className="folio-library-swipe-bg right" aria-hidden="true" onClick={onRemove} style={{ cursor: 'pointer' }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></svg>
      </div>
      <div className="folio-library-swipe-bg left" aria-hidden="true" onClick={() => { setEditing(true); setOffset(0); }} style={{ cursor: 'pointer' }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
      </div>
      <div className="folio-library-row" ref={rowRef}
        style={{ transform: `translateX(${offset}px)` }}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
        
        {editing ? (
          <form className="folio-library-edit-form" onSubmit={e => { e.preventDefault(); void saveEdit(); }}>
            <input autoFocus type="text" value={editName} disabled={saving}
              onChange={e => setEditName(e.target.value)}
              onBlur={() => void saveEdit()}
              onKeyDown={e => { if (e.key === "Escape") { setEditing(false); setEditName(meal.name); } }}
            />
          </form>
        ) : (
          <>
            <span className="folio-library-name">{meal.name}</span>
            <div className="folio-library-actions">
              <button className="folio-library-edit-btn" type="button" aria-label={`Edit ${meal.name}`}
                onClick={() => { setEditing(true); setOffset(0); }} disabled={removing}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
              </button>
              <button className="folio-library-remove-btn" type="button" aria-label={`Remove ${meal.name} from library`}
                disabled={removing} aria-busy={removing} onClick={onRemove}>
                {removing ? <span className="folio-library-spinner" aria-hidden="true" /> :
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></svg>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
