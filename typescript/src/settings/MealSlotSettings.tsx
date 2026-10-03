import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import "./MealSlotSettings.css";
import { sortSlotsByTime, sortSlotsKeepingDraftsOnTop, validSlotTime } from "../slot-order";
import type { Slot } from "../types";

export interface MealSlotSettingsProps {
  active?: boolean;
  initialSlots: Slot[];
  initialRevision: number;
  post: (path: string, body: unknown) => Promise<unknown>;
  refresh: () => Promise<void>;
  setFeedback: (message: string) => void;
}

// Owns the unsaved draft and save lifecycle. Keep mounted during section
// navigation so switching sections does not discard pending edits.
export function MealSlotSettings({ active = false, initialSlots, initialRevision, post, refresh, setFeedback }: MealSlotSettingsProps) {
  const reduced = useReducedMotion();
  const [baseline, setBaseline] = useState(() => sortSlotsByTime(initialSlots));
  const [revision, setRevision] = useState(initialRevision);
  const [slots, setSlots] = useState(() => sortSlotsByTime(initialSlots));
  const [state, setState] = useState("idle");
  const [introPeek, setIntroPeek] = useState(true);
  const introStarted = useRef(false);
  const [revealedSlotId, setRevealedSlotId] = useState<string | null>(null);
  const [swipe, setSwipe] = useState<{ slotId: string; offset: number } | null>(null);
  const swipeStart = useRef<{
    slotId: string;
    pointerId: number;
    x: number;
    y: number;
    startOffset: number;
    tracking: boolean;
  } | null>(null);
  useEffect(() => {
    if (!active) {
      if (introStarted.current) setIntroPeek(false);
      return;
    }
    if (introStarted.current) return;
    introStarted.current = true;
    const timer = window.setTimeout(() => setIntroPeek(false), 1600);
    return () => window.clearTimeout(timer);
  }, [active]);
  const dirty = JSON.stringify(slots) !== JSON.stringify(baseline);
  const saving = state === "saving";
  const savedIds = new Set(baseline.map(slot => slot.id));
  const valid =
    slots.length > 0 &&
    slots.every(
      (slot) => slot.name.trim() && validSlotTime(slot.time),
    ) &&
    new Set(slots.map((slot) => slot.time)).size === slots.length;
  function edit(id: string, patch: Partial<Slot>) {
    setSlots(current => sortSlotsKeepingDraftsOnTop(
      current.map(slot => slot.id === id ? { ...slot, ...patch } : slot),
      savedIds,
    ));
    setState("idle");
  }
  function startTouchSwipe(event: ReactPointerEvent<HTMLDivElement>, slotId: string) {
    if (event.pointerType !== "touch" || !event.isPrimary || saving) return;
    swipeStart.current = {
      slotId,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startOffset: revealedSlotId === slotId ? -52 : 0,
      tracking: false,
    };
  }
  function moveTouchSwipe(event: ReactPointerEvent<HTMLDivElement>) {
    const start = swipeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.tracking) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
        swipeStart.current = null;
        setRevealedSlotId(null);
        setSwipe(null);
        return;
      }
      const swipingLeft = start.startOffset === 0 && dx < -10;
      const swipingRight = start.startOffset < 0 && dx > 10;
      if ((!swipingLeft && !swipingRight) || Math.abs(dx) <= Math.abs(dy)) return;
      start.tracking = true;
      setRevealedSlotId(null);
    }
    event.preventDefault();
    setSwipe({ slotId: start.slotId, offset: Math.max(-52, Math.min(0, start.startOffset + dx)) });
  }
  function endTouchSwipe(event: ReactPointerEvent<HTMLDivElement>, canceled = false) {
    const start = swipeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    swipeStart.current = null;
    setSwipe(null);
    if (canceled) {
      setRevealedSlotId(null);
      return;
    }
    if (start.tracking) {
      const dx = event.clientX - start.x;
      const offset = Math.max(-52, Math.min(0, start.startOffset + dx));
      setRevealedSlotId(offset <= -36 ? start.slotId : null);
    } else if (start.startOffset === 0) {
      setRevealedSlotId(null);
    }
  }
  return (
      <section className="settings-section slot-settings-section folio-slots">
        <h2>Meal slots</h2>
        <form
          className="slot-settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!dirty || !valid || saving) return;
            setState("saving");
            setFeedback("");
            const started = performance.now();
            try {
              const normalized = sortSlotsByTime(slots).map((slot) => ({
                ...slot,
                name: slot.name.trim(),
              }));
              await post("/api/settings/slots", {
                slots: normalized,
                revision,
              });
              await new Promise((resolve) =>
                setTimeout(
                  resolve,
                  Math.max(0, 420 - (performance.now() - started)),
                ),
              );
              setSlots(normalized);
              setBaseline(normalized);
              setRevision(revision + 1);
              setState("saved");
              setTimeout(
                () =>
                  setState((current) =>
                    current === "saved" ? "idle" : current,
                  ),
                1000,
              );
              await refresh();
            } catch (error) {
              setState("error");
              setFeedback((error as Error).message);
            }
          }}
        >
          <div className="settings-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={saving || slots.length >= 12}
              onClick={() => {
                const draft = { id: crypto.randomUUID(), name: "", time: "" };
                setSlots(current => [draft, ...current]);
                setState("idle");
              }}
            >
              + Add slot
            </button>
            <div className="settings-save-actions">
              <button
                className="primary-button slot-save-button"
                data-state={state}
                aria-label={
                  state === "saving"
                    ? "Saving"
                    : state === "saved"
                      ? "Saved"
                      : state === "error"
                        ? "Save failed"
                        : "Save"
                }
                disabled={saving || !dirty || !valid}
              >
                <span className="slot-save-state slot-save-idle">Save</span>
                <span className="slot-save-state slot-save-busy">
                  <span className="button-spinner" />
                </span>
                <span className="slot-save-state slot-save-done">✓</span>
                <span className="slot-save-state slot-save-error">×</span>
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={saving || !dirty}
                onClick={() => {
                  setSlots(baseline);
                  setState("idle");
                  setFeedback("");
                }}
              >
                Revert
              </button>

            </div>
          </div>
          <div className="slot-list">
            <AnimatePresence initial={false}>
            {slots.map((slot, index) => (
              <motion.div key={slot.id} data-slot-id={slot.id}
                layout={reduced ? false : "position"} initial={false}
                exit={reduced ? undefined : { opacity: 0, height: 0, minHeight: 0 }}
                transition={{ duration: reduced ? 0 : .4 }}
                className={`slot-edit-row${revealedSlotId === slot.id ? " is-revealed" : ""}${introPeek && index === 1 && !reduced ? " slot-intro-peek" : ""}`}
                onPointerDown={(event) => startTouchSwipe(event, slot.id)}
                onPointerMove={moveTouchSwipe}
                onPointerUp={(event) => endTouchSwipe(event)}
                onPointerCancel={(event) => endTouchSwipe(event, true)}>
                <div className="slot-edit-row-content" style={swipe?.slotId === slot.id ? { "--slot-swipe-offset": `${swipe.offset}px` } as CSSProperties : undefined}>
                  <label>
                    <span className="visually-hidden">
                      Slot label {index + 1}
                    </span>
                    <input
                      className="slot-name"
                      disabled={saving}
                      value={slot.name}
                      maxLength={120}
                      onChange={(e) => edit(slot.id, { name: e.target.value })}
                    />
                  </label>
                  <label>
                    <span className="visually-hidden">Slot time {index + 1}</span>
                    <input
                      className="slot-time"
                      type="time"
                      disabled={saving}
                      value={slot.time}
                      onChange={(e) => edit(slot.id, { time: e.target.value })}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className="remove-slot"
                  aria-label={`Remove slot ${slot.name}`}
                  disabled={saving || slots.length === 1}
                  onFocus={() => setRevealedSlotId(slot.id)}
                  onBlur={() => setRevealedSlotId(current => current === slot.id ? null : current)}
                  onClick={() => {
                    setRevealedSlotId(null);
                    setSlots(current => sortSlotsKeepingDraftsOnTop(
                      current.filter(item => item.id !== slot.id),
                      savedIds,
                    ));
                    setState("idle");
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></svg>
                </button>
              </motion.div>
            ))}
            </AnimatePresence>
          </div>

        </form>
      </section>
  );
}
