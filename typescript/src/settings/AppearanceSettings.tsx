import type { Settings } from "../types";

export interface AppearanceSettingsProps {
  theme: Settings["theme"];
  onThemeChange: (theme: Settings["theme"]) => Promise<void>;
}

export function AppearanceSettings({ theme: selectedTheme, onThemeChange }: AppearanceSettingsProps) {
  return (
    <section className="settings-section folio-appearance">
      <div className="settings-section-heading"><h2>Appearance</h2></div>
      <div className="folio-appearance-row">
        <span className="folio-field-label">Color preference</span>
        <fieldset className="theme-options">
          <legend className="visually-hidden">Color theme</legend>
          {(["light", "dark", "system"] as const).map((theme) => (
            <label className="theme-option" key={theme}>
              <input
                type="radio"
                name="theme"
                checked={selectedTheme === theme}
                onChange={() => void onThemeChange(theme)}
              />
              <span><strong>{theme[0].toUpperCase() + theme.slice(1)}</strong></span>
            </label>
          ))}
        </fieldset>
      </div>
    </section>
  );
}
