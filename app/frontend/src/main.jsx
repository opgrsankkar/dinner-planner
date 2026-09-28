import React, { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, Reorder, motion, useDragControls, useReducedMotion } from "motion/react";

const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const uuid = () => window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const jsonHeaders = (csrf) => ({ "X-CSRF-Token": csrf, "Content-Type": "application/json" });

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  let payload = {};
  try { payload = await response.json(); } catch (_) { /* non-JSON response */ }
  if (!response.ok) throw new Error(payload.detail || payload.error || `Request failed (${response.status})`);
  return payload;
}

function Icon({ name, className = "ui-icon" }) {
  return <svg className={className} aria-hidden="true"><use href={`/static/lucide-icons.svg#${name}`} /></svg>;
}

function ToastRegion({ items }) {
  return <div className="toast-region" id="toast-region" aria-live="polite">
    {items.map((item) => <div key={item.id} className={`toast toast-${item.kind}${item.leaving ? " toast-leave" : ""}`} role={item.kind === "error" ? "alert" : "status"} aria-atomic="true">{item.message}</div>)}
  </div>;
}

function useTheme(initialMode, csrf, notify) {
  const [mode, setMode] = useState(initialMode || "system");
  const [busy, setBusy] = useState(false);
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const effective = mode === "system" ? (prefersDark ? "dark" : "light") : mode;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (event) => setPrefersDark(event.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    const html = document.documentElement;
    html.dataset.themeMode = mode;
    if (mode === "system") delete html.dataset.theme;
    else html.dataset.theme = mode;
    document.body.dataset.themeMode = mode;
    const lightMeta = document.getElementById("theme-color-light");
    const darkMeta = document.getElementById("theme-color-dark");
    if (lightMeta) lightMeta.media = effective === "light" ? "all" : "not all";
    if (darkMeta) darkMeta.media = effective === "dark" ? "all" : "not all";
  }, [mode, effective]);

  const save = useCallback(async (nextMode) => {
    if (busy) return;
    const previous = mode;
    setBusy(true);
    setMode(nextMode);
    try {
      const result = await api("/api/settings/theme", {
        method: "POST", headers: jsonHeaders(csrf), body: JSON.stringify({ mode: nextMode }),
      });
      setMode(result.theme_mode);
      return true;
    } catch (error) {
      setMode(previous);
      notify(error.message, "error");
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, csrf, mode, notify]);

  return { mode, effective, busy, save };
}

