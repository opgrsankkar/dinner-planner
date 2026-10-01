import { useEffect, useRef, useState } from "react";
import { AnimatePresence, Reorder, useAnimationControls, useDragControls, useReducedMotion } from "motion/react";
import "./MealSlotSettings.css";
import type { ReactNode } from "react";
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
export function MealSlotSettings({ active, initialSlots, initialRevision, post, refresh, setFeedback }: MealSlotSettingsProps) {
  const [baseline, setBaseline] = useState(initialSlots);
  const [revision, setRevision] = useState(initialRevision);
  const [slots, setSlots] = useState(initialSlots);
  const [state, setState] = useState("idle");
  const section = useRef<HTMLElement>(null);
  const [opening, setOpening] = useState(0);
  const [hintId, setHintId] = useState(initialSlots[0]?.id);
  const currentSlots = useRef(slots);
  currentSlots.current = slots;
  useEffect(() => {
    if (active !== undefined) { if (active) { setHintId(currentSlots.current[0]?.id); setOpening(n => n + 1); } return; }
    // Older shells keep this component mounted in a hidden section.
    let visible = false;
    const check = () => {
      const next = !!section.current?.getClientRects().length;
      if (next && !visible) { setHintId(currentSlots.current[0]?.id); setOpening(n => n + 1); }
      visible = next;
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ["hidden", "class", "style"] });
    check();
    return () => observer.disconnect();
  }, [active]);
  const dirty = JSON.stringify(slots) !== JSON.stringify(baseline);
  const saving = state === "saving";
  const valid =
    slots.length > 0 &&
    slots.every(
      (slot) => slot.name.trim() && /^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time),
    ) &&
    new Set(slots.map((slot) => slot.time)).size === slots.length;
  function edit(id: string, patch: Partial<Slot>) {
    setSlots(
      slots.map((slot) => (slot.id === id ? { ...slot, ...patch } : slot)),
    );
    setState("idle");
  }
  function reorder(from: number, to: number) {
    if (saving || to < 0 || to >= slots.length) return;
    const next = [...slots];
    const [slot] = next.splice(from, 1);
    next.splice(to, 0, slot);
    setSlots(next);
    setState("idle");
  }
  return (
      <section ref={section} className="settings-section slot-settings-section folio-slots">
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
              const normalized = slots.map((slot) => ({
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
              onClick={() =>
                setSlots([
                  ...slots,
                  { id: crypto.randomUUID(), name: "", time: "" },
                ])
              }
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
          <div className="folio-slot-head" aria-hidden="true"><span>Name</span><span>Time</span><span /></div>
          <Reorder.Group as="div" axis="y" className="slot-list"
            values={slots.map(slot => slot.id)}
            onReorder={(ids: string[]) => {
              if (saving) return;
              setSlots(current => ids.map(id => current.find(slot => slot.id === id)!));
              setState("idle");
            }}>

            <AnimatePresence initial={false}>
            {slots.map((slot, index) => (
              <SlotReorderRow key={slot.id} id={slot.id}
                className="slot-edit-row" disabled={saving} hint={index === 0 && slot.id === hintId ? opening : 0}
                begin={() => slots}
                restore={setSlots}>
                {() => <>
                <span className="folio-slot-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <div className="slot-order-controls">
                  <button type="button" className="slot-order-step" aria-label={`Move ${slot.name || "slot"} up`} disabled={saving || index === 0} onClick={() => reorder(index, index - 1)}>↑</button>
                  <button type="button" className="slot-order-step" aria-label={`Move ${slot.name || "slot"} down`} disabled={saving || index === slots.length - 1} onClick={() => reorder(index, index + 1)}>↓</button>
                </div>
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
                <button
                  type="button"
                  className="remove-slot"
                  aria-label={`Remove slot ${slot.name}`}
                  disabled={saving || slots.length === 1}
                  onClick={() =>
                    setSlots(slots.filter((item) => item.id !== slot.id))
                  }
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></svg>
                </button>
              </>}
              </SlotReorderRow>
            ))}
            </AnimatePresence>
          </Reorder.Group>

        </form>
      </section>
  );
}
// Stable slot IDs own layout animation and cancellation snapshots.
function SlotReorderRow({ id, className, disabled, hint, begin, restore, children }: {
  id: string; className: string; disabled: boolean; hint: number;
  begin: () => Slot[]; restore: (slots: Slot[]) => void;
  children: () => ReactNode;
}) {
  const controls = useDragControls();
  const reduced = useReducedMotion();
  const animation = useAnimationControls();
  useEffect(() => {
    if (hint && !reduced) void animation.start({ y: [0, -4, 4, 0], transition: { duration: .55 } });
    else animation.set({ y: 0 });
    return () => animation.stop();
  }, [hint, reduced, animation]);
  const row = useRef<HTMLDivElement>(null);
  const snapshot = useRef<Slot[] | null>(null);
  const gesture = useRef<{ x: number; y: number; event: PointerEvent; armed: boolean; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const clearSelection = () => {
    window.getSelection()?.removeAllRanges();
    row.current?.querySelectorAll("input").forEach(input => {
      if (input.type === "text") input.setSelectionRange(0, 0);
    });
  };
  const clear = () => {
    if (gesture.current?.timer) clearTimeout(gesture.current.timer);
    gesture.current = null;
  };
  const arm = () => {
    const g = gesture.current;
    if (!g || g.armed) return;
    g.armed = true;
    animation.stop();
    snapshot.current = begin();
    suppressClick.current = true;
    setDragging(true);
    clearSelection();
    (document.activeElement as HTMLElement | null)?.blur();
    controls.start(g.event);
  };
  useEffect(() => {
    const el = row.current!;
    const touchMove = (event: TouchEvent) => { if (gesture.current?.armed) event.preventDefault(); };
    const select = (event: Event) => { if (gesture.current) event.preventDefault(); };
    const selection = () => { if (gesture.current?.armed) clearSelection(); };
    const cancel = () => {
      clear();
      if (snapshot.current) { controls.cancel(); restore(snapshot.current); snapshot.current = null; clearSelection(); }
      setDragging(false);
    };
    el.addEventListener("touchmove", touchMove, { passive: false });
    document.addEventListener("selectstart", select);
    document.addEventListener("selectionchange", selection);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      clear();
      el.removeEventListener("touchmove", touchMove);
      document.removeEventListener("selectstart", select);
      document.removeEventListener("selectionchange", selection);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [controls, restore]);
  return <Reorder.Item ref={row} as="div" value={id} className={className}
    data-slot-id={id} data-dragging={dragging || undefined} data-hint={hint || undefined}
    layout="position" initial={false} exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0, minHeight: 0 }}
    animate={animation}
    transition={{ duration: reduced ? 0 : .4 }}
    dragListener={false} dragControls={controls}
    onPointerDown={event => {
      if (disabled || !event.isPrimary || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
      clear(); suppressClick.current = false;
      gesture.current = { x: event.clientX, y: event.clientY, event: event.nativeEvent, armed: false };
      if (event.pointerType === "touch") gesture.current.timer = setTimeout(arm, 300);
    }}
    onPointerMove={event => {
      const g = gesture.current;
      if (!g) return;
      if (g.armed) { event.preventDefault(); clearSelection(); return; }
      if (Math.hypot(event.clientX - g.x, event.clientY - g.y) > 5) {
        if (event.pointerType === "touch") clear();
        else { event.preventDefault(); arm(); }
      }
    }}
    onPointerUp={() => { if (!gesture.current?.armed) clear(); }}
    onClickCapture={event => { if (suppressClick.current && !(event.target as HTMLElement).closest("button")) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}
    onDragEnd={() => { clearSelection(); snapshot.current = null; clear(); setDragging(false); setTimeout(() => { suppressClick.current = false; }, 100); }}>
    {children()}
  </Reorder.Item>;
}
