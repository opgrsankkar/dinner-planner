import { useEffect, useRef, useState } from "react";
import type { Meal } from "../types";

export function SwipeMealRow({ meal, hint, removing, remove, action }: {
  meal: Meal; hint: boolean; removing: boolean; remove: () => void;
  action: (path: string, body: unknown) => Promise<boolean>;
}) {
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const row = useRef<HTMLDivElement>(null);
  const animation = useRef<Animation | null>(null);
  const gesture = useRef<{ id: number; x: number; y: number; direction: "horizontal" | "vertical" | null } | null>(null);
  const stopHint = () => { animation.current?.cancel(); animation.current = null; };
  useEffect(() => {
    if (!hint || !row.current || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      const surface = row.current?.querySelector(".folio-library-surface");
      if (surface) animation.current = surface.animate([
        { transform: "translateX(0)" }, { transform: "translateX(-56px)" },
        { transform: "translateX(0)" }, { transform: "translateX(56px)" },
        { transform: "translateX(0)" },
      ], { duration: 1800, delay: 400, easing: "ease-in-out" });
    });
    observer.observe(row.current);
    return () => { observer.disconnect(); stopHint(); };
  }, [hint]);
  async function save() {
    if (busy.current) return;
    const name = draft.trim();
    if (!name || name.length > 120) { setError("Use a meal name between 1 and 120 characters."); return; }
    busy.current = true; setSaving(true); setError("");
    try {
      if (await action("/api/library/rename", { mealId: meal.id, name })) {
        setEditing(false); setOffset(0);
        requestAnimationFrame(() => row.current?.focus());
      }
    } catch (error) { setError(error instanceof Error ? error.message : "Could not edit meal."); }
    finally { busy.current = false; setSaving(false); }
  }
  return <div ref={row} className={`folio-library-row${editing ? " is-editing" : ""}`}
    data-meal-id={meal.id} data-reveal={offset > 0 ? "edit" : offset < 0 ? "delete" : "closed"}
    tabIndex={0} aria-label={`${meal.name}. Swipe right to edit, left to delete. Use Tab for actions.`}
    onFocus={stopHint} onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Escape") setOffset(0);
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); setOffset(event.key === "ArrowLeft" ? -56 : 56);
      }
    }}>
    <button type="button" className="folio-library-edit folio-library-swipe-action"
      aria-label={`Edit ${meal.name}`} disabled={saving || removing}
      onClick={() => { stopHint(); setDraft(meal.name); setError(""); setEditing(true); setOffset(0); }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6ZM14 5l5 5" /></svg>
    </button>
    <button type="button" className="folio-library-remove folio-library-swipe-action"
      aria-label={`Remove ${meal.name} from library`} disabled={removing || saving} aria-busy={removing}
      onClick={remove}>
      {removing ? <span className="folio-library-spinner" aria-hidden="true" /> :
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></svg>}
    </button>
    <div className="folio-library-surface" style={{ transform: `translateX(${offset}px)` }}
      onPointerDown={event => {
        if (editing || removing || event.button !== 0) return;
        stopHint(); gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, direction: null };
      }}
      onPointerMove={event => {
        const start = gesture.current;
        if (!start || start.id !== event.pointerId) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (!start.direction && Math.max(Math.abs(dx), Math.abs(dy)) >= 10) {
          start.direction = Math.abs(dx) > Math.abs(dy) * 1.5 ? "horizontal" : "vertical";
          if (start.direction === "horizontal") event.currentTarget.setPointerCapture(event.pointerId);
        }
        if (start.direction === "horizontal") setOffset(Math.max(-56, Math.min(56, dx)));
      }}
      onPointerUp={event => {
        const start = gesture.current;
        if (!start || start.id !== event.pointerId) return;
        const dx = event.clientX - start.x;
        setOffset(start.direction === "horizontal" && Math.abs(dx) >= 40 ? Math.sign(dx) * 56 : 0);
        gesture.current = null;
      }}
      onPointerCancel={() => { gesture.current = null; setOffset(0); }}>
      {editing ? <form className="folio-library-rename" onSubmit={event => { event.preventDefault(); void save(); }}>
        <input autoFocus aria-label={`New name for ${meal.name}`} value={draft} disabled={saving}
          onChange={event => { setDraft(event.target.value); setError(""); }}
          onKeyDown={event => { if (event.key === "Escape" && !saving) { setEditing(false); row.current?.focus(); } }} />
        <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        <button type="button" disabled={saving} onClick={() => { setEditing(false); row.current?.focus(); }}>Cancel</button>
        {error && <span role="alert">{error}</span>}
      </form> : <span className="folio-library-name">{meal.name}</span>}
    </div>
  </div>;
}
