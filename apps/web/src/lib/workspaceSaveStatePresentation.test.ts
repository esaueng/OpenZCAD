import { describe, expect, it } from 'vitest';
import { saveGlyphFor } from './topBarPresentation';
import {
  createProjectDocument,
  createSavedRevision
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { ApiError } from './api';
import {
  CheckpointSaveError,
  failedCheckpointSaveState
} from './collaborationCheckpointFallback';
import {
  WORKSPACE_SAVE_STATE_PRESENTATION,
  autosaveReportedSaveState,
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
    expect(presentation.title).toMatch(/restore it from this device/i);
  });
});

it('warns about the named revision without claiming the live head is lost or stored', () => {
  const room = WORKSPACE_SAVE_STATE_PRESENTATION['room-only'];
  expect(room.title).toContain('named revision is stored in the room');
  expect(room.title).toContain('latest save on this device failed');
  expect(room.title).not.toContain('could not store its snapshot');
  expect(room.title).not.toContain('only in this tab');
  const unconfirmed = WORKSPACE_SAVE_STATE_PRESENTATION['checkpoint-failed'];
  expect(unconfirmed.title).toContain('named save could not be confirmed');
  expect(unconfirmed.title).not.toContain('Saved on this device');
  for (const state of ['room-only', 'checkpoint-failed'] as const) {
    expect(saveGlyphFor(state)).toBe('warning');
    expect(presentedWorkspaceSaveState(state, 1)).toBe(state);
  }
});

it('replaces tab-only failure wording only while the exact authoritative head is still current', () => {
  const room = createSavedRevision(
    createProjectDocument('Room', toUserId('owner')),
    'Saved'
  );
  const failure = new CheckpointSaveError(
    new Error('Device quota exceeded.'),
    room,
    false
  );
  expect(
    presentedWorkspaceSaveState('device-failed', 0, failure.roomDocument, room)
  ).toBe('room-only');
  expect(presentedWorkspaceSaveState('device-failed', 0, null, room)).toBe(
    'device-failed'
  );
  expect(
    presentedWorkspaceSaveState('device-failed', 0, failure.roomDocument, {
      ...room,
      version: room.version + 1
    })
  ).toBe('device-failed');
  expect(
    presentedWorkspaceSaveState('synced', 0, failure.roomDocument, room)
  ).toBe('synced');
});

it('retains exact positive room proof during a retry and after a no-authority retry failure', () => {
  const room = createSavedRevision(
    createProjectDocument('Room', toUserId('owner')),
    'Saved'
  );
  // Starting a new attempt and its no-proof error cannot undo a known room
  // commit. Neither event clears or replaces the independently retained proof.
  expect(presentedWorkspaceSaveState('device-failed', 0, room, room)).toBe(
    'room-only'
  );
  const latestFailure = new CheckpointSaveError(
    new Error('Room retry refused.'),
    null,
    false
  );
  const headState = failedCheckpointSaveState(
    latestFailure,
    'device-failed',
    true,
    room
  );
  expect(presentedWorkspaceSaveState(headState, 0, room, room)).toBe(
    'room-only'
  );
  expect(
    presentedWorkspaceSaveState(headState, 0, room, {
      ...room,
      version: room.version + 1
    })
  ).toBe('device-failed');
  expect(presentedWorkspaceSaveState(headState, 0, null, room)).toBe(
    'device-failed'
  );
});

// Design review I8: a server that answered with an error is not "Offline".
describe('autosave reports as save states', () => {
  it('tells a server error apart from being offline', () => {
    expect(
      autosaveReportedSaveState('offline', new ApiError(500, 'Internal error.'))
    ).toBe('server-error');
    expect(
      autosaveReportedSaveState('offline', new ApiError(503, 'Unavailable'))
    ).toBe('server-error');
    // A failed fetch, or no error at all, is a connection problem.
    expect(
      autosaveReportedSaveState('offline', new TypeError('Failed to fetch'))
    ).toBe('offline');
    expect(autosaveReportedSaveState('offline')).toBe('offline');
    // A client-side refusal keeps its own state.
    expect(
      autosaveReportedSaveState('refused', new ApiError(413, 'Too large'))
    ).toBe('refused');
  });

  it('names one state one way in the top bar and the status bar', () => {
    const server = WORKSPACE_SAVE_STATE_PRESENTATION['server-error'];
    expect([server.topBarLabel, server.statusBarLabel]).toEqual([
      'Not synced',
      'Not synced'
    ]);
    expect(server.title).not.toMatch(/unreachable|offline/i);
    const synced = WORKSPACE_SAVE_STATE_PRESENTATION.synced;
    expect(synced.statusBarLabel).toBe(synced.topBarLabel);
  });
});
