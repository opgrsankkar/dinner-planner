import { useEffect, useRef, useState } from "react";
import type { Board } from "./types";
import { AppearanceSettings } from "./settings/AppearanceSettings";
import { MealLibrarySettings } from "./settings/MealLibrarySettings";
import { MealSlotSettings } from "./settings/MealSlotSettings";

const sections = [
  { id: "appearance", label: "Appearance" },
  { id: "library", label: "Meal library" },
  { id: "slots", label: "Meal slots" },
  { id: "calendar", label: "Calendar" },
] as const;
type Section = (typeof sections)[number]["id"];

// The shell owns page behavior, shared mutation feedback, and navigation.
// Section modules own their local interaction state.
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
  const [selected, setSelected] = useState<Section | null>(null);
  const [mobile, setMobile] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const query = matchMedia("(max-width: 700px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const active = selected ?? (mobile ? null : "appearance");
  function openSection(section: Section) {
    setSelected(section);
    requestAnimationFrame(() => panel.current?.focus());
  }
  function backToSettings() {
    const previous = selected;
    setSelected(null);
    requestAnimationFrame(() => navigation.current
      ?.querySelector<HTMLButtonElement>(`[data-section="${previous}"]`)?.focus());
  }
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState("");
  async function action(path: string, body: unknown): Promise<boolean> {
    try {
      await post(path, body);
      await refresh();
      setFeedback("");
      return true;
    } catch (error) {
      setFeedback((error as Error).message);
      return false;
    }
  }
  return (
    <main className="settings-shell">
      <h1 className="settings-menu-title">Settings</h1>
      <div className={`settings-layout${active ? " has-active-section" : ""}`}>
        <nav className="settings-nav" aria-label="Settings sections" ref={navigation}>
          <span className="folio-nav-dots" aria-hidden="true"><i /><i /><i /><i /><i /><i /></span>
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              data-section={section.id}
              aria-label={section.label}
              aria-current={active === section.id ? "page" : undefined}
              aria-controls={`settings-panel-${section.id}`}
              onClick={() => openSection(section.id)}
            >
              <span><strong>{section.label}</strong></span>
              <span className="settings-nav-chevron" aria-hidden="true">›</span>
            </button>
          ))}
        </nav>
        <div
          className="settings-panels"
          hidden={active === null}
          role="region"
          aria-label={sections.find((section) => section.id === active)?.label}
          tabIndex={-1}
          ref={panel}
        >
          <button className="settings-back secondary-button" type="button" onClick={backToSettings}>
            ← Back to settings
          </button>
          <div id="settings-panel-appearance" hidden={active !== "appearance"}>
            <AppearanceSettings
              theme={board.settings.theme}
              onThemeChange={async (theme) => { await action("/api/settings/theme", { theme }); }}
            />
          </div>
          <div id="settings-panel-library" hidden={active !== "library"}>
            <div className="folio-section-heading"><h2>Meal library</h2><span aria-hidden="true">✦</span></div>
            <MealLibrarySettings library={board.library} action={action} />
          </div>
          <div id="settings-panel-slots" hidden={active !== "slots"}>
            <MealSlotSettings
              active={active === "slots"}
              initialSlots={board.slots}
              initialRevision={board.settings.revision}
              post={post}
              refresh={refresh}
              setFeedback={setFeedback}
            />
          </div>
          <div id="settings-panel-calendar" className="folio-calendar" hidden={active !== "calendar"}>
            <div className="folio-section-heading"><h2>Calendar</h2></div>
            {board.calendarUrl ? (
              <>
                <p>Subscribe to your meal plan in Google Calendar (Other calendars → From URL) or on iPhone (Settings → Calendar → Accounts → Add Subscribed Calendar). It refreshes about hourly.</p>
                <div className="folio-calendar-link">
                  <input readOnly aria-label="Calendar subscription link" value={board.calendarUrl} onFocus={(event) => event.currentTarget.select()} />
                  <button className="secondary-button folio-copy-button" type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(board.calendarUrl!);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      } catch {
                        setFeedback("Copy failed. Select the link and copy it manually.");
                      }
                    }}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="folio-calendar-note">Anyone with this link can see your meals, so keep it to yourself.</p>
              </>
            ) : (
              <p>The calendar feed is off.</p>
            )}
          </div>
        </div>
      </div>
      <p className="settings-feedback" role={feedback ? "alert" : "status"}>
        {feedback}
      </p>
    </main>
  );
}
