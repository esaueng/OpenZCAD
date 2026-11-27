import type { InPlaceSlots } from './tools';

/** A slot of a running command, by name. */
export type InPlaceSlotName = keyof InPlaceSlots;

/** How many picks each filled slot holds: a list's length, or one. */
export type SlotPickCounts = Partial<Record<InPlaceSlotName, number>>;

/** The picks in each slot that holds any. */
export function slotPickCounts(slots: InPlaceSlots): SlotPickCounts {
  const counts: SlotPickCounts = {};
  for (const name of Object.keys(slots) as InPlaceSlotName[]) {
    const slot = slots[name];
    const count = Array.isArray(slot) ? slot.length : slot != null ? 1 : 0;
    if (count > 0) counts[name] = count;
  }
  return counts;
}

/**
 * What an entry of `valueId` opening now is over: the picks in each slot,
 * when the value has a chip in the viewport; nothing for a value without
 * one, whose entry has no chip to lose (a Box's Width before its footprint,
 * a Hole's Precise values before its face).
 */
export function chipEntryOpenedOver(
  slots: InPlaceSlots,
  handles: readonly { valueId: string }[],
  valueId: string
): SlotPickCounts {
  return handles.some((handle) => handle.valueId === valueId)
    ? slotPickCounts(slots)
    : {};
}

/**
 * Whether a command value's entry (its viewport chip's editor and keypad)
 * has lost what it edits: picks it was opened over were taken back, and the
 * value has no chip left. Align's Offset sits on the face pair; a click on
 * the moving face in the preview takes the pair back, the Offset chip goes
 * with it, and the entry has nothing left to edit, so it closes as if
 * canceled. So does one whose target face alone was taken back.
 *
 * Both halves are needed, so nothing else closes an entry:
 * - An entry opened without a chip, or before any pick, is over no picks
 *   (`chipEntryOpenedOver`).
 * - A pick replaced (a new target face) or added keeps every slot's count.
 * - A chip briefly gone while a preview builds keeps every pick.
 * - A pick taken back while the value keeps its chip leaves it something
 *   to edit.
 */
export function chipEntryLostItsPicks(
  openedOver: SlotPickCounts,
  slots: InPlaceSlots,
  handles: readonly { valueId: string }[],
  valueId: string
): boolean {
  if (handles.some((handle) => handle.valueId === valueId)) return false;
  const now = slotPickCounts(slots);
  return (Object.keys(openedOver) as InPlaceSlotName[]).some(
    (name) => (now[name] ?? 0) < (openedOver[name] ?? 0)
  );
}
