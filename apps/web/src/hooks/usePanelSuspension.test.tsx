import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePanelSuspension } from './usePanelSuspension';

interface Props {
  commandFoldOpen: boolean;
  sketching: boolean;
  editing?: boolean;
}

const IDLE: Props = {
  commandFoldOpen: true,
  sketching: false
};

function renderSuspension(initialProps: Props = IDLE) {
  return renderHook(
    ({ commandFoldOpen, sketching, editing }: Props) =>
      usePanelSuspension({ commandFoldOpen }, { sketching, editing }),
    { initialProps }
  );
}

describe('usePanelSuspension', () => {
  it('gives a feature form room without overwriting the saved layout', () => {
    const { result, rerender } = renderSuspension();
    rerender({ ...IDLE, editing: true });
    expect(result.current.panelsHidden).toBe(true);
    act(() => result.current.release('panels'));
    expect(result.current.panelsHidden).toBe(false);
    rerender(IDLE);
    rerender({ ...IDLE, editing: true });
    expect(result.current.panelsHidden).toBe(true);
    rerender(IDLE);
    expect(result.current.commandFoldOpen).toBe(true);
  });
  it('steps the panels aside for a sketch and brings them back after', () => {
    const { result, rerender } = renderSuspension();
    expect(result.current.panelsHidden).toBe(false);
    expect(result.current.commandFoldOpen).toBe(true);

    rerender({ ...IDLE, sketching: true });
    expect(result.current.panelsHidden).toBe(true);
    expect(result.current.commandFoldOpen).toBe(false);
    expect(result.current.foldHidden).toBe(true);

    rerender(IDLE);
    expect(result.current.panelsHidden).toBe(false);
    expect(result.current.commandFoldOpen).toBe(true);
    expect(result.current.foldHidden).toBe(false);
  });

  it('keeps the panels the user asks for, for the rest of that mode only', () => {
    const { result, rerender } = renderSuspension({ ...IDLE, sketching: true });
    expect(result.current.panelsHidden).toBe(true);

    act(() => result.current.release('panels'));
    expect(result.current.panelsHidden).toBe(false);
    // Releasing the panels leaves the fold suspended.
    expect(result.current.commandFoldOpen).toBe(false);
    expect(result.current.foldHidden).toBe(true);

    rerender(IDLE);
    expect(result.current.panelsHidden).toBe(false);

    // The next sketch suspends again: a release is not a new preference.
    rerender({ ...IDLE, sketching: true });
    expect(result.current.panelsHidden).toBe(true);
  });

  it('never opens a fold the user left closed', () => {
    const { result, rerender } = renderSuspension({
      ...IDLE,
      commandFoldOpen: false
    });
    rerender({ ...IDLE, commandFoldOpen: false, sketching: true });
    act(() => result.current.release('fold'));
    rerender({ ...IDLE, commandFoldOpen: false });
    expect(result.current.commandFoldOpen).toBe(false);
  });
});
