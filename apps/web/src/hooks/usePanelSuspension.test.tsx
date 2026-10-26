import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePanelSuspension } from './usePanelSuspension';
import type { WorkspaceMode } from '../lib/panelState';

interface Props {
  commandFoldOpen: boolean;
  sketching: boolean;
  editing?: boolean;
  sessionId?: string;
  workspaceMode?: WorkspaceMode;
}

const IDLE: Props = {
  commandFoldOpen: true,
  sketching: false
};

function renderSuspension(initialProps: Props = IDLE) {
  return renderHook(
    ({
      commandFoldOpen,
      sketching,
      editing,
      sessionId,
      workspaceMode
    }: Props) =>
      usePanelSuspension(
        { commandFoldOpen },
        { sketching, editing, sessionId, workspaceMode }
      ),
    { initialProps }
  );
}

describe('usePanelSuspension', () => {
  it.each(['view', 'tweak', 'drawing'] as const)(
    'keeps panels visible when the resolved mode is %s and editing state is stale',
    (workspaceMode) => {
      const { result, rerender } = renderSuspension({
        ...IDLE,
        editing: true,
        workspaceMode,
        sessionId: 'selected-feature'
      });
      expect(result.current.panelsHidden).toBe(false);
      expect(result.current.foldHidden).toBe(false);
      expect(result.current.commandFoldOpen).toBe(true);
      rerender({
        ...IDLE,
        editing: true,
        workspaceMode: 'build',
        sessionId: 'selected-feature'
      });
      expect(result.current.panelsHidden).toBe(true);
    }
  );

  it('honors an explicit panel request batched with opening another form', () => {
    const { result, rerender } = renderSuspension({
      ...IDLE,
      editing: true,
      sessionId: 'first'
    });
    act(() => {
      result.current.release('panels');
      result.current.release('fold');
    });
    act(() => {
      result.current.release('panels');
      rerender({ ...IDLE, editing: true, sessionId: 'second' });
    });
    expect(result.current.panelsHidden).toBe(false);
    expect(result.current.foldHidden).toBe(true);
    rerender({ ...IDLE, editing: true, sessionId: 'third' });
    expect(result.current.panelsHidden).toBe(true);
  });
  it('resets a release when switching directly between suspended sessions', () => {
    const { result, rerender } = renderSuspension({
      ...IDLE,
      editing: true,
      sessionId: 'hole'
    });
    for (const next of [
      { ...IDLE, sketching: true, sessionId: 'sketch' },
      { ...IDLE, editing: true, sessionId: 'fillet' },
      { ...IDLE, editing: true, sessionId: 'chamfer' }
    ]) {
      act(() => {
        result.current.release('panels');
        result.current.release('fold');
      });
      expect(result.current.panelsHidden).toBe(false);
      expect(result.current.commandFoldOpen).toBe(true);
      rerender(next);
      expect(result.current.panelsHidden).toBe(true);
      expect(result.current.commandFoldOpen).toBe(false);
    }
  });
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
