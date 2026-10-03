import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { SettingsPage } from "../settings";
import { WeekPicker } from "../WeekPicker";
import type { Board, Meal, Card, Slot } from "../types";
import { defaultPlanPlacement } from "../plan-default";
export const Route = createFileRoute("/")({ component: Planner });
type Intent = {
  requestId: string;
  mealId?: string;
  taskId?: string;
  kind?: "move" | "delete";
  slotId: string;
  date: string;
};
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const iso = (date: Date) => date.toISOString().slice(0, 10);
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
function monday() {
  const day = new Date(today() + "T12:00:00Z");
  day.setUTCHours(12, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return iso(day);
}
function containDialogTab(event: ReactKeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget;
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getClientRects().length > 0);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  if (
    event.shiftKey &&
    (active === first || active === dialog || active?.id === "plan-title")
  ) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || active === dialog)) {
    event.preventDefault();
    first.focus();
  }
}
function Icon({ name, spin = false }: { name: string; spin?: boolean }) {
  return (
    <svg className={`ui-icon${spin ? " sync-spinner" : ""}`} aria-hidden="true">
      <use href={`/static/lucide-icons.svg#${name}`} />
    </svg>
  );
}
export function Planner() {
  const settingsPage = useLocation().pathname === "/settings";
  const [moving, setMoving] = useState<Card | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const boardRef = useRef<Board | null>(board);
  boardRef.current = board;
  const changeRef = useRef<(card: Card, kind: "move" | "delete", date?: string, slot?: Slot) => Promise<void>>(async () => {});
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [search, setSearch] = useState("");
  const [libraryAdding, setLibraryAdding] = useState(false);
  const [libraryInvalid, setLibraryInvalid] = useState(false);
  const [libraryFeedback, setLibraryFeedback] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const librarySubmitting = useRef(false);
  const libraryInput = useRef<HTMLInputElement>(null);
  const libraryAnimations = useRef<Animation[]>([]);
  const libraryDragged = useRef(false);
  const dragFinishedAt = useRef(0);
  const dragFinishedCardId = useRef<string | null>(null);
  const touchDrag = useRef<{
    card: Card;
    source: HTMLDivElement;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
    active: boolean;
    scrolling: boolean;
  } | null>(null);
  useEffect(() => () => libraryAnimations.current.forEach(animation => animation.cancel()), []);
  useEffect(() => {
    const clearTouchDrag = () => {
      const drag = touchDrag.current;
      if (drag) {
        clearTimeout(drag.timer);
        drag.source.classList.remove("is-touch-dragging");
        if (drag.active) {
          dragFinishedAt.current = Date.now();
          dragFinishedCardId.current = drag.card.id;
        }
      }
      touchDrag.current = null;
      document.body.classList.remove("planner-dragging", "trash-hover");
      document.querySelectorAll(".meal-cell.touch-drop-hover").forEach((cell) => cell.classList.remove("touch-drop-hover"));
    };
    const touchMove = (event: TouchEvent) => {
      const drag = touchDrag.current;
      if (!drag || !event.touches.length) return;
      const touch = event.touches[0]!;
      if (!drag.active) {
        if (Math.hypot(touch.clientX - drag.startX, touch.clientY - drag.startY) > 10) {
          clearTimeout(drag.timer);
          drag.scrolling = true;
        }
        if (drag.scrolling) {
          event.preventDefault();
          const dx = touch.clientX - drag.lastX;
          const dy = touch.clientY - drag.lastY;
          const grid = drag.source.closest<HTMLElement>(".grid-scroll");
          if (Math.abs(dx) > Math.abs(dy) && grid) grid.scrollLeft -= dx;
          else window.scrollBy({ top: -dy, left: 0 });
          drag.lastX = touch.clientX;
          drag.lastY = touch.clientY;
        }
        return;
      }
      event.preventDefault();
      drag.x = touch.clientX;
      drag.y = touch.clientY;
      const target = document.elementFromPoint(drag.x, drag.y);
      const overTrash = !!target?.closest(".trash-drop-target");
      document.body.classList.toggle("trash-hover", overTrash);
      document.querySelectorAll(".meal-cell.touch-drop-hover").forEach((cell) => cell.classList.remove("touch-drop-hover"));
      target?.closest(".meal-cell")?.classList.add("touch-drop-hover");
    };
    const touchEnd = (event: TouchEvent) => {
      const drag = touchDrag.current;
      if (!drag) return;
      if (event.changedTouches.length) {
        drag.x = event.changedTouches[0]!.clientX;
        drag.y = event.changedTouches[0]!.clientY;
      }
      const active = drag.active;
      const scrolling = drag.scrolling;
      const target = document.elementFromPoint(drag.x, drag.y);
      const cell = target?.closest<HTMLElement>(".meal-cell[data-date][data-slot-id]");
      const overTrash = !!target?.closest(".trash-drop-target");
      const card = drag.card;
      const source = drag.source;
      clearTouchDrag();
      if (scrolling) {
        event.preventDefault();
        return;
      }
      if (!active) return;
      event.preventDefault();
      dragFinishedAt.current = Date.now();
      dragFinishedCardId.current = card.id;
      if (overTrash && card.state === "saved" && !card.completed) {
        dialogTrigger.current = source;
        setDeleteTarget(card);
        deleteDialog.current?.showModal();
      } else if (cell && card.state === "saved" && !card.completed) {
        const slot = boardRef.current?.slots.find((item) => item.id === cell.dataset.slotId);
        if (slot && (cell.dataset.date !== card.date || slot.id !== card.slotId))
          void changeRef.current(card, "move", cell.dataset.date, slot);
      }
    };
    const cancelTouchDrag = () => clearTouchDrag();
    const finishPlannedDrag = () => {
      clearTouchDrag();
    };
    const cancelPlannedDrag = (event: KeyboardEvent) => {
      if (event.key === "Escape") finishPlannedDrag();
    };
    window.addEventListener("dragend", finishPlannedDrag, true);
    window.addEventListener("drop", finishPlannedDrag, true);
    window.addEventListener("blur", finishPlannedDrag);
    window.addEventListener("touchmove", touchMove, { passive: false });
    window.addEventListener("touchend", touchEnd, { passive: false });
    window.addEventListener("touchcancel", cancelTouchDrag);
    document.addEventListener("keydown", cancelPlannedDrag, true);
    return () => {
      window.removeEventListener("dragend", finishPlannedDrag, true);
      window.removeEventListener("drop", finishPlannedDrag, true);
      window.removeEventListener("blur", finishPlannedDrag);
      window.removeEventListener("touchmove", touchMove);
      window.removeEventListener("touchend", touchEnd);
      window.removeEventListener("touchcancel", cancelTouchDrag);
      document.removeEventListener("keydown", cancelPlannedDrag, true);
      finishPlannedDrag();
    };
  }, []);

  function animateLibraryInvalid(reset = false) {
    const field = libraryInput.current;
    if (!field) return;
    const previousColor = getComputedStyle(field).color;
    libraryAnimations.current.forEach(animation => animation.cancel());
    const ink = getComputedStyle(field).color;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const red = document.documentElement.dataset.theme === "dark" ? "#ff8c9c" : "#b42335";
    libraryAnimations.current = [field.animate([
      { color: reset ? previousColor : red, offset: 0 },
      { color: reset ? previousColor : red, offset: reset ? 0 : reduced ? 1 / 6 : .5, easing: "ease-out" },
      { color: ink, offset: 1 },
    ], { duration: reset ? 180 : reduced ? 240 : 600, easing: "linear" })];
    if (!reset && !reduced) libraryAnimations.current.push(field.animate([
      { transform: "translateX(0)" }, { transform: "translateX(-4px)" },
      { transform: "translateX(4px)" }, { transform: "translateX(-4px)" },
      { transform: "translateX(0)" },
    ], { duration: 300, easing: "ease-in-out" }));
  }

  async function addLibraryMeal() {
    if (librarySubmitting.current) return;
    const trimmed = search.trim();
    if (!trimmed) {
      setLibraryInvalid(true);
      animateLibraryInvalid();
      libraryInput.current?.focus();
      return;
    }
    librarySubmitting.current = true;
    setLibraryAdding(true);
    setLibraryFeedback("");
    setLibraryError("");
    try {
      await post("/api/library", { name: trimmed });
      setSearch("");
      setLibraryFeedback(`Added ${trimmed} to the meal library.`);
      await refresh();
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "Could not add meal. Please try again.");
    } finally {
      librarySubmitting.current = false;
      setLibraryAdding(false);
    }
  }
  const [week, setWeek] = useState(monday);
  const isCurrentWeek = week === monday();
  const [target, setTarget] = useState<Meal | null>(null);
  const [day, setDay] = useState(week);
  const [slotId, setSlotId] = useState("");
  const [planDefaultAvailable, setPlanDefaultAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [theme, setTheme] = useState("system");
  const [effectiveTheme, setEffectiveTheme] = useState("light");
  const [coarsePointer, setCoarsePointer] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(pointer: coarse)").matches,
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Card | null>(null);
  const local = useRef(new Map<string, Card>());
  const intents = useRef(new Map<string, Intent>());
  function persistIntents() {
    sessionStorage.setItem(
      "planner-pending-http",
      JSON.stringify(
        [...local.current.values()].map((card) => ({
          card,
          intent: intents.current.get(card.requestId),
        })),
      ),
    );
  }
  const csrf = board?.csrf ?? "";
  const refresh = useCallback(async () => {
    const response = await fetch(`/api/board?week=${week}`);
    if (response.status === 401) {
      setSignedOut(true);
      setBoard(null);
      return;
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const next = result as Board;
    for (const requestId of next.receivedRequests) {
      local.current.delete(requestId);
      intents.current.delete(requestId);
    }
    persistIntents();
    next.cards = next.cards.filter(
      (card) =>
        ![...local.current.values()].some((local) => local.id === card.id),
    );
    next.cards.push(...local.current.values());
    setBoard(next);
    setSignedOut(false);
    setNow(Date.now());
  }, [week]);
  useEffect(() => {
    try {
      const saved = JSON.parse(
        sessionStorage.getItem("planner-pending-http") ?? "[]",
      ) as { card: Card; intent: Intent }[];
      for (const entry of saved) {
        if (entry.card && entry.intent) {
          local.current.set(entry.card.requestId, entry.card);
          intents.current.set(entry.card.requestId, entry.intent);
        }
      }
    } catch {
      sessionStorage.removeItem("planner-pending-http");
    }
    const update = () => {
      void refresh().catch((e) => setError(String(e.message)));
    };
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (board) setTheme(board.settings.theme);
  }, [board?.settings.theme]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      setEffectiveTheme(resolved);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    const media = matchMedia("(pointer: coarse)");
    const update = () => setCoarsePointer(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  async function post(path: string, body: unknown) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new ApiError(result.error, response.status);
    return result;
  }
  async function place(meal: Meal, date: string, slot: Slot) {
    const requestId = crypto.randomUUID();
    const card: Card = {
      id: `local:${requestId}`,
      requestId,
      name: meal.name,
      date,
      time: slot.time,
      projectId: board!.projectId,
      state: "pending",
      error: "",
      confirmedAt: 0,
    };
    intents.current.set(requestId, {
      requestId,
      mealId: meal.id,
      slotId: slot.id,
      date,
    });
    local.current.set(requestId, card);
    persistIntents();
    setBoard(
      (previous) =>
        previous && { ...previous, cards: [...previous.cards, card] },
    );
    await sendIntent(requestId);
  }
  async function sendIntent(requestId: string) {
    const intent = intents.current.get(requestId);
    const card = local.current.get(requestId);
    if (!intent || !card) return;
    try {
      await post(intent.kind ? "/api/change" : "/api/plan", intent);
      local.current.delete(requestId);
      intents.current.delete(requestId);
      persistIntents();
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        local.current.delete(requestId);
        intents.current.delete(requestId);
        persistIntents();
        setBoard(
          (previous) =>
            previous && {
              ...previous,
              cards: previous.cards.filter((c) => c.requestId !== requestId),
            },
        );
        setError(e.message);
        await refresh();
        return;
      }
      // A lost HTTP acknowledgement is uncertain: retain ID and retry the exact intent.
      card.error = `${(e as Error).message}. Click to retry.`;
      local.current.set(requestId, card);
      persistIntents();
      setError(card.error);
      setBoard(
        (previous) =>
          previous && {
            ...previous,
            cards: previous.cards.map((c) =>
              c.requestId === requestId ? { ...card } : c,
            ),
          },
      );
    }
  }
  async function change(
    card: Card,
    kind: "move" | "delete",
    date = card.date,
    slot?: Slot,
  ) {
    if (card.completed) return;
    const requestId = crypto.randomUUID();
    const pending: Card = {
      ...card,
      requestId,
      state: "pending",
      error: "",
      confirmedAt: 0,
      date,
      time: slot?.time ?? card.time,
      slotId: slot?.id ?? card.slotId,
      deleting: kind === "delete",
    };
    intents.current.set(requestId, {
      requestId,
      taskId: card.id,
      kind,
      date,
      slotId: slot?.id ?? "",
    });
    local.current.set(requestId, pending);
    persistIntents();
    setBoard(
      (previous) =>
        previous && {
          ...previous,
          cards: previous.cards.map((item) =>
            item.id === card.id ? pending : item,
          ),
        },
    );
    await sendIntent(requestId);
  }
  changeRef.current = change;
  function startPlannedTouchDrag(card: Card, source: HTMLDivElement, event: React.TouchEvent<HTMLDivElement>) {
    if (event.touches.length !== 1 || card.state !== "saved" || card.completed) return;
    const touch = event.touches[0]!;
    const drag = {
      card,
      source,
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      x: touch.clientX,
      y: touch.clientY,
      timer: 0 as unknown as ReturnType<typeof setTimeout>,
      active: false,
      scrolling: false,
    };
    drag.timer = setTimeout(() => {
      if (touchDrag.current !== drag) return;
      drag.active = true;
      dialogTrigger.current = source;
      source.classList.add("is-touch-dragging");
      document.body.classList.add("planner-dragging");
    }, 450);
    touchDrag.current = drag;
  }
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${week}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index);
    return {
      iso: iso(date),
      name: date.toLocaleDateString("en", {
        weekday: "short",
        timeZone: "UTC",
      }),
      label: date.toLocaleDateString("en", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }),
    };
  });
  function navigate(offset: number) {
    const date = new Date(`${week}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    setWeek(iso(date));
  }
  function openPlan(meal: Meal, trigger: HTMLButtonElement) {
    dialogTrigger.current = trigger;
    setMoving(null);
    setTarget(meal);
    const placement = defaultPlanPlacement(week, board!.slots, board!.cards, new Date());
    setDay(placement?.date ?? "");
    setSlotId(placement?.slotId ?? "");
    setPlanDefaultAvailable(placement !== null);
    dialog.current?.showModal();
  }
  function openCardActions(card: Card, trigger: HTMLDivElement) {
    dialogTrigger.current = trigger;
    setTarget(card);
    setMoving(card);
    setDay(card.date);
    setSlotId(card.slotId ?? board!.slots[0].id);
    setPlanDefaultAvailable(true);
    dialog.current?.showModal();
  }
  function requestDelete(card: Card) {
    setDeleteTarget(card);
    dialog.current?.close();
    deleteDialog.current?.showModal();
  }
  if (signedOut)
    return (
      <main className="login-card" style={{ margin: "12vh auto" }}>
        <div className="login-mark">✦</div>
        <h1>Meal Planner</h1>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <form
          className="login-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await post("/api/login", { password });
              setPassword("");
              setError("");
              await refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="primary-button" disabled={busy}>
            Sign in
          </button>
        </form>
      </main>
    );
  if (!board)
    return (
      <main
        className="login-card"
        style={{ margin: "12vh auto" }}
        role="status"
      >
        {error || "Loading planner…"}
      </main>
    );
  return (
    <>
      <header className={`topbar${settingsPage ? " settings-topbar" : ""}`}>
        {!settingsPage && <a className="brand" href="/">
          <span className="brand-mark">✦</span>
          <span>Meal Planner</span>
        </a>}
        {settingsPage ? (
          <a className="this-week" href="/">← Back to plan</a>
        ) : (
          <nav className="week-nav" aria-label="Week navigation">
            <button
              className="icon-button"
              aria-label="Previous week"
              onClick={() => navigate(-7)}
            >
              ‹
            </button>
            <WeekPicker week={week} today={today()} label={`${days[0].label} – ${days[6].label}`} isCurrent={isCurrentWeek} onSelect={setWeek} />
            <button
              className="icon-button"
              aria-label="Next week"
              onClick={() => navigate(7)}
            >
              ›
            </button>
          </nav>
        )}
        {!settingsPage && <div className="top-actions">
          {!isCurrentWeek && (
            <button className="this-week" onClick={() => setWeek(monday())}>
              This week
            </button>
          )}
          <button
            className="icon-button theme-toggle"
            aria-label={`Switch to ${effectiveTheme === "dark" ? "light" : "dark"} theme`}
            onClick={() => {
              const value = effectiveTheme === "dark" ? "light" : "dark";
              void post("/api/settings/theme", { theme: value })
                .then(refresh)
                .catch((e) => setError(e.message));
            }}
          >
            <Icon name={effectiveTheme === "dark" ? "moon" : "sun"} />
          </button>
          <a
            className="icon-button settings-link"
            href="/settings"
            aria-label="Settings"
          >
            <Icon name="settings" />
          </a>
        </div>}
      </header>
      {settingsPage ? (
        <SettingsPage board={board} post={post} refresh={refresh} onLogout={async () => {
          await post("/api/logout", {});
          local.current.clear();
          intents.current.clear();
          persistIntents();
          setBoard(null);
          setSignedOut(true);
        }} />
      ) : (
        <main className="app-layout">
          <section className="planner-panel" aria-label="Weekly meal planner">
            {error && (
              <p className="error-banner" role="alert">
                {error}
                <button className="text-button" onClick={() => setError("")}>
                  Dismiss
                </button>
              </p>
            )}
            {board.integrationError && (
              <p className="error-banner" role="alert">
                {board.integrationError}. Showing last available snapshot;
                pending actions remain queued.
              </p>
            )}
            {board.cards.some((card) => card.dueError || !card.date) && (
              <div className="error-banner" role="status">
                Meals needing a due date or time:{" "}
                {board.cards
                  .filter((card) => card.dueError || !card.date)
                  .map(
                    (card) =>
                      `${card.name} (${card.dueError || "No due date"})`,
                  )
                  .join(", ")}
              </div>
            )}
            {board.cards.some(
              (card) =>
                card.date >= days[0].iso &&
                card.date <= days[6].iso &&
                !card.slotId,
            ) && (
              <p className="warning-banner" role="status">
                Some meals have times that do not match a preset. They appear in
                Other meals.
              </p>
            )}
            <div className="grid-scroll">
              <table className="meal-grid" data-slot-count={board.slots.length}>
                <caption className="visually-hidden">Weekly meal plan</caption>
                <thead>
                  <tr>
                    <th className="grid-corner" scope="col">
                      <span className="visually-hidden">Meal slot</span>
                    </th>
                    {days.map((d) => (
                      <th
                        className={`day-header${d.iso === today() ? " is-today" : ""}`}
                        scope="col"
                        key={d.iso}
                      >
                        <div className="day-header-content">
                          <span className="day-date">{d.label}</span>
                          <span className="day-name">{d.name}</span>
                          <span className="day-count">
                            {board.cards.filter((c) => c.date === d.iso).length}
                          </span>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    ...board.slots,
                    ...(board.cards.some((card) => !card.slotId)
                      ? [{ id: "unassigned", name: "Other meals", time: "" }]
                      : []),
                  ].map((slot) => (
                    <tr key={slot.id}>
                      <th scope="row" className="slot-label">
                        <div className="slot-label-content">
                          <span>{slot.name}</span>
                          <time>{slot.time}</time>
                        </div>
                      </th>
                      {days.map((d) => (
                        <td
                          className="meal-cell"
                          data-date={d.iso}
                          data-slot-id={slot.id}
                          key={d.iso}
                          onDragOver={(e) => {
                            if (
                              e.dataTransfer.types.includes(
                                "application/x-meal-library",
                              ) ||
                              e.dataTransfer.types.includes(
                                "application/x-planned-meal",
                              )
                            )
                              e.preventDefault();
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            const meal = board.library.find(
                              (m) =>
                                m.id ===
                                e.dataTransfer.getData(
                                  "application/x-meal-library",
                                ),
                            );
                            if (slot.id === "unassigned") return;
                            if (meal) void place(meal, d.iso, slot);
                            const card = board.cards.find(
                              (card) =>
                                card.id ===
                                e.dataTransfer.getData(
                                  "application/x-planned-meal",
                                ),
                            );
                            if (
                              card &&
                              card.state === "saved" &&
                              !card.completed
                            )
                              void change(card, "move", d.iso, slot);
                          }}
                        >
                          <div className="meal-cell-content">
                            {board.cards
                              .filter(
                                (c) =>
                                  c.date === d.iso &&
                                  (c.slotId === slot.id ||
                                    (!c.slotId && slot.id === "unassigned")),
                              )
                              .map((card) => (
                                <div
                                  role={
                                    card.state === "saved" && !card.completed
                                      ? "button"
                                      : undefined
                                  }
                                  tabIndex={
                                    card.state === "saved" && !card.completed
                                      ? 0
                                      : undefined
                                  }
                                  aria-label={
                                    card.state === "saved" && !card.completed
                                      ? `Move or delete ${card.name}`
                                      : undefined
                                  }
                                  aria-description={
                                    card.state === "saved" && !card.completed
                                      ? "Tap to choose an action, or hold for a moment and drag to move or delete."
                                      : undefined
                                  }
                                  aria-haspopup={
                                    card.state === "saved" && !card.completed
                                      ? "dialog"
                                      : undefined
                                  }
                                  data-card-id={card.id}
                                  draggable={
                                    card.state === "saved" &&
                                    !card.completed &&
                                    !coarsePointer
                                  }
                                  onTouchStart={(e) => startPlannedTouchDrag(card, e.currentTarget, e)}
                                  onClick={(e) => {
                                    if (
                                      dragFinishedCardId.current === card.id &&
                                      Date.now() - dragFinishedAt.current < 400
                                    ) {
                                      dragFinishedCardId.current = null;
                                      return;
                                    }
                                    if (card.state === "saved" && !card.completed)
                                      openCardActions(card, e.currentTarget);
                                  }}
                                  onKeyDown={(e) => {
                                    if (
                                      (e.key === "Enter" || e.key === " ") &&
                                      card.state === "saved" &&
                                      !card.completed
                                    ) {
                                      e.preventDefault();
                                      openCardActions(card, e.currentTarget);
                                    }
                                  }}
                                  onDragStart={(e) => {
                                    touchDrag.current = null;
                                    dragFinishedCardId.current = null;
                                    dialogTrigger.current = e.currentTarget;
                                    e.dataTransfer.setData(
                                      "application/x-planned-meal",
                                      card.id,
                                    );
                                    document.body.classList.add(
                                      "planner-dragging",
                                    );
                                  }}
                                  onDragEnd={() => {
                                    dragFinishedAt.current = Date.now();
                                    dragFinishedCardId.current = card.id;
                                    document.body.classList.remove(
                                      "planner-dragging",
                                      "trash-hover",
                                    );
                                  }}
                                  key={card.requestId || card.id}
                                  className={`meal-chip${card.completed ? " is-complete" : ""}${card.state === "pending" ? " is-sync-pending" : ""}${card.deleting ? " is-delete-pending" : ""}`}
                                >
                                  <span className="meal-chip-name">
                                    {card.name}
                                    {card.completed ? " ✓" : ""}
                                  </span>
                                  {card.state === "pending" ? (
                                    <button
                                      type="button"
                                      className={`meal-sync-indicator${card.error ? " sync-indicator-failed" : ""}`}
                                      disabled={!card.error}
                                      aria-label={
                                        card.error
                                          ? `Retry meal: ${card.error}`
                                          : "Saving meal"
                                      }
                                      title={card.error || "Saving meal"}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (intents.current.has(card.requestId))
                                          void sendIntent(card.requestId);
                                        else
                                          void post("/api/retry", {
                                            requestId: card.requestId,
                                          })
                                            .then(refresh)
                                            .catch((e) => setError(e.message));
                                      }}
                                    >
                                      <Icon
                                        name={card.error ? "alert" : "loader"}
                                        spin={!card.error}
                                      />
                                    </button>
                                  ) : (
                                    now - card.confirmedAt < 2000 && (
                                      <span
                                        className="meal-sync-indicator"
                                        role="status"
                                        aria-label="Meal saved"
                                      >
                                        <Icon name="check" />
                                      </span>
                                    )
                                  )}
                                </div>
                              ))}
                          </div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <aside className="library-panel" aria-label="Meal library">
            <div className="library-actions">
              <button
                className="shuffle-button"
                type="button"
                aria-label="Shuffle meal library"
                title="Shuffle meal library"
                onClick={() =>
                  void post("/api/library/shuffle", {})
                    .then(refresh)
                    .catch((e) => setError(e.message))
                }
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m18 3 3 3-3 3M18 15l3 3-3 3M3 6h3c5 0 7 12 12 12h3M3 18h3c2 0 4-2 6-6s4-6 6-6h3" />
                </svg>
              </button>
            </div>
            <form
              className="library-add-row"
              onSubmit={(e) => { e.preventDefault(); void addLibraryMeal(); }}
            >
              <input
                ref={libraryInput}
                type="search"
                aria-invalid={libraryInvalid}
                disabled={libraryAdding}
                placeholder="Search or type meal name…"
                aria-label="Search or type a meal name"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setLibraryInvalid(false);
                  animateLibraryInvalid(true);
                  setLibraryFeedback("");
                  setLibraryError("");
                }}
              />
              <button
                className="add-meal-button"
                type="submit"
                disabled={libraryAdding}
              >
                {libraryAdding ? "Adding…" : "Add meal"}
              </button>
            </form>
            <div className="library-feedback" role={libraryError ? "alert" : "status"}>
              {libraryError || libraryFeedback}
            </div>
            <div
              className="trash-drop-target"
              aria-label="Delete dragged planned meal"
              onDragOver={(e) => {
                if (
                  e.dataTransfer.types.includes("application/x-planned-meal")
                ) {
                  e.preventDefault();
                  document.body.classList.add("trash-hover");
                }
              }}
              onDragLeave={() => document.body.classList.remove("trash-hover")}
              onDrop={(e) => {
                e.preventDefault();
                document.body.classList.remove(
                  "planner-dragging",
                  "trash-hover",
                );
                const card = board.cards.find(
                  (card) =>
                    card.id ===
                    e.dataTransfer.getData("application/x-planned-meal"),
                );
                if (card && !card.completed && card.state === "saved") {
                  setDeleteTarget(card);
                  deleteDialog.current?.showModal();
                }
              }}
            >
              <Icon name="trash-2" />
            </div>
            <div className="library-list">
              {board.library
                .filter((meal) =>
                  meal.name.toLowerCase().includes(search.trim().toLowerCase()),
                )
                .map((meal) => (
                  <button
                    className="library-chip"
                    type="button"
                    aria-label={`Plan ${meal.name}`}
                    title={`Click to plan ${meal.name}, or drag to a calendar slot`}
                    key={meal.id}
                    draggable
                    onPointerDown={() => { libraryDragged.current = false; }}
                    onKeyDown={() => { libraryDragged.current = false; }}
                    onDragStart={(e) => {
                      libraryDragged.current = true;
                      e.currentTarget.classList.add("is-dragging");
                      e.dataTransfer.effectAllowed = "copy";
                      e.dataTransfer.setData("application/x-meal-library", meal.id);
                    }}
                    onDragEnd={(e) => { e.currentTarget.classList.remove("is-dragging"); }}
                    onClick={(e) => {
                      if (libraryDragged.current) return;
                      openPlan(meal, e.currentTarget);
                    }}
                  >
                    <span className="drag-grip" aria-hidden="true">⠿</span>
                    <span className="library-chip-name">{meal.name}</span>
                  </button>
                ))}
            </div>
          </aside>
        </main>
      )}
      <dialog
        ref={deleteDialog}
        className="confirm-dialog"
        aria-label="Confirm meal deletion"
        onKeyDown={containDialogTab}
        onClose={() => dialogTrigger.current?.focus()}
      >
        <h2>Delete {deleteTarget?.name}?</h2>
        <p>This removes the planned meal from Todoist.</p>
        <button
          className="secondary-button"
          onClick={() => {
            deleteDialog.current?.close();
            setDeleteTarget(null);
          }}
        >
          Cancel
        </button>
        <button
          className="primary-button"
          onClick={() => {
            deleteDialog.current?.close();
            if (deleteTarget) void change(deleteTarget, "delete");
            setDeleteTarget(null);
          }}
        >
          Delete meal
        </button>
      </dialog>
      <dialog
        ref={dialog}
        className="confirm-dialog action-dialog"
        aria-labelledby="plan-title"
        onKeyDown={containDialogTab}
        onClose={() => dialogTrigger.current?.focus()}
      >
        <form
          className="planner-action-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (target) {
              dialog.current?.close();
              const slot = board.slots.find((s) => s.id === slotId)!;
              if (moving) await change(moving, "move", day, slot);
              else await place(target, day, slot);
            }
          }}
        >
          <h2 id="plan-title" tabIndex={-1}>
            {moving ? "Move" : "Plan"} {target?.name}
          </h2>
          <p>
            {moving
              ? "Choose a day and meal slot. You can also drag meals on the planner."
              : planDefaultAvailable
                ? "Choose a day and meal slot. You can also drag meals on the planner."
                : "No eligible empty slot is available in this displayed week. Choose a day and slot manually, or view another week."}
          </p>
          <label htmlFor="plan-day">Day</label>
          <select
            id="plan-day"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          >
            {!moving && <option value="">Choose a day</option>}
            {days.map((d) => (
              <option key={d.iso} value={d.iso}>
                {d.name}, {d.label}
              </option>
            ))}
          </select>
          <label htmlFor="plan-slot">Meal slot</label>
          <select
            id="plan-slot"
            value={slotId}
            onChange={(e) => setSlotId(e.target.value)}
          >
            {!moving && <option value="">Choose a meal slot</option>}
            {board.slots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="dialog-actions">
            {moving && (
              <button
                className="danger-button"
                type="button"
                onClick={() => requestDelete(moving)}
              >
                Delete meal
              </button>
            )}
            <button
              className="secondary-button"
              type="button"
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </button>
            <button className="primary-button" disabled={!moving && (!day || !slotId)}>
              {moving ? "Move meal" : "Plan meal"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
