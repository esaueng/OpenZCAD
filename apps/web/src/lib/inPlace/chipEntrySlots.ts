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
 * has lost what it edits: every pick it was opened over has been taken
 * back, so the command is asking for its first pick again, and the value
 * has no chip left. Align's Offset sits on the face pair; a click on the
 * moving face in the preview takes the pair back, the Offset chip goes with
 * it, and the entry has nothing left to edit, so it closes as if canceled.
 *
 * Nothing short of that closes an entry, so a draft typed into it is never
 * lost to a pick that only changes:
 * - An entry opened without a chip, or before any pick, is over no picks
 *   (`chipEntryOpenedOver`).
 * - A pick replaced keeps its draft even when the chip is gone meanwhile:
 *   a Circular Pattern's new source body clears its axis, and the Count
 *   chip comes back once the axis is picked again.
 * - Some picks taken back, others kept (Align's target alone), leave the
 *   command partway, not at its start.
 * - A chip briefly gone while a preview builds keeps every pick.
 */
export function chipEntryLostItsPicks(
  openedOver: SlotPickCounts,
  slots: InPlaceSlots,
  handles: readonly { valueId: string }[],
  valueId: string
): boolean {
  if (handles.some((handle) => handle.valueId === valueId)) return false;
  const opened = Object.keys(openedOver) as InPlaceSlotName[];
  if (opened.length === 0) return false;
  const now = slotPickCounts(slots);
  return opened.every((name) => (now[name] ?? 0) === 0);
}
