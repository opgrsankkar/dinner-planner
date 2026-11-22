import { sourceServings } from "./servings";

export function ServingsControl({ source, target, onChange }: {
  source: string;
  target: number;
  onChange: (target: number) => void;
}) {
  const available = sourceServings(source) !== null;
  return (
    <div className="recipe-servings">
      <div className="recipe-servings-stepper" role="group" aria-label="Servings">
        <span>Servings</span>
        <button type="button" aria-label="Fewer servings" disabled={!available || target <= 1} onClick={() => onChange(target - 1)}>−</button>
        <output aria-live="polite" aria-label="Target servings">{target}</output>
        <button type="button" aria-label="More servings" disabled={!available || target >= 99} onClick={() => onChange(target + 1)}>+</button>
      </div>
      {!available && <span className="recipe-servings-unavailable">{source ? `Source yield: ${source}` : "Source servings unknown"} · quantities unchanged</span>}
    </div>
  );
}
