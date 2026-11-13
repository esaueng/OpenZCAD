import type { InPlaceCommand } from '../../hooks/useInPlaceCommand';

/**
 * A command chip's keypad canceled (Escape, or its Cancel): the value goes
 * back to what the chip showed when it was tapped, set or unset as it was,
 * and an entry of it refused before (the chip reopened on a refused 13)
 * is given up with it, so Done no longer waits on it. Only this path drops
 * the refusal: a refused commit also restores the baseline, but its
 * refusal must stand.
 */
export function cancelCommandChipEntry(
  command: Pick<InPlaceCommand, 'restoreValue' | 'dropRefusal'>,
  valueId: string,
  baseline: number,
  baselineRaw: string | undefined,
  wasTouched: boolean
): void {
  command.restoreValue(valueId, baseline, baselineRaw, wasTouched);
  command.dropRefusal(valueId);
}
