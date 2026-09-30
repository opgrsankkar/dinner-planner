import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Board, Meal, Card, Slot } from "../types";
export const Route = createFileRoute("/")({ component: Planner });
type Intent = {
  requestId: string;
  mealId: string;
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
function monday() {
  const day = new Date();
  day.setUTCHours(12, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return iso(day);
}
function Icon({ name, spin = false }: { name: string; spin?: boolean }) {
  return (
    <svg className={`ui-icon${spin ? " sync-spinner" : ""}`} aria-hidden="true">
      <use href={`/static/lucide-icons.svg#${name}`} />
    </svg>
  );
}
function Planner() {
  const [board, setBoard] = useState<Board | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [search, setSearch] = useState("");
  const [week, setWeek] = useState(monday);
  const [target, setTarget] = useState<Meal | null>(null);
  const [day, setDay] = useState(week);
  const [slotId, setSlotId] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [theme, setTheme] = useState("system");
  const dialog = useRef<HTMLDialogElement>(null);
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
    const response = await fetch("/api/board");
    if (response.status === 401) {
      setSignedOut(true);
      setBoard(null);
      return;
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const next = result as Board;
    for (const card of next.cards) {
      local.current.delete(card.requestId);
      intents.current.delete(card.requestId);
    }
    persistIntents();
    next.cards.push(...local.current.values());
    setBoard(next);
    setSignedOut(false);
    setNow(Date.now());
  }, []);
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
    const value = localStorage.getItem("meal-planner-theme") ?? "system";
    setTheme(value);
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
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
      projectId: "fake-meals-project",
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
      await post("/api/plan", intent);
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
  function openPlan(meal: Meal) {
    setTarget(meal);
    setDay(week);
    setSlotId(board!.slots[0].id);
    dialog.current?.showModal();
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
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">✦</span>
          <span>Meal Planner</span>
        </a>
        <nav className="week-nav" aria-label="Week navigation">
          <button
            className="icon-button"
            aria-label="Previous week"
            onClick={() => navigate(-7)}
          >
            ‹
          </button>
          <span className="week-title">
            {days[0].label} – {days[6].label}
          </span>
          <button
            className="icon-button"
            aria-label="Next week"
            onClick={() => navigate(7)}
          >
            ›
          </button>
        </nav>
        <div className="top-actions">
          <button className="this-week" onClick={() => setWeek(monday())}>
            This week
          </button>
          <button
            className="icon-button theme-toggle"
            aria-label={`Theme: ${theme}. Change theme`}
            onClick={() => {
              const value =
                theme === "system"
                  ? "light"
                  : theme === "light"
                    ? "dark"
                    : "system";
              setTheme(value);
              localStorage.setItem("meal-planner-theme", value);
            }}
          >
            <Icon
              name={
                theme === "dark"
                  ? "moon"
                  : theme === "light"
                    ? "sun"
                    : "monitor"
              }
            />
          </button>
          <button
            className="text-button"
            onClick={async () => {
              try {
                await post("/api/logout", {});
                local.current.clear();
                intents.current.clear();
                persistIntents();
                setBoard(null);
                setSignedOut(true);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Log out
          </button>
        </div>
      </header>
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
                      className={`day-header${d.iso === iso(new Date()) ? " is-today" : ""}`}
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
                {board.slots.map((slot) => (
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
                        key={d.iso}
                        onDragOver={(e) => {
                          if (
                            e.dataTransfer.types.includes(
                              "application/x-meal-library",
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
                          if (meal) void place(meal, d.iso, slot);
                        }}
                      >
                        <div className="meal-cell-content">
                          {board.cards
                            .filter(
                              (c) => c.date === d.iso && c.time === slot.time,
                            )
                            .map((card) => (
                              <div
                                key={card.requestId || card.id}
                                className={`meal-chip${card.state === "pending" ? " is-sync-pending" : ""}`}
                              >
                                <span className="meal-chip-name">
                                  {card.name}
                                </span>
                                {card.state === "pending" ? (
                                  <button
                                    type="button"
                                    className={`meal-sync-indicator${card.error ? " sync-indicator-failed" : ""}`}
                                    disabled={
                                      !intents.current.has(card.requestId)
                                    }
                                    aria-label={
                                      card.error
                                        ? `${card.error}${intents.current.has(card.requestId) ? " Retry placement" : " Will retry automatically"}`
                                        : "Saving meal"
                                    }
                                    title={card.error || "Saving meal"}
                                    onClick={() => {
                                      void sendIntent(card.requestId);
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
          <div className="library-heading">
            <h1>Meal library</h1>
          </div>
          <form
            className="library-add-row"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await post("/api/library", { name: search });
                setSearch("");
                await refresh();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <input
              type="search"
              placeholder="Search or type meal name…"
              aria-label="Search or type a meal name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              className="add-meal-button"
              disabled={busy || !search.trim()}
            >
              Add meal
            </button>
          </form>
          <div className="library-list" role="list">
            {board.library
              .filter((meal) =>
                meal.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((meal) => (
                <div
                  className="library-chip"
                  role="listitem"
                  key={meal.id}
                  draggable
                  onDragStart={(e) =>
                    e.dataTransfer.setData(
                      "application/x-meal-library",
                      meal.id,
                    )
                  }
                >
                  <span className="drag-grip" aria-hidden="true">
                    ⠿
                  </span>
                  <span className="library-chip-name">{meal.name}</span>
                  <button
                    className="library-plan-trigger"
                    aria-label={`Plan ${meal.name}`}
                    onClick={() => openPlan(meal)}
                  >
                    Plan
                  </button>
                </div>
              ))}
          </div>
        </aside>
      </main>
      <dialog
        ref={dialog}
        className="confirm-dialog action-dialog"
        aria-labelledby="plan-title"
      >
        <form
          className="planner-action-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (target) {
              dialog.current?.close();
              await place(
                target,
                day,
                board.slots.find((s) => s.id === slotId)!,
              );
            }
          }}
        >
          <h2 id="plan-title">Plan {target?.name}</h2>
          <p>
            Choose a day and meal slot. You can also drag meals on the planner.
          </p>
          <label htmlFor="plan-day">Day</label>
          <select
            id="plan-day"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          >
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
            {board.slots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="dialog-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </button>
            <button className="primary-button">Plan meal</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
