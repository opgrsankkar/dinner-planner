(() => {
  const body = document.body;
  const csrf = body.dataset.csrf || "";
  const tokenHeader = { "X-CSRF-Token": csrf, "Content-Type": "application/json" };
  const toastRegion = document.getElementById("toast-region");
  const libraryList = document.getElementById("library-list");
  const search = document.getElementById("meal-search");
  const trash = document.getElementById("trash-target");
  let draggedTask = null;
  let deletePromise = Promise.resolve(false);

  function toast(message, kind = "success") {
    if (!toastRegion) return;
    const item = document.createElement("div");
    item.className = `toast toast-${kind}`;
    item.textContent = message;
    toastRegion.append(item);
    window.setTimeout(() => {
      item.classList.add("toast-leave");
      window.setTimeout(() => item.remove(), 300);
    }, 2700);
  }

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: "same-origin", ...options });
    let payload = {};
    try { payload = await response.json(); } catch (_) { /* non-JSON response */ }
    if (!response.ok) throw new Error(payload.detail || payload.error || `Request failed (${response.status})`);
    return payload;
  }

  function flashEmptySearch() {
    if (!search) return;
    search.classList.remove("shake-error");
    void search.offsetWidth;
    search.classList.add("shake-error");
    search.focus();
    window.setTimeout(() => search.classList.remove("shake-error"), 650);
  }

  function filterLibrary() {
    if (!search || !libraryList) return;
    const query = search.value.trim().toLocaleLowerCase();
    libraryList.querySelectorAll(".library-chip").forEach((chip) => {
      chip.hidden = query && !chip.dataset.mealName.toLocaleLowerCase().includes(query);
    });
  }

  if (search) search.addEventListener("input", filterLibrary);

  const addMeal = document.getElementById("add-meal");
  if (addMeal && search) addMeal.addEventListener("click", async () => {
    const name = search.value.trim();
    if (!name) return flashEmptySearch();
    addMeal.disabled = true;
    addMeal.classList.add("is-adding");
    try {
      const result = await api("/api/library", { method: "POST", headers: tokenHeader, body: JSON.stringify({ name }) });
      if (result.created) {
        const chip = document.createElement("div");
        chip.className = "library-chip pop-in";
        chip.draggable = true;
        chip.dataset.mealId = result.meal.id;
        chip.dataset.mealName = result.meal.name;
        const grip = document.createElement("span");
        grip.className = "drag-grip";
        grip.setAttribute("aria-hidden", "true");
        grip.textContent = "⠿";
        const label = document.createElement("span");
        label.textContent = result.meal.name;
        chip.append(grip, label);
        libraryList.append(chip);
        wireLibraryChip(chip);
        toast("Meal added to your library");
      } else {
        toast("That meal is already in your library", "info");
      }
      search.value = "";
      filterLibrary();
      search.focus();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      addMeal.disabled = false;
      addMeal.classList.remove("is-adding");
    }
  });

  const shuffleButton = document.getElementById("shuffle-meals");
  if (shuffleButton && libraryList) shuffleButton.addEventListener("click", async () => {
    shuffleButton.classList.add("shuffle-spin");
    try {
      const result = await api("/api/library/shuffle", { method: "POST", headers: tokenHeader, body: "{}" });
      const chips = new Map([...libraryList.querySelectorAll(".library-chip")].map((x) => [x.dataset.mealId, x]));
      for (const [index, meal] of result.library.entries()) {
        const chip = chips.get(meal.id);
        if (chip) {
          libraryList.append(chip);
          chip.style.setProperty("--shuffle-index", index);
          chip.classList.remove("shuffle-pop");
          void chip.offsetWidth;
          chip.classList.add("shuffle-pop");
        }
      }
    } catch (error) {
      toast(error.message, "error");
    } finally {
      window.setTimeout(() => shuffleButton.classList.remove("shuffle-spin"), 650);
    }
  });

  function wireLibraryChip(chip) {
    chip.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/x-meal-library", JSON.stringify({ meal_id: chip.dataset.mealId }));
      chip.classList.add("is-dragging");
      body.classList.add("library-dragging");
    });
    chip.addEventListener("dragend", () => {
      chip.classList.remove("is-dragging");
      body.classList.remove("library-dragging");
      document.querySelectorAll(".meal-cell.drag-hover").forEach((el) => el.classList.remove("drag-hover"));
    });
  }

  document.querySelectorAll(".library-chip").forEach(wireLibraryChip);

  const confirmDialog = document.getElementById("delete-confirm");
  function askDelete() {
    if (!confirmDialog || typeof confirmDialog.showModal !== "function") return Promise.resolve(window.confirm("Delete this planned meal from Todoist?"));
    confirmDialog.showModal();
    return new Promise((resolve) => {
      confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "confirm"), { once: true });
    });
  }

  function hideTrash() {
    body.classList.remove("planner-dragging", "trash-hover");
    if (trash) trash.setAttribute("aria-hidden", "true");
  }

  function iconMarkup(name, extraClass = "ui-icon") {
    return `<svg class="${extraClass}" aria-hidden="true"><use href="/static/lucide-icons.svg#${name}"></use></svg>`;
  }

  function syncIndicator(chip, state, operationId, detail = "") {
    let indicator = chip.querySelector(".meal-sync-indicator");
    if (!indicator) {
      indicator = document.createElement("button");
      indicator.type = "button";
      indicator.className = "meal-sync-indicator";
      chip.append(indicator);
    }
    indicator.disabled = state !== "failed";
    indicator.classList.toggle("sync-indicator-failed", state === "failed");
    const icon = state === "done" ? "check" : state === "failed" ? "alert" : "loader";
    indicator.innerHTML = iconMarkup(icon, `ui-icon ${state === "pending" ? "sync-spinner" : ""}`);
    indicator.title = state === "failed" ? `Save failed — click to retry${detail ? ` · ${detail}` : ""}` : state === "done" ? "Saved to Todoist" : "Saving to Todoist";
    indicator.setAttribute("aria-label", indicator.title);
    if (state === "failed") {
      indicator.onclick = async () => {
        try {
          await api(`/api/operations/${encodeURIComponent(operationId)}/retry`, { method: "POST", headers: tokenHeader, body: "{}" });
          if (chip.classList.contains("is-delete-pending") && chip.dataset.countRemoved !== "true") {
            adjustDayCount(chip.dataset.taskDate, -1);
            chip.dataset.countRemoved = "true";
          }
          syncIndicator(chip, "pending", operationId);
          chip.classList.add("is-sync-pending");
          chip.draggable = false;
          watchOperation(operationId, chip);
        } catch (error) { toast(error.message, "error"); }
      };
    } else indicator.onclick = null;
    return indicator;
  }

  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  async function watchOperation(operationId, chip) {
    while (chip.isConnected) {
      let status;
      try { status = await api(`/api/operations/${encodeURIComponent(operationId)}`); }
      catch (_) { await wait(800); continue; }
      if (status.state === "done") {
        if (status.remote_id) chip.dataset.taskId = status.remote_id;
        if (status.task_key) chip.dataset.taskKey = status.task_key;
        syncIndicator(chip, "done", operationId);
        chip.classList.remove("is-sync-pending", "is-delete-pending");
        chip.draggable = !chip.classList.contains("is-complete");
        if (chip.classList.contains("sync-remove-after-save")) {
          window.setTimeout(() => { chip.classList.add("meal-chip-leave"); window.setTimeout(() => chip.remove(), 260); }, 650);
        } else {
          window.setTimeout(() => chip.querySelector(".meal-sync-indicator")?.remove(), 800);
        }
        return;
      }
      if (status.state === "failed") {
        syncIndicator(chip, "failed", operationId, status.error || "");
        chip.classList.remove("is-sync-pending");
        chip.draggable = false;
        if (chip.classList.contains("is-delete-pending") && chip.dataset.countRemoved === "true") {
          adjustDayCount(chip.dataset.taskDate, 1);
          chip.dataset.countRemoved = "false";
        }
        toast("Couldn't save this meal to Todoist. Use its small warning icon to retry.", "error");
        return;
      }
      await wait(360);
    }
  }

  function beginSync(chip, operationId, deleting = false) {
    chip.dataset.operationId = operationId;
    chip.classList.add("is-sync-pending");
    if (deleting) chip.classList.add("is-delete-pending", "sync-remove-after-save");
    chip.draggable = false;
    syncIndicator(chip, "pending", operationId);
    watchOperation(operationId, chip);
  }

  function adjustDayCount(day, delta) {
    const count = document.querySelector(`.day-header[data-day="${CSS.escape(day)}"] .day-count`);
    if (count) count.textContent = String(Math.max(0, (Number.parseInt(count.textContent, 10) || 0) + delta));
  }

  function wirePlannedChip(chip) {
    chip.addEventListener("dragstart", (event) => {
      if (chip.classList.contains("is-sync-pending") || chip.classList.contains("sync-indicator-failed")) { event.preventDefault(); return; }
      draggedTask = { task_id: chip.dataset.taskId, task_key: chip.dataset.taskKey || chip.dataset.taskId, date: chip.dataset.taskDate, chip, cell: chip.closest(".meal-cell") };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-planned-meal", JSON.stringify({ task_id: draggedTask.task_id, task_key: draggedTask.task_key, date: draggedTask.date }));
      chip.classList.add("is-dragging");
      body.classList.add("planner-dragging");
      if (trash) trash.setAttribute("aria-hidden", "false");
    });
    chip.addEventListener("dragend", () => {
      chip.classList.remove("is-dragging");
      draggedTask = null;
      hideTrash();
      document.querySelectorAll(".meal-cell.drag-hover").forEach((el) => el.classList.remove("drag-hover"));
    });
  }
  document.querySelectorAll(".meal-chip[draggable='true']").forEach(wirePlannedChip);
  document.querySelectorAll(".meal-chip[data-operation-id]").forEach((chip) => watchOperation(chip.dataset.operationId, chip));

  document.querySelectorAll(".meal-cell").forEach((cell) => {
    cell.addEventListener("dragover", (event) => {
      if (!event.dataTransfer.types.includes("application/x-meal-library") && !event.dataTransfer.types.includes("application/x-planned-meal")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = draggedTask ? "move" : "copy";
      cell.classList.add("drag-hover");
    });
    cell.addEventListener("dragleave", (event) => {
      if (!cell.contains(event.relatedTarget)) cell.classList.remove("drag-hover");
    });
    cell.addEventListener("drop", async (event) => {
      event.preventDefault();
      cell.classList.remove("drag-hover");
      const libraryPayload = event.dataTransfer.getData("application/x-meal-library");
      const plannedPayload = event.dataTransfer.getData("application/x-planned-meal");
      try {
        if (libraryPayload) {
          const item = JSON.parse(libraryPayload);
          const result = await api("/api/plan", { method: "POST", headers: tokenHeader, body: JSON.stringify({ meal_id: item.meal_id, date: cell.dataset.day, slot_id: cell.dataset.slot, request_id: crypto.randomUUID() }) });
          const chip = document.createElement("div");
          chip.className = "meal-chip pop-in";
          chip.dataset.taskId = result.task_id;
          chip.dataset.taskKey = result.task_key;
          chip.dataset.taskDate = cell.dataset.day;
          chip.dataset.mealName = result.name;
          chip.title = result.name;
          const label = document.createElement("span");
          label.className = "meal-chip-name";
          label.textContent = result.name;
          chip.append(label);
          cell.append(chip);
          wirePlannedChip(chip);
          adjustDayCount(cell.dataset.day, 1);
          beginSync(chip, result.operation_id);
          toast("Meal placed");
        } else if (plannedPayload) {
          const item = JSON.parse(plannedPayload);
          if (item.date === cell.dataset.day && cell.querySelector(`[data-task-id="${CSS.escape(item.task_id)}"]`) && document.querySelector(`[data-task-id="${CSS.escape(item.task_id)}"]`).closest(".meal-cell") === cell) return;
          const chip = draggedTask?.chip || document.querySelector(`[data-task-key="${CSS.escape(item.task_key)}"]`);
          const oldCell = chip?.closest(".meal-cell");
          const oldDay = chip?.dataset.taskDate;
          const result = await api(`/api/plan/${encodeURIComponent(item.task_key)}/move`, { method: "POST", headers: tokenHeader, body: JSON.stringify({ date: cell.dataset.day, slot_id: cell.dataset.slot, request_id: crypto.randomUUID() }) });
          if (chip) {
            cell.append(chip);
            chip.dataset.taskDate = cell.dataset.day;
            chip.classList.add("pop-in");
            window.setTimeout(() => chip.classList.remove("pop-in"), 500);
            if (oldDay !== cell.dataset.day) { adjustDayCount(oldDay, -1); adjustDayCount(cell.dataset.day, 1); }
            beginSync(chip, result.operation_id);
          }
          toast("Meal moved");
        }
      } catch (error) {
        toast(error.message, "error");
      }
    });
  });

  if (trash) {
    trash.setAttribute("aria-hidden", "true");
    trash.addEventListener("dragover", (event) => {
      if (!draggedTask) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      body.classList.add("trash-hover");
    });
    trash.addEventListener("dragleave", () => body.classList.remove("trash-hover"));
    trash.addEventListener("drop", async (event) => {
      event.preventDefault();
      body.classList.remove("trash-hover");
      if (!draggedTask) return;
      const item = draggedTask;
      hideTrash();
      if (!(await askDelete())) return;
      try {
        const chip = item.chip || document.querySelector(`[data-task-key="${CSS.escape(item.task_key)}"]`);
        const result = await api(`/api/plan/${encodeURIComponent(item.task_key)}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf, "X-Request-ID": crypto.randomUUID() } });
        if (chip) {
          chip.classList.add("sync-remove-after-save");
          adjustDayCount(chip.dataset.taskDate, -1);
          chip.dataset.countRemoved = "true";
          beginSync(chip, result.operation_id, true);
        }
        toast("Removing meal");
      } catch (error) {
        toast(error.message, "error");
      }
    });
  }

  const slotForm = document.getElementById("slot-settings");
  const slotList = document.getElementById("slot-settings-list");
  const feedback = document.getElementById("settings-feedback");
  const addSlot = document.getElementById("add-slot");
  const slotRevert = document.getElementById("revert-slot-changes");
  const slotSubmit = slotForm?.querySelector("button[type='submit']");
  const collectSlots = () => [...(slotList?.querySelectorAll(".slot-edit-row") || [])].map((row) => ({
    id: row.dataset.slotId || "", name: row.querySelector(".slot-name").value.trim(), time: row.querySelector(".slot-time").value,
  }));
  let savedSlotState = JSON.stringify(collectSlots());
  let slotSaving = false;
  let slotSavedTimer = null;
  function updateSlotSaveState() {
    if (!slotSubmit || !slotList) return;
    const rows = [...slotList.querySelectorAll(".slot-edit-row")];
    const slots = collectSlots();
    const valid = slots.length > 0 && slots.length <= 12 && rows.every((row) =>
      row.querySelector(".slot-name").checkValidity() && !!row.querySelector(".slot-name").value.trim() && row.querySelector(".slot-time").checkValidity() && !!row.querySelector(".slot-time").value,
    ) && new Set(slots.map((slot) => slot.time)).size === slots.length;
    const dirty = JSON.stringify(slots) !== savedSlotState;
    if (dirty && slotSubmit.dataset.state === "saved") {
      slotSubmit.dataset.state = "idle";
      slotSubmit.setAttribute("aria-label", "Save");
      slotSubmit.classList.remove("is-saved");
    }
    slotSubmit.disabled = slotSaving || !valid || !dirty;
    if (slotRevert) slotRevert.disabled = slotSaving || !dirty;
  }
  function setSlotFeedback(message, hidden = false) {
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.toggle("visually-hidden", hidden && !!message);
  }
  function clearSlotFeedback() { setSlotFeedback(""); }
  function newSlotRow() {
    const row = document.createElement("div");
    row.className = "slot-edit-row pop-in";
    row.dataset.slotId = crypto.randomUUID();
    row.innerHTML = '<button type="button" class="slot-edit-grip" aria-label="Reorder meal slot" title="Drag to reorder or use the up/down arrow keys">⠿</button><label><span>Meal slot label</span><input class="slot-name" name="meal_slot_label" aria-label="Meal slot label" autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false" maxlength="32" required></label><label><span>Preset time</span><input class="slot-time" aria-label="Preset time" type="time" required></label><button type="button" class="remove-slot" aria-label="Remove meal slot" title="Remove meal slot"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18M8 6V4h8v2m2 0-1 14H7L6 6m4 5v6m4-6v6"/></svg></button>';
    wireRemoveSlot(row);
    wireSlotReorder(row);
    return row;
  }
  function wireRemoveSlot(row) {
    row.querySelector(".remove-slot").addEventListener("click", () => {
      row.classList.add("slot-removing");
      window.setTimeout(() => { row.remove(); clearSlotFeedback(); updateSlotSaveState(); }, 220);
    });
  }
  function announceSlotPosition(row) {
    if (!feedback || !slotList) return;
    const rows = [...slotList.querySelectorAll(".slot-edit-row")];
    const index = rows.indexOf(row);
    const name = row.querySelector(".slot-name").value.trim() || "Meal slot";
    setSlotFeedback(`Moved ${name} to position ${index + 1}.`, true);
    updateSlotSaveState();
  }
  let activeSlotPointer = null;
  function wireSlotReorder(row) {
    const grip = row.querySelector(".slot-edit-grip");
    if (!grip || !slotList) return;
    const nameInput = row.querySelector(".slot-name");
    const updateLabel = () => {
      const label = nameInput.value.trim() || "meal slot";
      grip.setAttribute("aria-label", `Reorder ${label}`);
      row.querySelector(".remove-slot").setAttribute("aria-label", `Remove ${label}`);
    };
    nameInput.addEventListener("input", () => { updateLabel(); clearSlotFeedback(); updateSlotSaveState(); });
    const timeInput = row.querySelector(".slot-time");
    const updateTimeState = () => { clearSlotFeedback(); updateSlotSaveState(); };
    timeInput.addEventListener("input", updateTimeState);
    timeInput.addEventListener("change", updateTimeState);
    updateLabel();
    grip.addEventListener("pointerdown", (event) => {
      if (activeSlotPointer || (event.button !== undefined && event.button !== 0)) return;
      event.preventDefault();
      activeSlotPointer = { pointerId: event.pointerId, row, startY: event.clientY, moved: false };
    });
    grip.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const rows = [...slotList.querySelectorAll(".slot-edit-row")];
      const index = rows.indexOf(row);
      if (event.key === "ArrowUp" && index > 0) slotList.insertBefore(row, rows[index - 1]);
      else if (event.key === "ArrowDown" && index < rows.length - 1) slotList.insertBefore(row, rows[index + 1].nextElementSibling);
      else return;
      announceSlotPosition(row);
    });
  }
  document.addEventListener("pointermove", (event) => {
    const drag = activeSlotPointer;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.abs(event.clientY - drag.startY) < 5) return;
    drag.moved = true;
    drag.row.classList.add("slot-dragging");
    const rows = [...slotList.querySelectorAll(".slot-edit-row")];
    const next = rows.find((candidate) => {
      if (candidate === drag.row) return false;
      const bounds = candidate.getBoundingClientRect();
      return event.clientY < bounds.top + bounds.height / 2;
    });
    if (next) slotList.insertBefore(drag.row, next);
    else slotList.append(drag.row);
  });
  function finishSlotPointer(event) {
    const drag = activeSlotPointer;
    if (!drag || drag.pointerId !== event.pointerId) return;
    activeSlotPointer = null;
    drag.row.classList.remove("slot-dragging");
    if (drag.moved) announceSlotPosition(drag.row);
  }
  document.addEventListener("pointerup", finishSlotPointer);
  document.addEventListener("pointercancel", finishSlotPointer);
  document.querySelectorAll(".slot-edit-row").forEach((row) => { wireRemoveSlot(row); wireSlotReorder(row); });
  if (addSlot && slotList) addSlot.addEventListener("click", () => {
    const row = newSlotRow();
    slotList.append(row);
    clearSlotFeedback();
    updateSlotSaveState();
    row.querySelector(".slot-name").focus();
  });
  if (slotRevert && slotList && slotSubmit) slotRevert.addEventListener("click", () => {
    if (slotSaving) return;
    if (slotSavedTimer) window.clearTimeout(slotSavedTimer);
    slotSavedTimer = null;
    slotSubmit.dataset.state = "idle";
    slotSubmit.setAttribute("aria-label", "Save");
    slotSubmit.classList.remove("is-saved", "is-error");
    const baseline = JSON.parse(savedSlotState);
    slotList.replaceChildren(...baseline.map((slot) => {
      const row = newSlotRow();
      row.dataset.slotId = slot.id;
      row.querySelector(".slot-name").value = slot.name;
      row.querySelector(".slot-time").value = slot.time;
      row.querySelector(".slot-edit-grip").setAttribute("aria-label", `Reorder ${slot.name}`);
      row.querySelector(".remove-slot").setAttribute("aria-label", `Remove ${slot.name}`);
      return row;
    }));
    clearSlotFeedback();
    updateSlotSaveState();
  });
  if (slotForm && slotList) slotForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    updateSlotSaveState();
    if (!slotSubmit || slotSubmit.disabled) return;
    const slots = collectSlots();
    if (slots.some((slot) => !slot.name || !slot.time)) {
      setSlotFeedback("Every meal slot needs a name and a unique time.");
      slotList.querySelector(".slot-time:invalid")?.focus();
      updateSlotSaveState();
      return;
    }
    if (new Set(slots.map((slot) => slot.time)).size !== slots.length) {
      setSlotFeedback("Each meal slot needs a unique preset time.");
      slotList.querySelector(".slot-time")?.focus();
      updateSlotSaveState();
      return;
    }
    slotSaving = true;
    const saveStartedAt = performance.now();
    if (slotSavedTimer) window.clearTimeout(slotSavedTimer);
    slotSubmit.classList.remove("is-saved", "is-error");
    slotSubmit.dataset.state = "saving";
    slotSubmit.setAttribute("aria-label", "Saving");
    updateSlotSaveState();
    try {
      await api("/api/settings/slots", { method: "POST", headers: tokenHeader, body: JSON.stringify({ slots }) });
      const spinnerHold = Math.max(0, 420 - (performance.now() - saveStartedAt));
      if (spinnerHold) await new Promise((resolve) => window.setTimeout(resolve, spinnerHold));
      savedSlotState = JSON.stringify(slots);
      slotSaving = false;
      updateSlotSaveState();
      clearSlotFeedback();
      slotSubmit.classList.add("is-saved");
      slotSubmit.dataset.state = "saved";
      slotSubmit.setAttribute("aria-label", "Saved");
      slotSavedTimer = window.setTimeout(() => {
        if (slotSubmit.dataset.state !== "saved") return;
        slotSubmit.dataset.state = "idle";
        slotSubmit.setAttribute("aria-label", "Save");
        slotSubmit.classList.remove("is-saved");
      }, 900);
    } catch (error) {
      slotSaving = false;
      slotSubmit.dataset.state = "error";
      slotSubmit.setAttribute("aria-label", "Save failed");
      slotSubmit.classList.remove("is-saved");
      slotSubmit.classList.add("is-error");
      setSlotFeedback(error.message);
      toast(error.message, "error");
      slotSavedTimer = window.setTimeout(() => {
        if (slotSubmit.dataset.state !== "error") return;
        slotSubmit.dataset.state = "idle";
        slotSubmit.setAttribute("aria-label", "Save");
        slotSubmit.classList.remove("is-error");
      }, 900);
    } finally {
      slotSaving = false;
      updateSlotSaveState();
    }
  });

  const managerList = document.getElementById("manage-library-list");
  const managerSearch = document.getElementById("library-manager-search");
  const managerCount = document.getElementById("managed-library-count");
  const libraryFeedback = document.getElementById("library-feedback");
  const emptyLibraryMessage = document.getElementById("empty-library-message");
  function filterManagedLibrary() {
    if (!managerList || !managerSearch) return;
    const query = managerSearch.value.trim().toLocaleLowerCase();
    managerList.querySelectorAll(".manage-meal-row").forEach((row) => {
      row.hidden = !row.dataset.mealName.toLocaleLowerCase().includes(query);
    });
  }
  if (managerSearch) managerSearch.addEventListener("input", filterManagedLibrary);
  if (managerList) managerList.querySelectorAll(".manage-remove-meal").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest(".manage-meal-row");
      if (!row || !window.confirm(`Remove “${row.dataset.mealName}” from the reusable library? Any meals already planned in Todoist will stay unchanged.`)) return;
      button.disabled = true;
      try {
        await api(`/api/library/${encodeURIComponent(row.dataset.mealId)}`, {
          method: "DELETE", headers: { "X-CSRF-Token": csrf },
        });
        row.classList.add("library-row-removing");
        window.setTimeout(() => row.remove(), 180);
        const remaining = managerList.querySelectorAll(".manage-meal-row:not(.library-row-removing)").length;
        if (managerCount) managerCount.textContent = String(Math.max(0, remaining));
        if (remaining <= 0 && emptyLibraryMessage) emptyLibraryMessage.hidden = false;
        if (libraryFeedback) libraryFeedback.textContent = `Removed ${row.dataset.mealName} from the library. Planned meals are unchanged.`;
      } catch (error) {
        button.disabled = false;
        if (libraryFeedback) libraryFeedback.textContent = error.message;
        toast(error.message, "error");
      }
    });
  });

  const themeToggle = document.querySelector(".theme-toggle");
  const themeLightMeta = document.getElementById("theme-color-light");
  const themeDarkMeta = document.getElementById("theme-color-dark");
  const themeFeedback = document.getElementById("theme-feedback");
  const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  const themeOptions = [...document.querySelectorAll("input[name='theme-mode']")];
  let themeMode = document.documentElement.dataset.themeMode || body.dataset.themeMode || "system";
  function effectiveTheme(mode) {
    return mode === "system" ? (themeMedia.matches ? "dark" : "light") : mode;
  }
  function applyTheme(mode) {
    themeMode = mode;
    document.documentElement.dataset.themeMode = mode;
    body.dataset.themeMode = mode;
    if (mode === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = mode;
    const effective = effectiveTheme(mode);
    if (themeLightMeta) themeLightMeta.media = effective === "light" ? "all" : "not all";
    if (themeDarkMeta) themeDarkMeta.media = effective === "dark" ? "all" : "not all";
    const nextTheme = effective === "dark" ? "light" : "dark";
    if (themeToggle) {
      themeToggle.innerHTML = iconMarkup(effective === "dark" ? "sun" : "moon");
      themeToggle.setAttribute("aria-label", `Switch to ${nextTheme} mode`);
      themeToggle.title = `Switch to ${nextTheme} mode`;
    }
    themeOptions.forEach((option) => { option.checked = option.value === mode; });
  }
  async function persistThemeMode(mode) {
    const result = await api("/api/settings/theme", {
      method: "POST", headers: tokenHeader, body: JSON.stringify({ mode }),
    });
    applyTheme(result.theme_mode);
  }
  applyTheme(themeMode);
  if (themeToggle) themeToggle.addEventListener("click", async () => {
    const nextTheme = effectiveTheme(themeMode) === "dark" ? "light" : "dark";
    themeToggle.classList.remove("theme-pop");
    void themeToggle.offsetWidth;
    themeToggle.classList.add("theme-pop");
    themeToggle.disabled = true;
    try {
      await persistThemeMode(nextTheme);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      themeToggle.disabled = false;
    }
  });
  themeOptions.forEach((option) => option.addEventListener("change", async () => {
    if (!option.checked) return;
    themeOptions.forEach((input) => { input.disabled = true; });
    try {
      await persistThemeMode(option.value);
      if (themeFeedback) themeFeedback.textContent = option.value === "system" ? "Using your system appearance." : `Appearance set to ${option.value}.`;
    } catch (error) {
      if (themeFeedback) themeFeedback.textContent = error.message;
      toast(error.message, "error");
    } finally {
      themeOptions.forEach((input) => { input.disabled = false; });
    }
  }));
  themeMedia.addEventListener?.("change", () => {
    if (themeMode === "system") applyTheme("system");
  });
})();
