import { describe, expect, it } from 'vitest';
import type { WorkspaceMode } from './panelState';
import { nextWorkspaceMode } from './topBarPresentation';

describe('nextWorkspaceMode (I21)', () => {
  const open = () => null;

  it('steps through all five modes, wrapping round', () => {
    expect(nextWorkspaceMode('view', open)).toBe('tweak');
    expect(nextWorkspaceMode('tweak', open)).toBe('build');
    expect(nextWorkspaceMode('build', open)).toBe('assemble');
    expect(nextWorkspaceMode('assemble', open)).toBe('drawing');
    expect(nextWorkspaceMode('drawing', open)).toBe('view');
  });

  it('skips locked modes, and has nowhere to go when every other is locked', () => {
    const locked = (modes: WorkspaceMode[]) => (mode: WorkspaceMode) =>
      modes.includes(mode) ? 'Locked' : null;
    expect(nextWorkspaceMode('view', locked(['tweak', 'build']))).toBe(
      'assemble'
    );
    expect(
      nextWorkspaceMode(
        'view',
        locked(['tweak', 'build', 'assemble', 'drawing'])
      )
    ).toBeNull();
  });
});
