import { useCallback, useEffect, useRef, useState } from "react";
import type { Meal } from "../types";
import { formatHoursBefore, formatMinutes, type StoredRecipe } from "../recipe";
import { RecipeIcon } from "./RecipeIcon";
import { recipeRequest, RecipeApiError, type RecipeResponse } from "./recipe-draft";
import "./recipes.css";

type Load =
  | { status: "loading" }
  | { status: "ready"; meal: Meal; recipe: StoredRecipe }
  | { status: "none" }
  | { status: "error"; message: string };

function sourceLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// A recipe to read at arm's length: ahead-of-time work, an ingredient
// checklist (ticks stay on this device and are not saved), steps, notes, and
// a step-by-step cook mode.
export function RecipePage({ mealId, library }: { mealId: string; library: Meal[] }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const [cooking, setCooking] = useState(false);
  const libraryMeal = library.find((entry) => entry.id === mealId);
  const fetchRecipe = useCallback(() => {
    recipeRequest<RecipeResponse>("GET", `/api/recipes/${mealId}`)
      .then((result) => setLoad({ status: "ready", ...result }))
      .catch((error) => {
        if (error instanceof RecipeApiError && error.status === 404 && error.message === "This meal has no recipe") setLoad({ status: "none" });
        else setLoad({ status: "error", message: error instanceof Error ? error.message : "Could not load the recipe" });
      });
  }, [mealId]);
  useEffect(() => {
    fetchRecipe();
    // Returning from the editor through the back/forward cache shows fresh data.
    const shown = (event: PageTransitionEvent) => { if (event.persisted) fetchRecipe(); };
    window.addEventListener("pageshow", shown);
    return () => window.removeEventListener("pageshow", shown);
  }, [fetchRecipe]);
  const toggle = (index: number) =>
    setTicked((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });

  if (load.status === "loading")
    return <main className="recipe-shell"><p className="recipe-empty" role="status">Loading recipe…</p></main>;
  if (load.status === "error")
    return <main className="recipe-shell"><p className="recipe-empty" role="alert">{load.message}</p></main>;
  if (load.status === "none")
    return (
      <main className="recipe-shell recipe-read">
        <div className="recipe-title"><h1>{libraryMeal?.name ?? "Recipe"}</h1></div>
        <p className="recipe-empty">No recipe yet.</p>
        <a className="primary-button recipe-primary" href={`/recipes/${mealId}/edit`}>Add recipe</a>
      </main>
    );
  const { meal, recipe } = load;
  const facts = [
    recipe.servings && `Serves ${recipe.servings}`,
    recipe.totalMinutes && formatMinutes(recipe.totalMinutes),
  ].filter(Boolean);
  return (
    <main className="recipe-shell recipe-read">
      <div className="recipe-title">
        <h1>{meal.name}</h1>
        {meal.aliases.length > 0 && <p className="recipe-aliases">{meal.aliases.join(" · ")}</p>}
        {(facts.length > 0 || recipe.sourceUrl) && (
          <p className="recipe-facts">
            {facts.join(" · ")}
            {recipe.sourceUrl && (
              <>
                {facts.length > 0 && " · "}
                <a href={recipe.sourceUrl} target="_blank" rel="noopener noreferrer">{sourceLabel(recipe.sourceUrl)} ↗</a>
              </>
            )}
          </p>
        )}
      </div>
      <div className="recipe-read-actions">
        {recipe.steps.length > 0 && (
          <button type="button" className="primary-button recipe-primary" onClick={() => setCooking(true)}>Cook</button>
        )}
        <a className="secondary-button" href={`/recipes/${mealId}/edit`}>Edit</a>
      </div>

      {recipe.prep.length > 0 && (
        <section className="recipe-section" aria-labelledby="recipe-ahead">
          <h2 id="recipe-ahead">Ahead of time</h2>
          <ul className="recipe-prep-list">
            {recipe.prep.map((item, index) => (
              <li key={index}><span>{item.text}</span><small>{formatHoursBefore(item.hoursBefore)}</small></li>
            ))}
          </ul>
        </section>
      )}

      {recipe.ingredients.length > 0 && (
        <section className="recipe-section" aria-labelledby="recipe-ingredients">
          <div className="recipe-section-heading">
            <h2 id="recipe-ingredients">Ingredients</h2>
            {ticked.size > 0 && (
              <button type="button" className="text-link-button" onClick={() => setTicked(new Set())}>Clear ticks</button>
            )}
          </div>
          <IngredientChecklist recipe={recipe} ticked={ticked} toggle={toggle} />
        </section>
      )}

      {recipe.steps.length > 0 && (
        <section className="recipe-section" aria-labelledby="recipe-steps">
          <h2 id="recipe-steps">Steps</h2>
          <ol className="recipe-step-list">
            {recipe.steps.map((step, index) => (
              <li key={index}>
                <span className="recipe-step-number" aria-hidden="true">{index + 1}</span>
                <div>
                  <p>{step.text}</p>
                  {step.timerMinutes && (
                    <small className="recipe-timer-note"><RecipeIcon name="timer" />{formatMinutes(step.timerMinutes)}</small>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {recipe.notes && (
        <section className="recipe-section" aria-labelledby="recipe-notes">
          <h2 id="recipe-notes">Notes</h2>
          <p className="recipe-notes-text">{recipe.notes}</p>
        </section>
      )}
      {cooking && (
        <CookMode name={meal.name} recipe={recipe} ticked={ticked} toggle={toggle} onClose={() => setCooking(false)} />
      )}
    </main>
  );
}

function IngredientChecklist({ recipe, ticked, toggle }: {
  recipe: StoredRecipe;
  ticked: ReadonlySet<number>;
  toggle: (index: number) => void;
}) {
  return (
    <ul className="recipe-checklist">
      {recipe.ingredients.map((ingredient, index) => (
        <li key={index}>
          <label className={ticked.has(index) ? "is-ticked" : undefined}>
            <input type="checkbox" checked={ticked.has(index)} onChange={() => toggle(index)} />
            <span>
              {ingredient.amount && <strong>{ingredient.amount}</strong>}
              {ingredient.amount && " "}
              {ingredient.item}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

type Timer = { endsAt: number; minutes: number };

function clock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

// One step at a time in large text. Tapping the step advances; timers keep
// running across steps; the screen stays awake (Wake Lock API) while open.
function CookMode({ name, recipe, ticked, toggle, onClose }: {
  name: string;
  recipe: StoredRecipe;
  ticked: ReadonlySet<number>;
  toggle: (index: number) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(0);
  const [showIngredients, setShowIngredients] = useState(false);
  const [timers, setTimers] = useState<ReadonlyMap<number, Timer>>(new Map());
  const [now, setNow] = useState(Date.now());
  const [wakeLock, setWakeLock] = useState<"on" | "off" | "unsupported">("off");
  const audio = useRef<AudioContext | null>(null);
  const rang = useRef(new Set<number>());
  const steps = recipe.steps;
  const step = steps[index]!;
  const last = index === steps.length - 1;

  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    if (!("wakeLock" in navigator)) {
      setWakeLock("unsupported");
      return;
    }
    let lock: WakeLockSentinel | null = null;
    let open = true;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || (lock && !lock.released)) return;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (!open) { void next.release(); return; }
        lock = next;
        setWakeLock("on");
        next.addEventListener("release", () => { if (open) setWakeLock("off"); });
      } catch {
        setWakeLock("off");
      }
    };
    void acquire();
    // The browser drops the lock when the page is hidden; take it again.
    document.addEventListener("visibilitychange", acquire);
    return () => {
      open = false;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release().catch(() => {});
    };
  }, []);
  const running = [...timers.entries()];
  useEffect(() => {
    if (!running.length) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [running.length]);
  useEffect(() => {
    for (const [stepIndex, timer] of timers) {
      if (timer.endsAt > now || rang.current.has(stepIndex)) continue;
      rang.current.add(stepIndex);
      navigator.vibrate?.([300, 150, 300, 150, 300]);
      const context = audio.current;
      if (context) {
        for (let beep = 0; beep < 3; beep++) {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.frequency.value = 880;
          gain.gain.value = 0.2;
          oscillator.connect(gain).connect(context.destination);
          const start = context.currentTime + beep * 0.45;
          oscillator.start(start);
          oscillator.stop(start + 0.25);
        }
      }
    }
  }, [now, timers]);
  useEffect(() => () => void audio.current?.close().catch(() => {}), []);

  function go(offset: number) {
    setIndex((current) => Math.min(steps.length - 1, Math.max(0, current + offset)));
  }
  function startTimer(stepIndex: number, minutes: number) {
    // Created on a tap so the browser allows sound when the timer ends.
    try {
      audio.current ??= new AudioContext();
      void audio.current.resume();
    } catch {}
    rang.current.delete(stepIndex);
    setNow(Date.now());
    setTimers((current) => new Map(current).set(stepIndex, { endsAt: Date.now() + minutes * 60000, minutes }));
  }
  function stopTimer(stepIndex: number) {
    rang.current.delete(stepIndex);
    setTimers((current) => {
      const next = new Map(current);
      next.delete(stepIndex);
      return next;
    });
  }
  const timer = timers.get(index);
  return (
    <dialog ref={dialog} className="cook-mode" aria-label={`Cook ${name}`} data-wake-lock={wakeLock}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        const target = event.target as Element;
        if (target.closest("input, label")) return;
        // Space keeps activating a focused button; arrows always turn the page.
        if (event.key === "ArrowRight" || (event.key === " " && !target.closest("button"))) { event.preventDefault(); go(1); }
        if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
      }}>
      <header className="cook-top">
        <span className="cook-progress" aria-live="polite">Step {index + 1} of {steps.length}</span>
        {recipe.ingredients.length > 0 && (
          <button type="button" className="cook-chip" aria-expanded={showIngredients} onClick={() => setShowIngredients((shown) => !shown)}>
            Ingredients
          </button>
        )}
        <button type="button" className="cook-close" aria-label="Leave cook mode" onClick={onClose}>
          <RecipeIcon name="x" />
        </button>
      </header>
      {running.some(([stepIndex]) => stepIndex !== index) && (
        <div className="cook-timers" role="group" aria-label="Timers on other steps">
          {running.filter(([stepIndex]) => stepIndex !== index).map(([stepIndex, entry]) => {
            const done = entry.endsAt <= now;
            return (
              <button type="button" key={stepIndex} className={`cook-timer-chip${done ? " is-done" : ""}`}
                onClick={() => (done ? stopTimer(stepIndex) : setIndex(stepIndex))}
                aria-label={done ? `Step ${stepIndex + 1} timer finished. Dismiss` : `Step ${stepIndex + 1} timer, ${clock(entry.endsAt - now)} left. Go to step`}>
                <RecipeIcon name="timer" />
                <span>Step {stepIndex + 1}</span>
                <strong>{done ? "Done" : clock(entry.endsAt - now)}</strong>
              </button>
            );
          })}
        </div>
      )}
      {showIngredients ? (
        <div className="cook-ingredients">
          <IngredientChecklist recipe={recipe} ticked={ticked} toggle={toggle} />
        </div>
      ) : (
        <div className="cook-step" onClick={() => { if (!last) go(1); }}>
          <p key={index} className="cook-step-text">{step.text}</p>
        </div>
      )}
      {step.timerMinutes && !showIngredients && (
        <div className="cook-timer-row">
          {timer ? (
            <button type="button" className={`cook-timer-button${timer.endsAt <= now ? " is-done" : ""}`} onClick={() => stopTimer(index)}>
              <RecipeIcon name="timer" />
              {timer.endsAt <= now ? "Time's up · Dismiss" : `${clock(timer.endsAt - now)} · Stop`}
            </button>
          ) : (
            <button type="button" className="cook-timer-button" onClick={() => startTimer(index, step.timerMinutes!)}>
              <RecipeIcon name="timer" />Start {formatMinutes(step.timerMinutes)} timer
            </button>
          )}
        </div>
      )}
      <footer className="cook-nav">
        <button type="button" className="secondary-button" disabled={index === 0} onClick={() => go(-1)}>‹ Back</button>
        {last ? (
          <button type="button" className="primary-button" onClick={onClose}>Finish</button>
        ) : (
          <button type="button" className="primary-button" onClick={() => go(1)}>Next ›</button>
        )}
      </footer>
    </dialog>
  );
}
