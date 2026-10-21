import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePanelSuspension } from './usePanelSuspension';

interface Props {
  commandFoldOpen: boolean;
  sketching: boolean;
  phase: string | null;
  pointerDown?: boolean;
}

const IDLE: Props = {
  commandFoldOpen: true,
  sketching: false,
  phase: null
};

function renderSuspension(initialProps: Props = IDLE) {
  return renderHook(
    ({ commandFoldOpen, sketching, phase, pointerDown }: Props) =>
      usePanelSuspension(
        { commandFoldOpen },
        { sketching, phase, pointerDown }
      ),
    { initialProps }
  );
}

describe('usePanelSuspension', () => {
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

  it('holds a drag from engage through validation, then restores', () => {
    const { result, rerender } = renderSuspension({ ...IDLE, phase: 'armed' });
    expect(result.current.panelsHidden).toBe(false);

    rerender({ ...IDLE, phase: 'dragging' });
    // Hidden on the very render the drag engages, not one frame later.
    expect(result.current.panelsHidden).toBe(true);
    expect(result.current.commandFoldOpen).toBe(false);

    rerender({ ...IDLE, phase: 'validating' });
    expect(result.current.panelsHidden).toBe(true);

    // The commit landed and the selection cleared.
    rerender(IDLE);
    expect(result.current.panelsHidden).toBe(false);
    expect(result.current.commandFoldOpen).toBe(true);
  });

  it('restores after a refused drag as well', () => {
    const { result, rerender } = renderSuspension({
      ...IDLE,
      phase: 'dragging'
    });
    expect(result.current.panelsHidden).toBe(true);
    rerender({ ...IDLE, phase: 'validating' });
    rerender({ ...IDLE, phase: 'failed' });
    expect(result.current.panelsHidden).toBe(false);
  });

  it('does not bring the panels back for a value refused mid-drag', () => {
    const { result, rerender } = renderSuspension({
      ...IDLE,
      phase: 'dragging',
      pointerDown: true
    });
    rerender({ ...IDLE, phase: 'failed', pointerDown: true });
    expect(result.current.panelsHidden).toBe(true);
    rerender({ ...IDLE, phase: 'dragging', pointerDown: true });
    expect(result.current.panelsHidden).toBe(true);
    rerender({ ...IDLE, phase: 'armed', pointerDown: false });
    expect(result.current.panelsHidden).toBe(false);
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
