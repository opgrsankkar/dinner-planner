import type { Slot } from "./types";

export const validSlotTime = (time: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time);

// Native time inputs report an empty value during partial edits. Keep every row
// in place until all times are complete. Stable sort retains equal-time order.
export function sortSlotsByTime<T extends Slot>(slots: T[]): T[] {
  if (!slots.every(slot => validSlotTime(slot.time))) return slots;
  return [...slots].sort((a, b) => a.time.localeCompare(b.time));
}
