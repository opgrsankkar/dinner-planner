// Display-only scaling. Never infer people from a yield such as "3 large rolls".
export function sourceServings(value: string): number | null {
  if (!/^\s*\d+(?:\.\d+)?\s*$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

const fractions: Record<string, number> = {
  "¼": 1 / 4, "½": 1 / 2, "¾": 3 / 4, "⅐": 1 / 7, "⅑": 1 / 9, "⅒": 1 / 10,
  "⅓": 1 / 3, "⅔": 2 / 3, "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5, "⅘": 4 / 5,
  "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8,
};
const glyphs = Object.keys(fractions).join("");
const quantity = `(?:\\d+\\s+\\d+\\s*[/⁄]\\s*\\d+|\\d*\\s*[${glyphs}]|\\d+\\s*[/⁄]\\s*\\d+|(?:\\d+(?:\\.\\d+)?|\\.\\d+))`;
const leadingQuantity = new RegExp(`^(\\s*)(${quantity})(?:(\\s*(?:–|—|-|to)\\s*)(${quantity}))?(.*)$`, "u");

function parseQuantity(text: string): number {
  const value = text.trim();
  const glyph = value.at(-1)!;
  if (glyph in fractions) return Number(value.slice(0, -1).trim() || 0) + fractions[glyph]!;
  if (/[\/⁄]/.test(value)) {
    // Normalise spaces around the fraction slash before reading mixed numbers.
    const match = /^(?:(\d+)\s+)?(\d+)\s*[/⁄]\s*(\d+)$/.exec(value);
    if (!match || Number(match[3]) === 0) return NaN;
    return Number(match[1] || 0) + Number(match[2]) / Number(match[3]);
  }
  return Number(value);
}

function formatQuantity(value: number): string {
  const whole = Math.floor(value);
  for (const denominator of [1, 2, 3, 4, 5, 6, 8, 10, 12, 16]) {
    const numerator = Math.round((value - whole) * denominator);
    if (Math.abs(value - (whole + numerator / denominator)) < 1e-8) {
      if (!numerator) return String(whole);
      return `${whole ? `${whole} ` : ""}${numerator}/${denominator}`;
    }
  }
  return String(Number(value.toPrecision(4)));
}

export function scaleAmount(amount: string, source: number | null, target: number): string {
  if (!source || !Number.isFinite(source) || source <= 0 || !Number.isFinite(target) || target <= 0 || source === target) return amount;
  const match = leadingQuantity.exec(amount);
  if (!match) return amount;
  const [, space, first, separator, second, suffix = ""] = match;
  // Reject incomplete numeric syntax, dimensions and pack multipliers. Only the
  // leading quantity changes; unit text, package sizes and notes remain literal.
  if (/^\s*[\d.%°/⁄¼-¾⅐-⅞–—-]/u.test(suffix) || /^\s*(?:[x×*]|to\b)/iu.test(suffix)) return amount;
  const values = [parseQuantity(first!), ...(second ? [parseQuantity(second)] : [])];
  if (values.some(value => !Number.isFinite(value) || value < 0)) return amount;
  const scaled = values.map(value => value * target / source);
  if (scaled.some(value => !Number.isFinite(value))) return amount;
  return `${space}${formatQuantity(scaled[0]!)}${second ? `${separator}${formatQuantity(scaled[1]!)}` : ""}${suffix}`;
}
