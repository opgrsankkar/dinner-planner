export function RecipeIcon({ name }: { name: string }) {
  return (
    <svg className="ui-icon" aria-hidden="true">
      <use href={`/static/lucide-icons.svg#${name}`} />
    </svg>
  );
}
