import { useEffect, useState } from "react";
import type { Board, Slot } from "./types";
export function SettingsPage({
  board,
  post,
  refresh,
}: {
  board: Board;
  post: (path: string, body: unknown) => Promise<unknown>;
  refresh: () => Promise<void>;
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Tab")
        document.body.classList.add("keyboard-navigation");
    };
    const pointer = () => document.body.classList.remove("keyboard-navigation");
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", pointer);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", pointer);
      document.body.classList.remove("keyboard-navigation");
    };
  }, []);
  const [baseline, setBaseline] = useState(board.slots);
  const [revision, setRevision] = useState(board.settings.revision);
  const [slots, setSlots] = useState(board.slots);
  const [state, setState] = useState("idle");
  const [feedback, setFeedback] = useState("");
  const [reordering, setReordering] = useState("");
  const [search, setSearch] = useState("");
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
  async function action(path: string, body: unknown) {
    try {
      await post(path, body);
      await refresh();
      setFeedback("");
    } catch (error) {
      setFeedback((error as Error).message);
    }
  }
  return (
    <main className="settings-shell">
      <h1>Settings</h1>
      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h2>Appearance</h2>
            <p>System follows your device.</p>
          </div>
        </div>
        <fieldset className="theme-options">
          <legend className="visually-hidden">Color theme</legend>
          {(["system", "light", "dark"] as const).map((theme) => (
            <label className="theme-option" key={theme}>
              <input
                type="radio"
                name="theme"
                checked={board.settings.theme === theme}
                onChange={() => void action("/api/settings/theme", { theme })}
              />
              <span>
                <strong>{theme[0].toUpperCase() + theme.slice(1)}</strong>
                <small>
                  {theme === "system"
                    ? "Use this device’s light or dark setting"
                    : `Always use the ${theme} theme`}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
      </section>
      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h2>Manage meal library</h2>
            <p>
              Remove reusable choices here. Meals already planned stay
              unchanged.
            </p>
          </div>
          <span className="settings-count">{board.library.length}</span>
        </div>
        <label htmlFor="manage-search">Find a meal</label>
        <input
          id="manage-search"
          className="library-manager-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="manage-library-list">
          {board.library
            .filter((meal) =>
              meal.name.toLowerCase().includes(search.toLowerCase()),
            )
            .map((meal) => (
              <div className="manage-meal-row" key={meal.id}>
                <span className="manage-meal-name">{meal.name}</span>
                <button
                  className="manage-remove-meal"
                  aria-label={`Remove ${meal.name} from library`}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove “${meal.name}” from the reusable library? Planned meals will stay unchanged.`,
                      )
                    )
                      void action("/api/library/remove", { mealId: meal.id });
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
        </div>
      </section>
      <section className="settings-section slot-settings-section">
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
          <div className="slot-list">
            {slots.map((slot, index) => (
              <div
                className={`slot-edit-row${reordering === slot.id ? " reorder-actions-open" : ""}`}
                key={slot.id}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = e.dataTransfer.getData("application/x-slot");
                  if (from) reorder(Number(from), index);
                }}
              >
                <div className="slot-order-controls">
                  <button
                    type="button"
                    className="slot-edit-grip"
                    aria-label={`Reorder ${slot.name || "slot"}`}
                    draggable={!saving}
                    onClick={() =>
                      setReordering(reordering === slot.id ? "" : slot.id)
                    }
                    onDragStart={(e) =>
                      e.dataTransfer.setData(
                        "application/x-slot",
                        String(index),
                      )
                    }
                  >
                    ⠿
                  </button>
                  <button
                    type="button"
                    className="slot-order-step"
                    aria-label={`Move ${slot.name || "slot"} up`}
                    disabled={saving || index === 0}
                    onClick={() => reorder(index, index - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="slot-order-step"
                    aria-label={`Move ${slot.name || "slot"} down`}
                    disabled={saving || index === slots.length - 1}
                    onClick={() => reorder(index, index + 1)}
                  >
                    ↓
                  </button>
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
                  ×
                </button>
              </div>
            ))}
          </div>
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
            </div>
          </div>
        </form>
      </section>
      <p className="settings-feedback" role={feedback ? "alert" : "status"}>
        {feedback}
      </p>
    </main>
  );
}
