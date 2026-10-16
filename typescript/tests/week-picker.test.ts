import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WeekPicker } from "../src/WeekPicker";
import { weekStart } from "../src/week-calendar";

function render(props: { week: string; today: string; isCurrent: boolean }) {
  return renderToStaticMarkup(createElement(WeekPicker, {
    ...props, label: "12 Oct – 18 Oct", onSelect: () => {},
  }));
}
function currentWeekRows(markup: string) {
  return markup.match(/data-current-week="true"/g)?.length ?? 0;
}
function row(markup: string, start: string) {
  const match = markup.match(new RegExp(`<button[^>]*data-week="${start}"[^>]*>`));
  assert.ok(match, `row ${start} present`);
  return match[0];
}

test("current week row is marked even when a different week is selected", () => {
  const markup = render({ week: "2026-09-28", today: "2026-10-16", isCurrent: false });
  assert.equal(currentWeekRows(markup), 1);
  const current = row(markup, "2026-10-12");
  assert.ok(current.includes('data-current-week="true"'), "today's week row carries the current marker");
  assert.ok(current.includes('aria-current="date"'), "current week is exposed via aria-current");
  assert.ok(current.includes('aria-pressed="false"'), "current row is not the selected row");
  assert.ok(markup.includes("Week Oct 12, 2026 to Oct 18, 2026, current week"), "current row is announced to assistive tech");
  const selected = row(markup, "2026-09-28");
  assert.ok(selected.includes('aria-pressed="true"'), "selected week keeps its own distinction");
  assert.ok(!selected.includes("data-current-week"), "selected week is not mislabelled current");
  assert.ok(!selected.includes("aria-current"), "selected week is not exposed as aria-current");
  assert.ok(markup.includes("week-picker-row is-current-week"), "current row keeps its row class");
  assert.ok(markup.includes('class="week-picker-current-star" aria-hidden="true"'), "current row shows a visible star marker");
  assert.ok(!markup.includes("(current)"), "trigger does not claim current when another week is selected");
  assert.ok(!markup.includes("current week, choose week"), "trigger stays silent about current when another week is selected");
});

test("current week across a year boundary is identified on the shared week row", () => {
  assert.equal(weekStart("2026-01-01"), "2025-12-29");
  const markup = render({ week: "2026-01-05", today: "2026-01-01", isCurrent: false });
  assert.equal(currentWeekRows(markup), 1);
  assert.ok(row(markup, "2025-12-29").includes('data-current-week="true"'), "boundary week start (previous year) is marked current");
  assert.ok(row(markup, "2026-01-05").includes('aria-pressed="true"'), "selected new-year week remains the selected one");
});

test("selecting the current week keeps the distinction: selected plus current", () => {
  const markup = render({ week: "2026-10-12", today: "2026-10-16", isCurrent: true });
  assert.equal(currentWeekRows(markup), 1);
  const current = row(markup, "2026-10-12");
  assert.ok(current.includes('data-current-week="true"'));
  assert.ok(current.includes('aria-current="date"'), "aria-current survives when the week is also selected");
  assert.ok(current.includes('aria-pressed="true"'), "same row can be both selected and current");
  assert.ok(markup.includes("(current)"), "trigger keeps its current-week marker");
  assert.ok(markup.includes('aria-label="12 Oct – 18 Oct, current week, choose week"'), "trigger announces current for assistive tech");
});
