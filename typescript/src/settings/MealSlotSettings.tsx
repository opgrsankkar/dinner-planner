import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import "./MealSlotSettings.css";
import { sortSlotsByTime, validSlotTime } from "../slot-order";
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
export function MealSlotSettings({ initialSlots, initialRevision, post, refresh, setFeedback }: MealSlotSettingsProps) {
  const reduced = useReducedMotion();
  const [baseline, setBaseline] = useState(() => sortSlotsByTime(initialSlots));
  const [revision, setRevision] = useState(initialRevision);
  const [slots, setSlots] = useState(() => sortSlotsByTime(initialSlots));
  const [state, setState] = useState("idle");
  const dirty = JSON.stringify(slots) !== JSON.stringify(baseline);
  const saving = state === "saving";
  const valid =
    slots.length > 0 &&
    slots.every(
      (slot) => slot.name.trim() && validSlotTime(slot.time),
    ) &&
    new Set(slots.map((slot) => slot.time)).size === slots.length;
  function edit(id: string, patch: Partial<Slot>) {
    setSlots(current => sortSlotsByTime(
      current.map(slot => slot.id === id ? { ...slot, ...patch } : slot),
    ));
    setState("idle");
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
                setSlots([...slots, { id: crypto.randomUUID(), name: "", time: "" }]);
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
              <motion.div key={slot.id} className="slot-edit-row" data-slot-id={slot.id}
                layout={reduced ? false : "position"} initial={false}
                exit={reduced ? undefined : { opacity: 0, height: 0, minHeight: 0 }}
                transition={{ duration: reduced ? 0 : .4 }}>
                <span className="folio-slot-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
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
                  onClick={() => {
                    setSlots(sortSlotsByTime(slots.filter((item) => item.id !== slot.id)));
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
