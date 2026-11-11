import { useEffect, useRef, useState, type ReactNode } from "react";
import { Reorder, useDragControls, useReducedMotion } from "motion/react";
import type { Meal } from "../types";
import type { StoredRecipe, VariantSummary } from "../recipe";
import { RecipeIcon } from "./RecipeIcon";
import {
  draftFromRecipe, draftIssues, draftPayload, emptyIngredient, emptyPrep, emptyStep,
  recipeRequest, RecipeApiError, sameDraft, type RecipeDraft, type RecipeResponse,
} from "./recipe-draft";
import { AddVariantForm, canAddVariant, RenameVariantForm, variantFromUrl, variantHref, VariantTabs } from "./RecipeVariants";
import "./recipes.css";

type SaveState = "idle" | "saving" | "saved" | "error";

// Edits one recipe variant of a library meal (the default unless the URL
// names another) with the settings Save/Revert convention: Save is enabled
// only by a real valid change, Revert restores the saved snapshot locally.
// Variants show as tabs; the selected one can be renamed, made the default,
// copied into a new version or deleted.
export function RecipeEditor({ mealId, library, refresh }: {
  mealId: string;
  library: Meal[];
  refresh: () => Promise<void>;
}) {
  const meal = library.find((entry) => entry.id === mealId);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [exists, setExists] = useState(false);
  const [variant, setVariant] = useState<VariantSummary | null>(null);
  const [variants, setVariants] = useState<VariantSummary[]>([]);
  const [tool, setTool] = useState<"add" | "rename" | null>(null);
  const [baseline, setBaseline] = useState<RecipeDraft>(() => draftFromRecipe(null));
  const [draft, setDraft] = useState<RecipeDraft>(baseline);
  const [state, setState] = useState<SaveState>("idle");
  const [feedback, setFeedback] = useState("");
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const leaving = useRef(false);

  useEffect(() => {
    let current = true;
    const wanted = variantFromUrl();
    recipeRequest<RecipeResponse>("GET", `/api/recipes/${mealId}${wanted ? `?variant=${encodeURIComponent(wanted)}` : ""}`)
      .then((result) => {
        if (!current) return;
        const loaded = draftFromRecipe(result.recipe);
        setBaseline(loaded);
        setDraft(loaded);
        setExists(true);
        setVariant(result.variant);
        setVariants(result.variants);
        setStatus("ready");
      })
      .catch((error) => {
        if (!current) return;
        // A meal without a recipe opens an empty editor.
        if (error instanceof RecipeApiError && error.status === 404 && error.message === "This meal has no recipe") setStatus("ready");
        else { setFeedback(error.message); setStatus("error"); }
      });
    return () => { current = false; clearTimeout(savedTimer.current); };
  }, [mealId]);

  const dirty = !sameDraft(draft, baseline);
  const issues = draftIssues(draft);
  const saving = state === "saving";
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { if (!leaving.current) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (!focusKey) return;
    document.querySelector<HTMLElement>(`[data-row-key="${focusKey}"] :is(input, textarea)`)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  function edit(patch: Partial<RecipeDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setState("idle");
    setFeedback("");
  }
  function addRow<K extends "ingredients" | "steps" | "prep">(key: K, row: RecipeDraft[K][number], after?: string) {
    setDraft((current) => {
      const rows = [...current[key]] as RecipeDraft[K][number][];
      const index = after ? rows.findIndex((entry) => entry.key === after) + 1 : rows.length;
      rows.splice(index || rows.length, 0, row);
      return { ...current, [key]: rows };
    });
    setState("idle");
    setFocusKey(row.key);
  }

  async function save() {
    if (!dirty || issues.length || saving) return;
    setState("saving");
    setFeedback("");
    const started = performance.now();
    try {
      const result = await recipeRequest<RecipeResponse>(
        "PUT", variant ? `/api/recipes/${mealId}/variants/${variant.id}` : `/api/recipes/${mealId}`, draftPayload(draft));
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 420 - (performance.now() - started))));
      const saved = draftFromRecipeKeepingKeys(result.recipe, draft);
      setBaseline(saved);
      setDraft(saved);
      setExists(true);
      setVariant(result.variant);
      setVariants(result.variants);
      setState("saved");
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setState((current) => (current === "saved" ? "idle" : current)), 1000);
      void refresh().catch(() => {});
    } catch (error) {
      setState("error");
      setFeedback(error instanceof Error ? error.message : "Could not save the recipe");
    }
  }
  const several = variants.length > 1;
  async function remove() {
    const question = several
      ? `Delete the “${variant?.label}” variant of ${meal?.name}? The other variants stay.`
      : `Delete the recipe for “${meal?.name}”? The meal stays in the library.`;
    if (!window.confirm(question)) return;
    try {
      await recipeRequest("DELETE", variant ? `/api/recipes/${mealId}/variants/${variant.id}` : `/api/recipes/${mealId}`);
      leaving.current = true;
      location.href = `/recipes/${mealId}`;
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Could not delete the recipe");
    }
  }
  function applyVariants(result: RecipeResponse) {
    setVariant(result.variant);
    setVariants(result.variants);
    setTool(null);
  }
  async function makeDefault() {
    if (!variant) return;
    try {
      applyVariants(await recipeRequest<RecipeResponse>("PATCH", `/api/recipes/${mealId}/variants/${variant.id}`, { isDefault: true }));
      history.replaceState(history.state, "", `/recipes/${mealId}/edit`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Could not change the default");
    }
  }

  if (!meal)
    return <main className="recipe-shell"><p className="recipe-empty" role="alert">This meal is no longer in the library.</p></main>;
  if (status === "loading")
    return <main className="recipe-shell"><p className="recipe-empty" role="status">Loading recipe…</p></main>;
  if (status === "error")
    return <main className="recipe-shell"><p className="recipe-empty" role="alert">{feedback}</p></main>;
  return (
    <main className="recipe-shell recipe-editor">
      <div className="recipe-title">
        <h1>{meal.name}</h1>
        {meal.aliases.length > 0 && <p className="recipe-aliases">{meal.aliases.join(" · ")}</p>}
      </div>
      {variant && (
        <>
          <VariantTabs variants={variants} selectedId={variant.id} hrefFor={(entry) => variantHref(mealId, entry, true)} />
          {tool === "add" ? (
            <AddVariantForm mealId={mealId} current={variant} variants={variants} onCancel={() => setTool(null)} />
          ) : tool === "rename" ? (
            <RenameVariantForm mealId={mealId} variant={variant} variants={variants} onDone={applyVariants} onCancel={() => setTool(null)} />
          ) : (
            <div className="recipe-variant-tools">
              {several && (
                <button type="button" className="recipe-text-button" disabled={saving} onClick={() => setTool("rename")}>Rename variant</button>
              )}
              {several && !variant.isDefault && (
                <button type="button" className="recipe-text-button" disabled={saving} onClick={() => void makeDefault()}>Make default</button>
              )}
              {canAddVariant(variants) && (
                <button type="button" className="recipe-text-button recipe-add-variant" disabled={saving || dirty}
                  title={dirty ? "Save or revert first" : undefined} onClick={() => setTool("add")}>
                  + {several ? "Variant" : "Add variant"}
                </button>
              )}
            </div>
          )}
        </>
      )}
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="recipe-editor-actions">
          <button className="primary-button slot-save-button recipe-save" data-state={state}
            aria-label={state === "saving" ? "Saving" : state === "saved" ? "Saved" : state === "error" ? "Save failed" : "Save"}
            disabled={saving || !dirty || issues.length > 0}>
            <span className="slot-save-state slot-save-idle">Save</span>
            <span className="slot-save-state slot-save-busy"><span className="button-spinner" /></span>
            <span className="slot-save-state slot-save-done">✓</span>
            <span className="slot-save-state slot-save-error">×</span>
          </button>
          <button type="button" className="recipe-text-button recipe-revert" disabled={saving || !dirty}
            onClick={() => { setDraft(baseline); setState("idle"); setFeedback(""); }}>
            Revert
          </button>
          <span className="recipe-editor-spacer" />
          {exists && !dirty && <a className="secondary-button recipe-view-link" href={variantHref(mealId, variant ?? undefined)}>View recipe</a>}
        </div>
        <p className="recipe-issue" role={feedback ? "alert" : "status"}>
          {feedback || (dirty && issues[0]) || ""}
        </p>

        <div className="recipe-basics">
          <label>
            <span>Serves</span>
            <input value={draft.servings} maxLength={40} disabled={saving} placeholder="4"
              onChange={(event) => edit({ servings: event.target.value })} />
          </label>
          <label>
            <span>Total time (min)</span>
            <input value={draft.totalMinutes} inputMode="numeric" disabled={saving} placeholder="45"
              onChange={(event) => edit({ totalMinutes: event.target.value })} />
          </label>
          <label className="recipe-basics-wide">
            <span>Source link</span>
            <input value={draft.sourceUrl} type="url" inputMode="url" disabled={saving} placeholder="https://…"
              onChange={(event) => edit({ sourceUrl: event.target.value })} />
          </label>
        </div>

        <section className="recipe-editor-section" aria-labelledby="recipe-ingredients-heading">
          <h2 id="recipe-ingredients-heading">Ingredients</h2>
          <SortableRows rows={draft.ingredients} label="ingredient" disabled={saving}
            onChange={(ingredients) => edit({ ingredients })}>
            {(row, index, update) => (
              <div className="recipe-ingredient-fields">
                <label>
                  <span className="visually-hidden">Amount for ingredient {index + 1}</span>
                  <input className="recipe-amount" value={row.amount} placeholder="Amount" maxLength={60} disabled={saving}
                    onChange={(event) => update({ amount: event.target.value })} />
                </label>
                <label>
                  <span className="visually-hidden">Ingredient {index + 1}</span>
                  <input value={row.item} placeholder="Ingredient" maxLength={200} disabled={saving}
                    enterKeyHint="next"
                    onChange={(event) => update({ item: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      addRow("ingredients", emptyIngredient(), row.key);
                    }} />
                </label>
              </div>
            )}
          </SortableRows>
          <button type="button" className="recipe-text-button recipe-add-row" disabled={saving || draft.ingredients.length >= 100}
            onClick={() => addRow("ingredients", emptyIngredient())}>+ Ingredient</button>
        </section>

        <section className="recipe-editor-section" aria-labelledby="recipe-steps-heading">
          <h2 id="recipe-steps-heading">Steps</h2>
          <SortableRows rows={draft.steps} label="step" disabled={saving}
            onChange={(steps) => edit({ steps })}>
            {(row, index, update) => (
              <div className="recipe-step-fields">
                <label>
                  <span className="visually-hidden">Step {index + 1}</span>
                  <textarea value={row.text} rows={2} placeholder={`Step ${index + 1}`} maxLength={2000} disabled={saving}
                    onChange={(event) => update({ text: event.target.value })} />
                </label>
                <label className="recipe-number-field">
                  <RecipeIcon name="timer" />
                  <span className="visually-hidden">Timer minutes for step {index + 1}</span>
                  <input value={row.timerMinutes} inputMode="decimal" placeholder="–" disabled={saving}
                    onChange={(event) => update({ timerMinutes: event.target.value })} />
                  <span aria-hidden="true">min</span>
                </label>
              </div>
            )}
          </SortableRows>
          <button type="button" className="recipe-text-button recipe-add-row" disabled={saving || draft.steps.length >= 60}
            onClick={() => addRow("steps", emptyStep())}>+ Step</button>
        </section>

        <section className="recipe-editor-section" aria-labelledby="recipe-prep-heading">
          <h2 id="recipe-prep-heading">Ahead of time</h2>
          <SortableRows rows={draft.prep} label="ahead-of-time item" disabled={saving}
            onChange={(prep) => edit({ prep })}>
            {(row, index, update) => (
              <div className="recipe-prep-fields">
                <label>
                  <span className="visually-hidden">Ahead-of-time item {index + 1}</span>
                  <input value={row.text} placeholder="Soak urad dal" maxLength={300} disabled={saving}
                    onChange={(event) => update({ text: event.target.value })} />
                </label>
                <label className="recipe-number-field">
                  <span className="visually-hidden">Hours before the meal for item {index + 1}</span>
                  <input value={row.hoursBefore} inputMode="decimal" placeholder="8" disabled={saving}
                    onChange={(event) => update({ hoursBefore: event.target.value })} />
                  <span aria-hidden="true">h before</span>
                </label>
              </div>
            )}
          </SortableRows>
          <button type="button" className="recipe-text-button recipe-add-row" disabled={saving || draft.prep.length >= 20}
            onClick={() => addRow("prep", emptyPrep())}>+ Ahead of time</button>
        </section>

        <section className="recipe-editor-section" aria-labelledby="recipe-notes-heading">
          <h2 id="recipe-notes-heading">Notes</h2>
          <label>
            <span className="visually-hidden">Notes</span>
            <textarea className="recipe-notes" value={draft.notes} rows={4} maxLength={4000} disabled={saving}
              onChange={(event) => edit({ notes: event.target.value })} />
          </label>
        </section>

        {exists && (
          <button type="button" className="danger-button recipe-delete" disabled={saving} onClick={() => void remove()}>
            {several ? "Delete this variant" : "Delete recipe"}
          </button>
        )}
      </form>
    </main>
  );
}

// The server returns the normalised recipe; keep row keys where rows line up so
// focus and animations are not reset by a save.
function draftFromRecipeKeepingKeys(recipe: StoredRecipe, previous: RecipeDraft): RecipeDraft {
  const next = draftFromRecipe(recipe);
  const keep = <T extends { key: string }>(rows: T[], old: { key: string }[]) => {
    const used = old.filter((_, index) => index < rows.length);
    return rows.map((row, index) => ({ ...row, key: used[index]?.key ?? row.key }));
  };
  const filled = <T extends { key: string }>(rows: T[], blank: (row: T) => boolean) => rows.filter((row) => !blank(row));
  return {
    ...next,
    ingredients: keep(next.ingredients, filled(previous.ingredients, (row) => !row.amount.trim() && !row.item.trim())),
    steps: keep(next.steps, filled(previous.steps, (row) => !row.text.trim() && !row.timerMinutes.trim())),
    prep: keep(next.prep, filled(previous.prep, (row) => !row.text.trim() && !row.hoursBefore.trim())),
  };
}

// Ordered rows with the planner's reorder pattern: drag starts on the grip
// (touch included); a stationary tap or keyboard use on the grip swaps it for
// up/down arrows.
function SortableRows<T extends { key: string }>({ rows, label, disabled, onChange, children }: {
  rows: T[];
  label: string;
  disabled: boolean;
  onChange: (rows: T[]) => void;
  children: (row: T, index: number, update: (patch: Partial<T>) => void) => ReactNode;
}) {
  const reduced = useReducedMotion();
  const [arrowsFor, setArrowsFor] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  function move(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    const [row] = next.splice(index, 1);
    next.splice(target, 0, row!);
    onChange(next);
    // Keep focus on an arrow of the moved row, even when one becomes disabled.
    requestAnimationFrame(() => {
      const handle = list.current?.querySelector(`[data-row-key="${row!.key}"] .recipe-row-handle`);
      const buttons = Array.from(handle?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      (buttons[offset < 0 ? 0 : 1]?.disabled ? buttons.find((button) => !button.disabled) : buttons[offset < 0 ? 0 : 1])?.focus();
    });
  }
  return (
    <Reorder.Group as="ol" axis="y" values={rows} onReorder={onChange} className="recipe-rows" ref={list}>
      {rows.map((row, index) => (
        <SortableRow key={row.key} value={row} index={index} count={rows.length} label={label} disabled={disabled}
          reduced={!!reduced} arrows={arrowsFor === row.key}
          showArrows={(show) => setArrowsFor((current) => (show ? row.key : current === row.key ? null : current))}
          move={(offset) => move(index, offset)}
          remove={() => onChange(rows.filter((entry) => entry.key !== row.key))}>
          {children(row, index, (patch) => onChange(rows.map((entry) => (entry.key === row.key ? { ...entry, ...patch } : entry))))}
        </SortableRow>
      ))}
    </Reorder.Group>
  );
}

function SortableRow<T extends { key: string }>({ value, index, count, label, disabled, reduced, arrows, showArrows, move, remove, children }: {
  value: T;
  index: number;
  count: number;
  label: string;
  disabled: boolean;
  reduced: boolean;
  arrows: boolean;
  showArrows: (show: boolean) => void;
  move: (offset: number) => void;
  remove: () => void;
  children: ReactNode;
}) {
  const controls = useDragControls();
  const dragged = useRef(false);
  const handle = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (arrows) handle.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [arrows]);
  const name = `${label} ${index + 1}`;
  return (
    <Reorder.Item as="li" value={value} dragListener={false} dragControls={controls} data-row-key={value.key}
      className="recipe-row" transition={{ duration: reduced ? 0 : 0.25 }}
      onDragStart={() => { dragged.current = true; showArrows(false); }}>
      <div className="recipe-row-handle" ref={handle}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) showArrows(false); }}>
        {arrows ? (
          <>
            <button type="button" aria-label={`Move ${name} up`} disabled={disabled || index === 0} onClick={() => move(-1)}>
              <RecipeIcon name="chevron-up" />
            </button>
            <button type="button" aria-label={`Move ${name} down`} disabled={disabled || index === count - 1} onClick={() => move(1)}>
              <RecipeIcon name="chevron-down" />
            </button>
          </>
        ) : (
          <button type="button" className="recipe-grip" aria-label={`Reorder ${name}`} disabled={disabled || count < 2}
            onPointerDown={(event) => { dragged.current = false; if (event.button === 0) controls.start(event); }}
            onClick={() => { if (!dragged.current) showArrows(true); dragged.current = false; }}>
            <RecipeIcon name="grip-vertical" />
          </button>
        )}
      </div>
      <div className="recipe-row-fields">{children}</div>
      <button type="button" className="recipe-row-remove" aria-label={`Remove ${name}`} disabled={disabled} onClick={remove}>
        <RecipeIcon name="trash-2" />
      </button>
    </Reorder.Item>
  );
}
