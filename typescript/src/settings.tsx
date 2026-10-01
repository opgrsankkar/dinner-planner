import { useEffect, useState } from "react";
import type { Board } from "./types";
import { AppearanceSettings } from "./settings/AppearanceSettings";
import { MealLibrarySettings } from "./settings/MealLibrarySettings";
import { MealSlotSettings } from "./settings/MealSlotSettings";

// The shell owns page behavior, shared mutation feedback, and future navigation.
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
  const [feedback, setFeedback] = useState("");
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
      <AppearanceSettings
        theme={board.settings.theme}
        onThemeChange={(theme) => action("/api/settings/theme", { theme })}
      />
      <MealLibrarySettings
        library={board.library}
        action={action}
      />
      <MealSlotSettings
        initialSlots={board.slots}
        initialRevision={board.settings.revision}
        post={post}
        refresh={refresh}
        setFeedback={setFeedback}
      />
      <p className="settings-feedback" role={feedback ? "alert" : "status"}>
        {feedback}
      </p>
    </main>
  );
}
