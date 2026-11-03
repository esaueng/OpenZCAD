import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useCommandFold } from './useCommandFold';
import type { WorkspaceMode } from '../lib/panelState';

interface Props {
  commandFoldOpen: boolean;
  sketching: boolean;
  editing?: boolean;
  sessionId?: string;
  workspaceMode?: WorkspaceMode;
}

const IDLE: Props = { commandFoldOpen: true, sketching: false };

function renderFold(initialProps: Props = IDLE) {
  return renderHook(
    ({ commandFoldOpen, ...mode }: Props) =>
      useCommandFold({ commandFoldOpen }, mode),
    { initialProps }
  );
}

describe('useCommandFold', () => {
  it.each(['view', 'tweak', 'drawing'] as const)(
    'ignores stale editing state in %s',
    (workspaceMode) => {
      const { result, rerender } = renderFold({
        ...IDLE,
        editing: true,
        workspaceMode
      });
      expect(result.current.commandFoldOpen).toBe(true);
      expect(result.current.foldHidden).toBe(false);
      rerender({ ...IDLE, editing: true, workspaceMode: 'build' });
      expect(result.current.commandFoldOpen).toBe(false);
      expect(result.current.foldHidden).toBe(true);
    }
  );

  it('keeps a request through updates and folds again on every new session', () => {
    const { result, rerender } = renderFold({
      ...IDLE,
      editing: true,
      sessionId: 'hole'
    });
    for (const next of [
      { ...IDLE, sketching: true, sessionId: 'sketch' },
      { ...IDLE, editing: true, sessionId: 'fillet' },
      { ...IDLE, editing: true, sessionId: 'chamfer' }
    ]) {
      act(() => result.current.release());
      expect(result.current.commandFoldOpen).toBe(true);
      rerender(next);
      expect(result.current.commandFoldOpen).toBe(false);
      act(() => result.current.release());
      rerender({ ...next });
      expect(result.current.commandFoldOpen).toBe(true);
    }
  });

  it('honors an explicit fold request batched with a new command', () => {
    const { result, rerender } = renderFold({
      ...IDLE,
      editing: true,
      sessionId: 'first'
    });
    act(() => result.current.release());
    act(() => {
      result.current.release();
      rerender({ ...IDLE, editing: true, sessionId: 'second' });
    });
    expect(result.current.commandFoldOpen).toBe(true);
    rerender({ ...IDLE, editing: true, sessionId: 'third' });
    expect(result.current.commandFoldOpen).toBe(false);
  });

  it('restores the saved fold after a sketch or creation ends', () => {
    const { result, rerender } = renderFold();
    for (const active of [
      { ...IDLE, sketching: true },
      { ...IDLE, editing: true }
    ]) {
      rerender(active);
      expect(result.current.commandFoldOpen).toBe(false);
      rerender(IDLE);
      expect(result.current.commandFoldOpen).toBe(true);
    }
  });

  it('never opens a fold the user left closed', () => {
    const { result, rerender } = renderFold({
      ...IDLE,
      commandFoldOpen: false
    });
    rerender({ ...IDLE, commandFoldOpen: false, sketching: true });
    act(() => result.current.release());
    expect(result.current.commandFoldOpen).toBe(false);
    rerender({ ...IDLE, commandFoldOpen: false });
    expect(result.current.commandFoldOpen).toBe(false);
  });
});