function ThemeToggle({ theme }) {
  const next = theme.effective === "dark" ? "light" : "dark";
  const icon = theme.effective === "dark" ? "sun" : "moon";
  return <button className={`icon-button theme-toggle${theme.busy ? " theme-pop" : ""}`} type="button"
    aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`} disabled={theme.busy}
    onClick={() => theme.save(next)}><Icon name={icon} /></button>;
}

function Header({ csrf, theme, week }) {
  return <header className="topbar">
    <a className="brand" href="/" aria-label="Meal Planner home"><span className="brand-mark">✦</span><span>Meal Planner</span></a>
    {week && <nav className="week-nav" aria-label="Week navigation">
      <a className="icon-button" href={`/?week=${week.prev}`} aria-label="Previous week">‹</a>
      <span className="week-title">{week.title}</span>
      <a className="icon-button" href={`/?week=${week.next}`} aria-label="Next week">›</a>
    </nav>}
    <div className="top-actions">
      {week && <a className="this-week" href={`/?week=${week.today}`}>This week</a>}
      {theme && <ThemeToggle theme={theme} />}
      {week && <a className="icon-button settings-link" href="/settings" aria-label="Settings"><Icon name="settings" /></a>}
      {week && <form action="/logout" method="post" className="logout-form"><input type="hidden" name="csrf" value={csrf} /><button className="text-button" type="submit">Log out</button></form>}
      {!week && <a className="this-week" href="/">Back to plan</a>}
    </div>
  </header>;
}

function updateTask(grid, taskKey, updater) {
  let found = false;
  const next = {};
  for (const [slotId, cells] of Object.entries(grid)) {
    next[slotId] = {};
    for (const [day, tasks] of Object.entries(cells)) {
      next[slotId][day] = tasks.flatMap((task) => {
        if ((task.cache_key || `remote:${task.id}`) !== taskKey) return [task];
        found = true;
        const result = updater(task);
        return result ? [result] : [];
      });
    }
  }
  return { grid: next, found };
}

function appendTask(grid, slotId, day, task) {
  const next = { ...grid, [slotId]: { ...(grid[slotId] || {}) } };
  next[slotId][day] = [...(next[slotId][day] || []), task];
  return next;
}

function TaskChip({ task, csrf, onRetry, onDragStart, onDragEnd, onOpenActions, slotId, dayIso }) {
  const completed = Boolean(task.completed);
  const pending = task._sync_state === "pending" || Boolean(task.operation_id && !task._sync_state);
  const failed = task._sync_state === "failed";
  const removable = Boolean(task.delete_pending);
  const draggable = !completed && !pending && !failed;
  const indicator = task._sync_state || (task.operation_id ? "pending" : "");
  return <div className={`meal-chip${completed ? " is-complete" : ""}${removable ? " is-delete-pending sync-remove-after-save" : ""}${pending ? " is-sync-pending" : ""}${task._leaving ? " meal-chip-leave" : ""}`}
    draggable={draggable} tabIndex={-1} data-task-id={task.id} data-task-key={task.cache_key || `remote:${task.id}`}
    data-task-date={task.date} data-meal-name={task.name} data-operation-id={task.operation_id || undefined}
    data-count-removed={task.count_removed ? "true" : "false"} title={`${task.name}${completed ? " · complete" : ""}`}
    onDragStart={(event) => onDragStart(event, task)} onDragEnd={onDragEnd}>
    <span className="meal-chip-name">{task.name}</span>
    {draggable && <button type="button" className="meal-action-trigger" aria-haspopup="dialog" aria-label={`Move or remove ${task.name}`} title={`Move or remove ${task.name}`}
      onPointerDown={(event) => event.stopPropagation()} onClick={(event) => onOpenActions(task, slotId, dayIso, event.currentTarget)}><span aria-hidden="true">•••</span></button>}
    {completed && <span className="complete-mark" aria-label="Completed">✓</span>}
    {indicator && <button type="button" className={`meal-sync-indicator${failed ? " sync-indicator-failed" : ""}`} disabled={!failed}
      aria-label={failed ? "Save failed — click to retry" : indicator === "done" ? "Saved to Todoist" : "Saving to Todoist"}
      title={failed ? `Save failed — click to retry${task._error ? ` · ${task._error}` : ""}` : indicator === "done" ? "Saved to Todoist" : "Saving to Todoist"}
      onClick={failed ? () => onRetry(task) : undefined}>
      <Icon name={indicator === "done" ? "check" : failed ? "alert" : "loader"} className={`ui-icon${pending ? " sync-spinner" : ""}`} />
    </button>}
  </div>;
}

function PlannerBoard({ data, csrf, theme, notify }) {
  const [grid, setGrid] = useState(data.grid || {});
  const [days, setDays] = useState(data.days || []);
  const [library, setLibrary] = useState(data.library || []);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [hoverCell, setHoverCell] = useState("");
  const [pendingDelete, setPendingDelete] = useState(null);
  const [dialogTick, setDialogTick] = useState(0);
  const [actionTarget, setActionTarget] = useState(null);
  const [actionDate, setActionDate] = useState(data.days?.find((day) => day.is_today)?.iso || data.days?.[0]?.iso || "");
  const [actionSlot, setActionSlot] = useState(data.slots?.[0]?.id || "");
  const [actionBusy, setActionBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [focusMovedTaskKey, setFocusMovedTaskKey] = useState("");
  const searchRef = useRef(null);
  const dialogRef = useRef(null);
  const actionDialogRef = useRef(null);
  const actionOriginRef = useRef(null);
  const dragRef = useRef(null);
  const watching = useRef(new Set());
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const adjustDayCount = useCallback((day, delta) => {
    setDays((current) => current.map((item) => item.iso === day ? { ...item, count: Math.max(0, item.count + delta) } : item));
  }, []);

  const pollOperation = useCallback(async (operationId, taskKey) => {
    if (!operationId || watching.current.has(operationId)) return;
    watching.current.add(operationId);
    try {
      while (true) {
        let status;
        try { status = await api(`/api/operations/${encodeURIComponent(operationId)}`); }
        catch (_) { await wait(800); continue; }
        if (status.state === "done") {
          const current = gridRef.current;
          const match = Object.values(current).flatMap((cells) => Object.values(cells).flat()).find((task) => (task.cache_key || `remote:${task.id}`) === taskKey);
          if (!match) return;
          if (status.kind === "delete-meal" || match.delete_pending) {
            setGrid((previous) => updateTask(previous, taskKey, (task) => ({ ...task, operation_id: "", _sync_state: "done" })).grid);
            await wait(650);
            setGrid((previous) => updateTask(previous, taskKey, () => null).grid);
          } else {
            setGrid((previous) => updateTask(previous, taskKey, (task) => ({
              ...task, id: String(status.remote_id || task.id), cache_key: status.task_key || task.cache_key,
              operation_id: "", _sync_state: "done", _error: "",
            })).grid);
            await wait(800);
            setGrid((previous) => updateTask(previous, taskKey, (task) => ({ ...task, _sync_state: "" })).grid);
          }
          return;
        }
        if (status.state === "failed") {
          const current = Object.values(gridRef.current).flatMap((cells) => Object.values(cells).flat()).find((task) => (task.cache_key || `remote:${task.id}`) === taskKey);
          if (current?.delete_pending && current.count_removed) {
            adjustDayCount(current.date, 1);
            setGrid((previous) => updateTask(previous, taskKey, (task) => ({ ...task, count_removed: false })).grid);
          }
          setGrid((previous) => updateTask(previous, taskKey, (task) => ({ ...task, operation_id: "", _last_operation_id: operationId, _sync_state: "failed", _error: status.error || "" })).grid);
          notify("Couldn't save this meal to Todoist. Use its small warning icon to retry.", "error");
          return;
        }
        await wait(360);
      }
    } finally {
      watching.current.delete(operationId);
    }
  }, [adjustDayCount, notify]);

  useEffect(() => {
    for (const cells of Object.values(gridRef.current)) {
      for (const tasks of Object.values(cells)) {
        for (const task of tasks) if (task.operation_id) pollOperation(task.operation_id, task.cache_key || `remote:${task.id}`);
      }
    }
  }, [pollOperation]);

  const retryOperation = async (task) => {
    const taskKey = task.cache_key || `remote:${task.id}`;
    try {
      await api(`/api/operations/${encodeURIComponent(task.operation_id || task._last_operation_id || "")}/retry`, {
        method: "POST", headers: jsonHeaders(csrf), body: "{}",
      });
      if (task.delete_pending && !task.count_removed) {
        adjustDayCount(task.date, -1);
        setGrid((previous) => updateTask(previous, taskKey, (item) => ({ ...item, count_removed: true })).grid);
      }
      const operationId = task.operation_id || task._last_operation_id;
      setGrid((previous) => updateTask(previous, taskKey, (item) => ({ ...item, operation_id: operationId, _sync_state: "pending", _error: "" })).grid);
      pollOperation(operationId, taskKey);
    } catch (error) { notify(error.message, "error"); }
  };

  const onLibraryDragStart = (event, meal) => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-meal-library", JSON.stringify({ meal_id: meal.id }));
    dragRef.current = { type: "library", meal };
    document.body.classList.add("library-dragging");
  };
  const onTaskDragStart = (event, task) => {
    if (task._sync_state === "pending" || task._sync_state === "failed" || task.operation_id) { event.preventDefault(); return; }
    const taskKey = task.cache_key || `remote:${task.id}`;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-planned-meal", JSON.stringify({ task_key: taskKey, date: task.date }));
    dragRef.current = { type: "planned", task, taskKey, cell: event.currentTarget.closest(".meal-cell") };
    document.body.classList.add("planner-dragging");
    document.getElementById("trash-target")?.setAttribute("aria-hidden", "false");
  };
  const clearDrag = () => {
    dragRef.current = null;
    document.body.classList.remove("library-dragging", "planner-dragging", "trash-hover");
    document.getElementById("trash-target")?.setAttribute("aria-hidden", "true");
    setHoverCell("");
  };

  const dropIntoCell = async (event, slot, day) => {
    event.preventDefault();
    const cellKey = `${slot.id}:${day.iso}`;
    setHoverCell("");
    const libraryPayload = event.dataTransfer.getData("application/x-meal-library");
    const plannedPayload = event.dataTransfer.getData("application/x-planned-meal");
    try {
      if (libraryPayload) {
        const item = JSON.parse(libraryPayload);
        const result = await api("/api/plan", {
          method: "POST", headers: jsonHeaders(csrf),
          body: JSON.stringify({ meal_id: item.meal_id, date: day.iso, slot_id: slot.id, request_id: uuid() }),
        });
        const task = {
          id: result.task_id, cache_key: result.task_key, operation_id: result.operation_id,
          name: result.name, date: day.iso, time: slot.time, completed: false,
          _sync_state: "pending", count_removed: false,
        };
        setGrid((previous) => appendTask(previous, slot.id, day.iso, task));
        adjustDayCount(day.iso, 1);
        pollOperation(result.operation_id, result.task_key);
        announce(`Added ${result.name} to ${slot.name}, ${day.date_label}.`);
      } else if (plannedPayload) {
        const payload = JSON.parse(plannedPayload);
        const drag = dragRef.current;
        const taskKey = payload.task_key;
        const task = drag?.task || Object.values(gridRef.current).flatMap((cells) => Object.values(cells).flat()).find((entry) => (entry.cache_key || `remote:${entry.id}`) === taskKey);
        if (!task || (drag?.cell?.dataset.day === day.iso && drag?.cell?.dataset.slot === slot.id)) return;
        const result = await api(`/api/plan/${encodeURIComponent(taskKey)}/move`, {
          method: "POST", headers: jsonHeaders(csrf),
          body: JSON.stringify({ date: day.iso, slot_id: slot.id, request_id: uuid() }),
        });
        setGrid((previous) => {
          const removed = updateTask(previous, taskKey, () => null).grid;
          return appendTask(removed, slot.id, day.iso, {
            ...task, date: day.iso, time: slot.time, slot_id: slot.id,
            operation_id: result.operation_id, _sync_state: "pending", _error: "",
          });
        });
        if (task.date !== day.iso) { adjustDayCount(task.date, -1); adjustDayCount(day.iso, 1); }
        pollOperation(result.operation_id, taskKey);
        announce(`Moved ${task.name} to ${slot.name}, ${day.date_label}.`);
      }
    } catch (error) { notify(error.message, "error"); }
    finally { clearDrag(); }
  };

  const askDelete = (task) => {
    setPendingDelete(task);
    setDialogTick((value) => value + 1);
  };
  const openLibraryPlan = (meal, trigger) => {
    actionOriginRef.current = trigger;
    setActionTarget({ kind: "library", meal });
    setActionDate(days.find((day) => day.is_today)?.iso || days[0]?.iso || "");
    setActionSlot(data.slots[0]?.id || "");
  };
  const openTaskActions = (task, slotId, dayIso, trigger) => {
    actionOriginRef.current = trigger;
    setActionTarget({ kind: "task", task, slotId, dayIso });
    setActionDate(dayIso);
    setActionSlot(slotId);
  };
  const closeActionDialog = (focusTaskKey = "", restoreFocus = true) => {
    if (actionDialogRef.current?.open) actionDialogRef.current.close();
    setActionTarget(null);
    if (!restoreFocus) { actionOriginRef.current = null; return; }
    const origin = actionOriginRef.current;
    actionOriginRef.current = null;
    if (focusTaskKey) { setFocusMovedTaskKey(focusTaskKey); return; }
    window.setTimeout(() => {
      if (origin?.isConnected && !origin.disabled) origin.focus();
    }, 0);
  };
  const announce = (message) => {
    setAnnouncement("");
    window.requestAnimationFrame(() => setAnnouncement(message));
  };
  useEffect(() => {
    if (actionTarget && actionDialogRef.current && !actionDialogRef.current.open) actionDialogRef.current.showModal();
  }, [actionTarget]);
  useEffect(() => {
    if (!focusMovedTaskKey) return;
    const target = [...document.querySelectorAll(".meal-chip[data-task-key]")].find((item) => item.dataset.taskKey === focusMovedTaskKey);
    if (target) { target.focus(); setFocusMovedTaskKey(""); }
  }, [focusMovedTaskKey, grid]);
  useEffect(() => {
    if (!pendingDelete || !dialogRef.current) return;
    if (!dialogRef.current.open) dialogRef.current.showModal();
  }, [pendingDelete, dialogTick]);

  const submitAccessibleAction = async (event) => {
    event.preventDefault();
    if (!actionTarget || actionBusy) return;
    const day = days.find((item) => item.iso === actionDate);
    const slot = data.slots.find((item) => item.id === actionSlot);
    if (!day || !slot) return;
    if (actionTarget.kind === "task" && actionTarget.dayIso === day.iso && actionTarget.slotId === slot.id) {
      closeActionDialog();
      return;
    }
    setActionBusy(true);
    let focusTaskKey = "";
    try {
      if (actionTarget.kind === "library") {
        const result = await api("/api/plan", { method: "POST", headers: jsonHeaders(csrf), body: JSON.stringify({ meal_id: actionTarget.meal.id, date: day.iso, slot_id: slot.id, request_id: uuid() }) });
        setGrid((previous) => appendTask(previous, slot.id, day.iso, { id: result.task_id, cache_key: result.task_key, operation_id: result.operation_id, name: result.name, date: day.iso, time: slot.time, slot_id: slot.id, completed: false, _sync_state: "pending", count_removed: false }));
        adjustDayCount(day.iso, 1);
        pollOperation(result.operation_id, result.task_key);
        announce(`Added ${actionTarget.meal.name} to ${slot.name}, ${day.date_label}.`);
      } else {
        const task = actionTarget.task;
        const taskKey = task.cache_key || `remote:${task.id}`;
        focusTaskKey = taskKey;
        const result = await api(`/api/plan/${encodeURIComponent(taskKey)}/move`, { method: "POST", headers: jsonHeaders(csrf), body: JSON.stringify({ date: day.iso, slot_id: slot.id, request_id: uuid() }) });
        setGrid((previous) => {
          const removed = updateTask(previous, taskKey, () => null).grid;
          return appendTask(removed, slot.id, day.iso, { ...task, date: day.iso, time: slot.time, slot_id: slot.id, operation_id: result.operation_id, _sync_state: "pending", _error: "" });
        });
        if (actionTarget.dayIso !== day.iso) { adjustDayCount(actionTarget.dayIso, -1); adjustDayCount(day.iso, 1); }
        pollOperation(result.operation_id, taskKey);
        announce(`Moved ${task.name} to ${slot.name}, ${day.date_label}.`);
      }
      closeActionDialog(focusTaskKey);
    } catch (error) { notify(error.message, "error"); }
    finally { setActionBusy(false); }
  };
  const deleteActionTarget = () => {
    if (actionTarget?.kind !== "task") return;
    const task = actionTarget.task;
    closeActionDialog("", false);
    askDelete(task);
  };

  const confirmDelete = async () => {
    const task = pendingDelete;
    if (!task) return;
    const taskKey = task.cache_key || `remote:${task.id}`;
    try {
      const result = await api(`/api/plan/${encodeURIComponent(taskKey)}`, {
        method: "DELETE", headers: { "X-CSRF-Token": csrf, "X-Request-ID": uuid() },
      });
      adjustDayCount(task.date, -1);
      setGrid((previous) => updateTask(previous, taskKey, (item) => ({
        ...item, operation_id: result.operation_id, _sync_state: "pending", delete_pending: true, count_removed: true,
      })).grid);
      pollOperation(result.operation_id, taskKey);
      announce(`Removed ${task.name} from your plan.`);
    } catch (error) { notify(error.message, "error"); }
    finally { setPendingDelete(null); clearDrag(); }
  };

  const addMeal = async () => {
    const name = search.trim();
    if (!name) {
      const input = searchRef.current;
      if (input) { input.classList.remove("shake-error"); void input.offsetWidth; input.classList.add("shake-error"); input.focus(); window.setTimeout(() => input.classList.remove("shake-error"), 650); }
      return;
    }
    if (!name || adding) return;
    setAdding(true);
    try {
      const result = await api("/api/library", { method: "POST", headers: jsonHeaders(csrf), body: JSON.stringify({ name }) });
      if (result.created) {
        setLibrary((current) => [...current, result.meal]);
      } else notify("That meal is already in your library", "info");
      setSearch("");
      searchRef.current?.focus();
    } catch (error) { notify(error.message, "error"); }
    finally { setAdding(false); }
  };

  const shuffle = async (event) => {
    const button = event.currentTarget;
    button.classList.add("shuffle-spin");
    try {
      const result = await api("/api/library/shuffle", { method: "POST", headers: jsonHeaders(csrf), body: "{}" });
      setLibrary(result.library);
    } catch (error) { notify(error.message, "error"); }
    finally { window.setTimeout(() => button.classList.remove("shuffle-spin"), 650); }
  };

  const filteredLibrary = library.filter((meal) => meal.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <>
    <Header csrf={csrf} theme={theme} week={{ prev: data.prev_week, next: data.next_week, today: data.today_week, title: `${data.week_start_label} – ${data.week_end_label}` }} />
    <main className="app-layout">
      <section className="planner-panel" aria-label="Weekly meal planner">
        {data.error && <div className="error-banner" role="alert">{data.error}</div>}
        {data.unmatched?.length > 0 && <div className="warning-banner" role="status">{data.unmatched.length} meal{data.unmatched.length === 1 ? "" : "s"} have a due time that does not match a preset. Update the preset or meal time in Todoist.</div>}
        <div className="grid-scroll" id="planner-grid-scroll">
          <table className="meal-grid" id="meal-grid" data-slot-count={data.slots.length}>
            <caption className="visually-hidden">Meal plan from {data.week_start_label} to {data.week_end_label}; rows are meal slots and columns are days.</caption>
            <thead><tr><th className="grid-corner" scope="col"><span className="visually-hidden">Meal slot</span></th>
              {days.map((day) => <th key={day.iso} scope="col" className={`day-header${day.is_today ? " is-today" : ""}`} data-day={day.iso} aria-label={`${day.day_name}, ${day.date_label}, ${day.count} meal${day.count === 1 ? "" : "s"}`}>
                <div className="day-header-content"><span className="day-date">{day.date_label}</span><span className="day-name">{day.day_name}</span><span className="day-count" aria-hidden="true">{day.count}</span></div>
              </th>)}
            </tr></thead>
            <tbody>{data.slots.map((slot) => <tr key={slot.id}>
              <th scope="row" className="slot-label"><div className="slot-label-content"><span>{slot.name}</span><time>{slot.time}</time></div></th>
              {days.map((day) => {
                const cellKey = `${slot.id}:${day.iso}`;
                const tasks = grid[slot.id]?.[day.iso] || [];
                return <td key={cellKey} className={`meal-cell${hoverCell === cellKey ? " drag-hover" : ""}`} data-day={day.iso} data-slot={slot.id}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes("application/x-meal-library") && !event.dataTransfer.types.includes("application/x-planned-meal")) return;
                    event.preventDefault(); event.dataTransfer.dropEffect = dragRef.current?.type === "planned" ? "move" : "copy"; setHoverCell(cellKey);
                  }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHoverCell(""); }}
                  onDrop={(event) => dropIntoCell(event, slot, day)}>
                  <div className="meal-cell-content">{tasks.length === 0 && <span className="visually-hidden">No meals planned</span>}{tasks.map((task) => <TaskChip key={task.cache_key || `remote:${task.id}`} task={task} csrf={csrf} onRetry={retryOperation}
                    slotId={slot.id} dayIso={day.iso} onOpenActions={openTaskActions} onDragStart={onTaskDragStart} onDragEnd={clearDrag} />)}</div>
                </td>;
              })}
            </tr>)}</tbody>
          </table>
        </div>
      </section>
      <aside className="library-panel" id="library-panel" aria-label="Meal library">
        <div className="library-heading"><h1>Meal library</h1><button className="shuffle-button" type="button" id="shuffle-meals" title="Shuffle meal order" onClick={shuffle}><span aria-hidden="true">⤨</span> Shuffle</button></div>
        <div className="library-add-row"><input ref={searchRef} id="meal-search" type="search" placeholder="Search or type meal name…" autoComplete="off" aria-label="Search or type a meal name" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addMeal(); } }} />
          <button className="add-meal-button" id="add-meal" type="button" disabled={adding} onClick={addMeal}>Add meal</button></div>
        <div className="library-list" id="library-list" role="list">{filteredLibrary.map((meal) => <div key={meal.id} className="library-chip" draggable="true" role="listitem" data-meal-id={meal.id} data-meal-name={meal.name}
          onDragStart={(event) => onLibraryDragStart(event, meal)} onDragEnd={clearDrag}><span className="drag-grip" aria-hidden="true">⠿</span><span className="library-chip-name">{meal.name}</span>
          <button type="button" className="library-plan-trigger" aria-haspopup="dialog" aria-label={`Plan ${meal.name}`} title={`Plan ${meal.name}`} onDragStart={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => openLibraryPlan(meal, event.currentTarget)}>Plan</button></div>)}</div>
        <div className="trash-drop-target" id="trash-target" aria-label="Delete dragged planned meal" aria-hidden="true"
          onDragOver={(event) => { if (dragRef.current?.type !== "planned") return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; document.body.classList.add("trash-hover"); }}
          onDragLeave={() => document.body.classList.remove("trash-hover")}
          onDrop={(event) => { event.preventDefault(); document.body.classList.remove("trash-hover"); if (dragRef.current?.type === "planned") askDelete(dragRef.current.task); }}><span aria-hidden="true">▤</span></div>
      </aside>
    </main>
    <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    <dialog className="confirm-dialog action-dialog" id="meal-action-dialog" ref={actionDialogRef} aria-labelledby="meal-action-title" aria-describedby="meal-action-description" onClose={() => { if (!actionDialogRef.current?.open) setActionTarget(null); }}>
      {actionTarget && <form className="planner-action-form" onSubmit={submitAccessibleAction} aria-busy={actionBusy}>
        <h2 id="meal-action-title">{actionTarget.kind === "library" ? `Plan ${actionTarget.meal.name}` : `Move ${actionTarget.task.name}`}</h2>
        <p id="meal-action-description">Choose a day and meal slot. You can also drag meals on the planner.</p>
        <label htmlFor="planner-action-date">Day</label><select id="planner-action-date" value={actionDate} onChange={(event) => setActionDate(event.target.value)} disabled={actionBusy} required autoFocus>
          {days.map((day) => <option key={day.iso} value={day.iso}>{day.day_name}, {day.date_label}</option>)}
        </select>
        <label htmlFor="planner-action-slot">Meal slot</label><select id="planner-action-slot" value={actionSlot} onChange={(event) => setActionSlot(event.target.value)} disabled={actionBusy} required>
          {data.slots.map((slot) => <option key={slot.id} value={slot.id}>{slot.name}</option>)}
        </select>
        <div className="dialog-actions">
          {actionTarget.kind === "task" && <button type="button" className="danger-button" onClick={deleteActionTarget} disabled={actionBusy}>Delete</button>}
          <button type="button" className="secondary-button" onClick={closeActionDialog} disabled={actionBusy}>Cancel</button>
          <button type="submit" className="primary-button" disabled={actionBusy}>{actionBusy ? "Working…" : actionTarget.kind === "library" ? "Plan meal" : "Move meal"}</button>
        </div>
      </form>}
    </dialog>
    <dialog className="confirm-dialog" id="delete-confirm" ref={dialogRef} aria-labelledby="delete-meal-title" aria-describedby="delete-meal-description" onClose={(event) => {
      const confirmed = event.currentTarget.returnValue === "confirm";
      if (confirmed) confirmDelete();
      setPendingDelete(null);
    }}><form method="dialog"><h2 id="delete-meal-title">Delete this meal?</h2><p id="delete-meal-description">This removes the planned meal from Todoist.</p><div className="dialog-actions"><button value="cancel" className="secondary-button">Keep it</button><button value="confirm" className="danger-button">Delete</button></div></form></dialog>
  </>;
}

const SlotSettingsRow = forwardRef(function SlotSettingsRow({ slot, saving, dragging, position, total, onRemove, onReorderKey, onReorderStart, onReorderEnd, onNameChange, onTimeChange }, ref) {
  const swipeControls = useDragControls();
  const reorderControls = useDragControls();
  const reduceMotion = useReducedMotion();
  const [reorderActionsOpen, setReorderActionsOpen] = useState(false);
  const pointerStartRef = useRef(null);
  const suppressPostDragClickRef = useRef(false);
  useEffect(() => {
    if (!reorderActionsOpen) return;
    const closeOnOutsidePointer = (event) => {
      const row = event.target.closest(".slot-edit-row");
      if (row?.dataset.slotId === String(slot.id) && event.target.closest(".slot-order-controls")) return;
      setReorderActionsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [reorderActionsOpen, slot.id]);
  const startSwipe = (event) => {
    if (saving || (event.pointerType !== "touch" && event.pointerType !== "pen") || event.target.closest("button")) return;
    swipeControls.start(event, { distanceThreshold: 10 });
  };
  return <Reorder.Item ref={ref} as="div" className="slot-row-shell" data-slot-id={slot.id} value={slot} dragListener={false} dragControls={reorderControls}
    onDragStart={() => { suppressPostDragClickRef.current = true; setReorderActionsOpen(false); onReorderStart(slot.id); }} onDragEnd={() => onReorderEnd(slot.id)}
    whileDrag={{ zIndex: 5 }}
    transition={reduceMotion ? { layout: { duration: 0 } } : { layout: { type: "spring", stiffness: 700, damping: 50 } }}
    layout exit={{ x: "-110%", opacity: 0, height: 0, transition: { duration: reduceMotion ? 0 : 0.32, ease: [0.2, 0.72, 0.25, 1] } }}>
    <motion.div className={`slot-edit-row${dragging ? " slot-dragging" : ""}${reorderActionsOpen ? " reorder-actions-open" : ""}`} data-slot-id={slot.id}
      drag={!saving ? "x" : false} dragListener={false} dragControls={swipeControls} dragConstraints={{ left: -160, right: 0 }} dragElastic={0.06} dragMomentum={false} dragDirectionLock
      whileDrag={{ boxShadow: "0 8px 18px rgba(28,55,39,.18)" }}
      onPointerDown={startSwipe} onDragEnd={(event, info) => { if ((event.pointerType === "touch" || event.pointerType === "pen") && info.offset.x <= -76) onRemove(slot.id); }}>
      <div className="slot-order-controls" role="group" aria-label={`Reorder ${slot.name}`} onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setReorderActionsOpen(false); }}>
        <button type="button" className="slot-order-step" aria-label={`Move ${slot.name} up`} title={`Move ${slot.name} up`} disabled={saving || position === 0} onClick={() => onReorderKey(slot.id, -1)}>↑</button>
        <motion.button type="button" className="slot-edit-grip" aria-label={`Drag to reorder ${slot.name}; tap to show move buttons`} title="Drag to reorder; tap to show move buttons" disabled={saving}
          onPointerDown={(event) => { event.stopPropagation(); if (saving || (event.button !== undefined && event.button !== 0)) return; suppressPostDragClickRef.current = false; pointerStartRef.current = { x: event.clientX, y: event.clientY, pointerType: event.pointerType }; reorderControls.start(event, { distanceThreshold: event.pointerType === "touch" || event.pointerType === "pen" ? 10 : 5 }); }}
          onPointerUp={(event) => { const start = pointerStartRef.current; pointerStartRef.current = null; const threshold = start?.pointerType === "touch" || start?.pointerType === "pen" ? 10 : 5; if (start && !suppressPostDragClickRef.current && Math.hypot(event.clientX - start.x, event.clientY - start.y) < threshold) setReorderActionsOpen(true); }}
          onPointerCancel={() => { pointerStartRef.current = null; }} onClick={(event) => { event.stopPropagation(); if (suppressPostDragClickRef.current) { suppressPostDragClickRef.current = false; return; } setReorderActionsOpen(true); }}>⠿</motion.button>
        <button type="button" className="slot-order-step" aria-label={`Move ${slot.name} down`} title={`Move ${slot.name} down`} disabled={saving || position >= total - 1} onClick={() => onReorderKey(slot.id, 1)}>↓</button>
      </div>
      <label><span className="visually-hidden">Meal slot label</span><input className="slot-name" name="meal_slot_label" aria-label="Meal slot label" autoComplete="off" autoCapitalize="words" autoCorrect="off" spellCheck="false" maxLength={32} required disabled={saving} value={slot.name} onChange={(event) => onNameChange(slot.id, event.target.value)} /></label>
      <label><span className="visually-hidden">Preset time</span><input className="slot-time" aria-label="Preset time" type="time" required disabled={saving} value={slot.time} onChange={(event) => onTimeChange(slot.id, event.target.value)} /></label>
      <button type="button" className="remove-slot" aria-label={`Remove ${slot.name}`} title="Remove meal slot" disabled={saving} onPointerDown={(event) => event.stopPropagation()} onClick={() => onRemove(slot.id)}><svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18M8 6V4h8v2m2 0-1 14H7L6 6m4 5v6m4-6v6" /></svg></button>
    </motion.div>
  </Reorder.Item>;
});

function SettingsPage({ data, csrf, theme, notify }) {
  const [slots, setSlots] = useState(data.slots || []);
  const [library, setLibrary] = useState(data.library || []);
  const [search, setSearch] = useState("");
  const [themeFeedback, setThemeFeedback] = useState("");
  const [libraryFeedback, setLibraryFeedback] = useState("");
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState("idle");
  const [savedTimer, setSavedTimer] = useState(null);
  const [removingSlots, setRemovingSlots] = useState(new Set());
  const [removingMeals, setRemovingMeals] = useState(new Set());
  const [draggingId, setDraggingId] = useState("");
  const [isReordering, setIsReordering] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const reorderStartOrderRef = useRef([]);
  const reorderStartStateRef = useRef("");
  const removingSlotsRef = useRef(new Set());
  const baseline = useRef(JSON.stringify(data.slots || []));
  const valid = slots.length > 0 && slots.length <= 12 && slots.every((slot) => slot.name.trim() && /^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time)) && new Set(slots.map((slot) => slot.time)).size === slots.length;
  const dirty = (isReordering ? reorderStartStateRef.current !== baseline.current : JSON.stringify(slots) !== baseline.current) || removingSlots.size > 0;
  const visibleSlots = slots.filter((slot) => !removingSlots.has(slot.id));
  const filteredLibrary = library.filter((meal) => meal.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  useEffect(() => {
    const onKeyDown = (event) => {
      if (["Tab", "ArrowUp", "ArrowDown", "Enter", " "].includes(event.key)) document.body.classList.add("keyboard-navigation");
    };
    const onPointerDown = (event) => {
      if (event.target.closest(".slot-order-controls")) return;
      document.body.classList.remove("keyboard-navigation");
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.body.classList.remove("keyboard-navigation");
    };
  }, []);
  useEffect(() => () => { if (savedTimer) window.clearTimeout(savedTimer); }, [savedTimer]);
  useEffect(() => {
    if (dirty && saveState === "saved") {
      if (savedTimer) window.clearTimeout(savedTimer);
      setSavedTimer(null);
      setSaveState("idle");
    }
  }, [dirty, saveState, savedTimer]);
  const startSlotReorder = (id) => {
    if (saving || removingSlots.size) return;
    reorderStartOrderRef.current = slots.map((slot) => slot.id);
    reorderStartStateRef.current = JSON.stringify(slots);
    setDraggingId(id);
    setIsReordering(true);
  };
  const finishSlotReorder = (id) => {
    const startOrder = reorderStartOrderRef.current;
    const position = slots.findIndex((slot) => slot.id === id);
    if (position >= 0 && startOrder.indexOf(id) !== position) {
      setAnnouncement("");
      window.requestAnimationFrame(() => setAnnouncement(`${slots[position].name || "Meal slot"} moved to position ${position + 1} of ${slots.length}.`));
    }
    setDraggingId("");
    setIsReordering(false);
    reorderStartOrderRef.current = [];
    reorderStartStateRef.current = "";
  };
  const moveByKeyboard = (id, direction) => {
    if (saving || isReordering || removingSlots.size) return;
    const index = slots.findIndex((slot) => slot.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= slots.length) return;
    const moved = [...slots]; const [item] = moved.splice(index, 1); moved.splice(target, 0, item);
    setSlots(moved);
    setAnnouncement("");
    window.requestAnimationFrame(() => setAnnouncement(`${item.name || "Meal slot"} moved to position ${target + 1} of ${slots.length}.`));
  };

  const removeSlot = (id) => {
    if (saving || isReordering || removingSlotsRef.current.has(id)) return;
    const next = new Set(removingSlotsRef.current);
    next.add(id);
    removingSlotsRef.current = next;
    setRemovingSlots(next);
  };
  const completeSlotRemovals = () => {
    const removedIds = new Set(removingSlotsRef.current);
    if (!removedIds.size) return;
    setSlots((current) => current.filter((slot) => !removedIds.has(slot.id)));
    removingSlotsRef.current = new Set();
    setRemovingSlots(new Set());
    setFeedback("");
  };

  const revert = () => {
    if (saving || isReordering || !dirty) return;
    if (savedTimer) window.clearTimeout(savedTimer);
    setSavedTimer(null); setSaveState("idle"); removingSlotsRef.current = new Set(); setRemovingSlots(new Set()); setSlots(JSON.parse(baseline.current)); setFeedback("");
  };

  const saveSlots = async (event) => {
    event.preventDefault();
    if (saving || isReordering || removingSlots.size || !dirty || !valid) {
      if (isReordering || removingSlots.size) return;
      if (!slots.every((slot) => slot.name.trim() && slot.time)) setFeedback("Every meal slot needs a name and a unique time.");
      else if (new Set(slots.map((slot) => slot.time)).size !== slots.length) setFeedback("Each meal slot needs a unique preset time.");
      return;
    }
    const normalized = slots.map((slot) => ({ id: slot.id, name: slot.name.trim(), time: slot.time }));
    setSaving(true); setFeedback(""); setSaveState("saving");
    const started = performance.now();
    if (savedTimer) window.clearTimeout(savedTimer);
    setSavedTimer(null);
    try {
      await api("/api/settings/slots", { method: "POST", headers: jsonHeaders(csrf), body: JSON.stringify({ slots: normalized }) });
      const hold = Math.max(0, 420 - (performance.now() - started));
      if (hold) await wait(hold);
      setSlots(normalized); baseline.current = JSON.stringify(normalized); setSaving(false); setSaveState("saved");
      const timer = window.setTimeout(() => setSaveState((current) => current === "saved" ? "idle" : current), 900);
      setSavedTimer(timer);
    } catch (error) {
      setSaveState("error"); setFeedback(error.message); notify(error.message, "error");
      const timer = window.setTimeout(() => setSaveState((current) => current === "error" ? "idle" : current), 900);
      setSavedTimer(timer);
    } finally { setSaving(false); }
  };

  const removeMeal = async (meal) => {
    if (!window.confirm(`Remove “${meal.name}” from the reusable library? Any meals already planned in Todoist will stay unchanged.`)) return;
    setRemovingMeals((current) => new Set(current).add(meal.id));
    try {
      await api(`/api/library/${encodeURIComponent(meal.id)}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } });
      window.setTimeout(() => {
        setLibrary((current) => current.filter((item) => item.id !== meal.id));
        setRemovingMeals((current) => { const next = new Set(current); next.delete(meal.id); return next; });
        setLibraryFeedback(`Removed ${meal.name} from the library. Planned meals are unchanged.`);
      }, 180);
    } catch (error) {
      setRemovingMeals((current) => { const next = new Set(current); next.delete(meal.id); return next; });
      setLibraryFeedback(error.message); notify(error.message, "error");
    }
  };

  return <>
    <Header csrf={csrf} theme={theme} />
    <main className="settings-shell"><h1>Settings</h1>
      {data.error && <div className="error-banner" role="alert">{data.error}</div>}{data.saved && <div className="success-banner" role="status">{data.saved}</div>}
      <section className="settings-section appearance-settings" aria-labelledby="appearance-heading">
        <div className="settings-section-heading"><div><h2 id="appearance-heading">Appearance</h2><p>System follows your device. The plan-page button switches to the other theme.</p></div><span className="settings-section-mark" aria-hidden="true"><Icon name="sun" /></span></div>
        <fieldset className="theme-options"><legend className="visually-hidden">Color theme</legend>
          {["system", "light", "dark"].map((mode) => <label key={mode} className="theme-option"><input type="radio" name="theme-mode" value={mode} checked={theme.mode === mode} disabled={theme.busy} onChange={() => { setThemeFeedback(""); theme.save(mode).then((ok) => ok && setThemeFeedback(mode === "system" ? "Using your system appearance." : `Appearance set to ${mode}.`)); }} /><span><strong>{mode[0].toUpperCase() + mode.slice(1)}</strong><small>{mode === "system" ? "Use this device’s light or dark setting" : `Always use the ${mode} theme`}</small></span></label>)}
        </fieldset><p className="settings-feedback" id="theme-feedback" role="status">{themeFeedback}</p>
      </section>
      <section className="settings-section library-manager" aria-labelledby="library-manager-heading">
        <div className="settings-section-heading"><div><h2 id="library-manager-heading">Manage meal library</h2><p>Remove reusable choices here. This does not delete meals already planned in Todoist.</p></div><span className="settings-count" id="managed-library-count">{library.length}</span></div>
        <label className="library-manager-search-label" htmlFor="library-manager-search">Find a meal</label>
        <input className="library-manager-search" id="library-manager-search" type="search" placeholder="Search meal names…" autoComplete="off" value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="manage-library-list" id="manage-library-list">{filteredLibrary.map((meal) => <div key={meal.id} className={`manage-meal-row${removingMeals.has(meal.id) ? " library-row-removing" : ""}`} data-meal-id={meal.id} data-meal-name={meal.name}><span className="manage-meal-name">{meal.name}</span><button type="button" className="manage-remove-meal" onClick={() => removeMeal(meal)}>Remove</button></div>)}</div>
        <p className="empty-library-message" id="empty-library-message" hidden={library.length > 0}>Your meal library is empty.</p>
        <p className="settings-feedback" id="library-feedback" role="status">{libraryFeedback}</p>
      </section>
      <section className="settings-section slot-settings-section" aria-labelledby="slot-settings-heading">
        <h2 id="slot-settings-heading">Meal slots</h2>
        <form id="slot-settings" className="slot-settings-form" autoComplete="off" onSubmit={saveSlots}>
          <Reorder.Group as="div" axis="y" className="slot-list" id="slot-settings-list" values={visibleSlots} onReorder={(next) => { if (!saving && !removingSlots.size) setSlots(next); }}>
            <AnimatePresence initial={false} onExitComplete={completeSlotRemovals}>
              {visibleSlots.map((slot, position) => <SlotSettingsRow key={slot.id} slot={slot} position={position} total={visibleSlots.length} saving={saving} dragging={draggingId === slot.id}
                onRemove={removeSlot} onReorderKey={moveByKeyboard} onReorderStart={startSlotReorder} onReorderEnd={finishSlotReorder}
                onNameChange={(id, name) => { if (saving || isReordering) return; setSlots((current) => current.map((item) => item.id === id ? { ...item, name } : item)); setFeedback(""); }}
                onTimeChange={(id, time) => { if (saving || isReordering) return; setSlots((current) => current.map((item) => item.id === id ? { ...item, time } : item)); setFeedback(""); }} />)}
            </AnimatePresence>
          </Reorder.Group>
          <div className="settings-actions"><button type="button" id="add-slot" className="secondary-button" disabled={saving || removingSlots.size > 0 || slots.length >= 12} onClick={() => { if (saving || isReordering || removingSlots.size > 0) return; setSlots((current) => [...current, { id: uuid(), name: "", time: "" }]); setFeedback(""); }}>+ Add slot</button>
            <div className="settings-save-actions"><button type="button" id="revert-slot-changes" className="secondary-button" disabled={saving || !dirty} onClick={revert}>Revert</button>
              <button type="submit" className={`primary-button slot-save-button${saveState === "saved" ? " is-saved" : ""}${saveState === "error" ? " is-error" : ""}`} data-state={saveState} aria-label={saveState === "saving" ? "Saving" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : "Save"} disabled={saving || removingSlots.size > 0 || !dirty || !valid}>
                <span className="slot-save-state slot-save-idle" aria-hidden="true">Save</span><span className="slot-save-state slot-save-busy" aria-hidden="true"><span className="button-spinner" /></span><span className="slot-save-state slot-save-done" aria-hidden="true">✓</span><span className="slot-save-state slot-save-error" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M18 6 6 18M6 6l12 12" /></svg></span>
              </button>
            </div>
          </div>
          <p className="settings-feedback" id="settings-feedback" role="status">{feedback}</p>
          <p className="visually-hidden" id="slot-reorder-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
        </form>
      </section>
    </main>
  </>;
}

function App({ root, boot }) {
  const [toasts, setToasts] = useState([]);
  const notify = useCallback((message, kind = "success") => {
    const id = uuid();
    setToasts((current) => [...current, { id, message, kind, leaving: false }]);
    window.setTimeout(() => setToasts((current) => current.map((item) => item.id === id ? { ...item, leaving: true } : item)), 2700);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3000);
  }, []);
  const theme = useTheme(boot.theme_mode, boot.csrf, notify);
  const page = root.dataset.page;
  return <>
    {page === "settings" ? <SettingsPage data={boot} csrf={boot.csrf} theme={theme} notify={notify} /> : <PlannerBoard data={boot} csrf={boot.csrf} theme={theme} notify={notify} />}
    <ToastRegion items={toasts} />
  </>;
}

const root = document.getElementById("react-root");
if (root) {
  try {
    const boot = JSON.parse(root.dataset.boot || "{}");
    createRoot(root).render(<App root={root} boot={boot} />);
  } catch (error) {
    root.textContent = "The planner could not start. Refresh the page to try again.";
    console.error("Dinner Planner React initialization failed", error);
  }
}
