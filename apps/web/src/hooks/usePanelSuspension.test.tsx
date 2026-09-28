import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePanelSuspension } from './usePanelSuspension';

interface Props {
  drawerOpen: boolean;
  commandFoldOpen: boolean;
  sketching: boolean;
  phase: string | null;
  pointerDown?: boolean;
}

const IDLE: Props = {
  drawerOpen: true,
  commandFoldOpen: true,
  sketching: false,
  phase: null
};

function renderSuspension(initialProps: Props = IDLE) {
  return renderHook(
    ({ drawerOpen, commandFoldOpen, sketching, phase, pointerDown }: Props) =>
      usePanelSuspension(
        { drawerOpen, commandFoldOpen },
        { sketching, phase, pointerDown }
      ),
    { initialProps }
  );
}

describe('usePanelSuspension', () => {
  it('steps the panels aside for a sketch and brings them back after', () => {
    const { result, rerender } = renderSuspension();
    expect(result.current.drawerOpen).toBe(true);
    expect(result.current.commandFoldOpen).toBe(true);

    rerender({ ...IDLE, sketching: true });
    expect(result.current.drawerOpen).toBe(false);
    expect(result.current.commandFoldOpen).toBe(false);
    expect(result.current.drawerHidden).toBe(true);

    rerender(IDLE);
    expect(result.current.drawerOpen).toBe(true);
    expect(result.current.commandFoldOpen).toBe(true);
    expect(result.current.drawerHidden).toBe(false);
  });

  it('holds a drag from engage through validation, then restores', () => {
    const { result, rerender } = renderSuspension({ ...IDLE, phase: 'armed' });
    expect(result.current.drawerOpen).toBe(true);

    rerender({ ...IDLE, phase: 'dragging' });
    // Hidden on the very render the drag engages, not one frame later.
    expect(result.current.drawerOpen).toBe(false);
    expect(result.current.commandFoldOpen).toBe(false);

    rerender({ ...IDLE, phase: 'validating' });
    expect(result.current.drawerOpen).toBe(false);

    // The commit landed and the selection cleared.
    rerender(IDLE);
    expect(result.current.drawerOpen).toBe(true);
    expect(result.current.commandFoldOpen).toBe(true);
  });

  it('restores after a refused drag as well', () => {
    const { result, rerender } = renderSuspension({
      ...IDLE,
      phase: 'dragging'
    });
    expect(result.current.drawerOpen).toBe(false);
    rerender({ ...IDLE, phase: 'validating' });
    rerender({ ...IDLE, phase: 'failed' });
    expect(result.current.drawerOpen).toBe(true);
  });

  it('does not bring the drawer back for a value refused mid-drag', () => {
    const { result, rerender } = renderSuspension({
      ...IDLE,
      phase: 'dragging',
      pointerDown: true
    });
    rerender({ ...IDLE, phase: 'failed', pointerDown: true });
    expect(result.current.drawerOpen).toBe(false);
    rerender({ ...IDLE, phase: 'dragging', pointerDown: true });
    expect(result.current.drawerOpen).toBe(false);
    rerender({ ...IDLE, phase: 'armed', pointerDown: false });
    expect(result.current.drawerOpen).toBe(true);
  });

  it('keeps a panel the user asks for, for the rest of that mode only', () => {
    const { result, rerender } = renderSuspension({ ...IDLE, sketching: true });
    expect(result.current.drawerOpen).toBe(false);

    act(() => result.current.release('drawer'));
    expect(result.current.drawerOpen).toBe(true);
    expect(result.current.drawerHidden).toBe(false);
    // Releasing the drawer leaves the fold suspended.
    expect(result.current.commandFoldOpen).toBe(false);

    rerender(IDLE);
    expect(result.current.drawerOpen).toBe(true);

    // The next sketch suspends again: a release is not a new preference.
    rerender({ ...IDLE, sketching: true });
    expect(result.current.drawerOpen).toBe(false);
  });

  it('never opens a panel the user left closed', () => {
    const { result, rerender } = renderSuspension({
      ...IDLE,
      drawerOpen: false,
      commandFoldOpen: false
    });
    rerender({
      ...IDLE,
      drawerOpen: false,
      commandFoldOpen: false,
      sketching: true
    });
    rerender({ ...IDLE, drawerOpen: false, commandFoldOpen: false });
    expect(result.current.drawerOpen).toBe(false);
    expect(result.current.commandFoldOpen).toBe(false);
  });
});
