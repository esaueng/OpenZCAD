import type { InteractionState } from './interaction/machine';

export function isExtrudeSessionCurrent(
  started: Extract<InteractionState, { mode: 'region' }>,
  current: InteractionState,
  selected: readonly unknown[],
  currentSelected: readonly unknown[]
): boolean {
  return (
    current.mode === 'region' &&
    current.target === started.target &&
    current.extrudeChoice === started.extrudeChoice &&
    selected === currentSelected
  );
}
