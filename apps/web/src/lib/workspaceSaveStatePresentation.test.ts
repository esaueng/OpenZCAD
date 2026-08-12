import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_SAVE_STATE_PRESENTATION,
  presentedWorkspaceSaveState
} from './workspaceSaveStatePresentation';

describe('presentedWorkspaceSaveState', () => {
  it('never presents plain synced while a local-only source exists', () => {
    expect(presentedWorkspaceSaveState('synced', 1)).toBe('local-source');
    expect(presentedWorkspaceSaveState('synced', 3)).toBe('local-source');
  });

  it('presents synced once every source is archived', () => {
    expect(presentedWorkspaceSaveState('synced', 0)).toBe('synced');
  });

  it('leaves non-synced states alone — they already say work is pending', () => {
    for (const state of [
      'saving',
      'local',
      'syncing',
      'offline',
      'conflict',
      'repair',
      'refused',
      'paused'
    ] as const) {
      expect(presentedWorkspaceSaveState(state, 2)).toBe(state);
    }
  });

  it('has presentation copy for the local-source state', () => {
    const presentation = WORKSPACE_SAVE_STATE_PRESENTATION['local-source'];
    expect(presentation.statusBarLabel).toBe('Local source only');
    expect(presentation.title).toMatch(/only on this device/i);
  });

  it('does not describe an unreadable account project as local-only', () => {
    const presentation = WORKSPACE_SAVE_STATE_PRESENTATION.repair;
    expect(presentation.topBarLabel).toBe('Repair needed');
    expect(presentation.statusBarLabel).toBe('Account repair needed');
    expect(presentation.title).toMatch(/account copy cannot be opened/i);
    expect(presentation.title).toMatch(/saved on this device/i);
  });
});
