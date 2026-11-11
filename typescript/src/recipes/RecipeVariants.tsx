import { useEffect, useRef, useState } from "react";
import { cleanVariantLabel, maxVariantLabelLength, maxVariants, variantLabelKey, type VariantSummary } from "../recipe";
import { recipeRequest, type RecipeResponse } from "./recipe-draft";

// The variant a recipe URL asks for (?variant=<id>), if any.
export function variantFromUrl() {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("variant") ?? undefined;
}

// "/recipes/<id>" for the default variant, "…?variant=<vid>" for another.
export function variantHref(mealId: string, variant: VariantSummary | undefined, edit = false) {
  const base = `/recipes/${mealId}${edit ? "/edit" : ""}`;
  return variant && !variant.isDefault ? `${base}?variant=${variant.id}` : base;
}

// A meal with several recipe variants shows them as tabs; a meal with one
// shows nothing. The default variant is marked.
export function VariantTabs({ variants, selectedId, onSelect, hrefFor }: {
  variants: VariantSummary[];
  selectedId: string;
  onSelect?: (variant: VariantSummary) => void;
  hrefFor?: (variant: VariantSummary) => string;
}) {
  if (variants.length < 2) return null;
  return (
    <div className="recipe-variant-tabs" role={onSelect ? "tablist" : undefined} aria-label="Variants of this recipe">
      {variants.map((variant) => {
        const selected = variant.id === selectedId;
        const content = (
          <>
            <span>{variant.label}</span>
            {variant.isDefault && <small className="recipe-variant-default" title="Default: used for prep reminders">default</small>}
          </>
        );
        return onSelect ? (
          <button key={variant.id} type="button" role="tab" aria-selected={selected}
            className="recipe-variant-tab" onClick={() => onSelect(variant)}>
            {content}
          </button>
        ) : (
          <a key={variant.id} href={hrefFor!(variant)} className="recipe-variant-tab" aria-current={selected ? "page" : undefined}>
            {content}
          </a>
        );
      })}
    </div>
  );
}

function labelProblem(label: string, others: VariantSummary[], except?: string) {
  const cleaned = cleanVariantLabel(label);
  if (!cleaned) return "Give it a short name";
  if (cleaned.length > maxVariantLabelLength) return `At most ${maxVariantLabelLength} characters`;
  if (others.some((other) => other.id !== except && variantLabelKey(other.label) === variantLabelKey(cleaned)))
    return "Another variant already has this name";
  return "";
}

// Adds a variant as a copy of `current` (variants share most of their
// content), then opens it in the editor. A meal whose only recipe has no label
// names that one too.
export function AddVariantForm({ mealId, current, variants, onCancel }: {
  mealId: string;
  current: VariantSummary;
  variants: VariantSummary[];
  onCancel: () => void;
}) {
  const nameExisting = variants.length === 1 && !variants[0]!.label;
  const [existing, setExisting] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const named = nameExisting ? [{ ...variants[0]!, label: existing }] : variants;
  const problem = (nameExisting && labelProblem(existing, [])) || labelProblem(label, named);
  async function submit() {
    if (problem || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await recipeRequest<RecipeResponse>("POST", `/api/recipes/${mealId}/variants`, {
        label,
        copyFrom: current.id,
        ...(nameExisting ? { existingLabel: existing } : {}),
      });
      location.href = variantHref(mealId, result.variant, true);
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : "Could not add the variant");
    }
  }
  return (
    <form className="recipe-variant-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <p className="recipe-variant-form-title">
        New variant, copied from {current.label ? `“${current.label}”` : "this recipe"}
      </p>
      {nameExisting && (
        <label>
          <span>This recipe</span>
          <input ref={first} value={existing} maxLength={maxVariantLabelLength} placeholder="Non-fry" disabled={busy}
            onChange={(event) => setExisting(event.target.value)} />
        </label>
      )}
      <label>
        <span>New variant</span>
        <input ref={nameExisting ? undefined : first} value={label} maxLength={maxVariantLabelLength} placeholder="Fry" disabled={busy}
          onChange={(event) => setLabel(event.target.value)} />
      </label>
      <p className="recipe-issue" role={error ? "alert" : "status"}>{error || ((existing || label) && problem) || ""}</p>
      <div className="recipe-variant-form-actions">
        <button className="primary-button" disabled={busy || !!problem}>Add variant</button>
        <button type="button" className="recipe-text-button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function RenameVariantForm({ mealId, variant, variants, onDone, onCancel }: {
  mealId: string;
  variant: VariantSummary;
  variants: VariantSummary[];
  onDone: (result: RecipeResponse) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(variant.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const problem = labelProblem(label, variants, variant.id);
  const unchanged = cleanVariantLabel(label) === variant.label;
  async function submit() {
    if (unchanged) return onCancel();
    if (problem || busy) return;
    setBusy(true);
    try {
      onDone(await recipeRequest<RecipeResponse>("PATCH", `/api/recipes/${mealId}/variants/${variant.id}`, { label }));
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : "Could not rename the variant");
    }
  }
  return (
    <form className="recipe-variant-form recipe-variant-rename" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label>
        <span>Variant name</span>
        <input ref={input} value={label} maxLength={maxVariantLabelLength} disabled={busy}
          onChange={(event) => { setLabel(event.target.value); setError(""); }}
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCancel(); } }} />
      </label>
      <p className="recipe-issue" role={error ? "alert" : "status"}>{error || (!unchanged && problem) || ""}</p>
      <div className="recipe-variant-form-actions">
        <button className="primary-button" disabled={busy || (!unchanged && !!problem)}>Rename</button>
        <button type="button" className="recipe-text-button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export const canAddVariant = (variants: VariantSummary[]) => variants.length > 0 && variants.length < maxVariants;
