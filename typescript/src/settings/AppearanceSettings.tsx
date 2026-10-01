import type { Settings } from "../types";

export interface AppearanceSettingsProps {
  theme: Settings["theme"];
  onThemeChange: (theme: Settings["theme"]) => Promise<void>;
}

export function AppearanceSettings({ theme: selectedTheme, onThemeChange }: AppearanceSettingsProps) {
  return (
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
                checked={selectedTheme === theme}
                onChange={() => void onThemeChange(theme)}
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
  );
}
