import type { WorkspaceSaveState } from './cloudProjectAutosave';

/**
 * The state the indicators should show. The autosave controller only knows
 * whether the document synced; a document that references an import source
 * that exists only in this browser must not present as plainly synced, because
 * no other device can rebuild it.
 */
export function presentedWorkspaceSaveState(
  saveState: WorkspaceSaveState,
  localOnlySourceCount: number
): WorkspaceSaveState {
  return saveState === 'synced' && localOnlySourceCount > 0
    ? 'local-source'
    : saveState;
}

/**
 * One presentation source for every workspace sync indicator. The compact
 * footer and the actionable top bar may use different wording, but they can no
 * longer disagree about whether a project is local, syncing, or in the account.
 */
export const WORKSPACE_SAVE_STATE_PRESENTATION: Record<
  WorkspaceSaveState,
  { topBarLabel: string; statusBarLabel: string; title: string }
> = {
  saving: {
    topBarLabel: 'Saving',
    statusBarLabel: 'Saving',
    title: 'Saving to this device…'
  },
  local: {
    topBarLabel: 'Local only',
    statusBarLabel: 'Local only',
    title: 'Saved on this device. Not in your account.'
  },
  syncing: {
    topBarLabel: 'Syncing',
    statusBarLabel: 'Syncing',
    title: 'Saved on this device · copying to your account…'
  },
  synced: {
    topBarLabel: 'Saved',
    statusBarLabel: 'Synced',
    title: 'Saved on this device and in your account.'
  },
  'local-source': {
    topBarLabel: 'Local source',
    statusBarLabel: 'Local source only',
    title:
      'Project synced, but an imported source file exists only on this device. Other devices cannot rebuild it. Use File → Archive local sources to upload it.'
  },
  offline: {
    topBarLabel: 'Offline',
    statusBarLabel: 'Offline',
    title: 'Saved on this device · your account is unreachable right now.'
  },
  conflict: {
    topBarLabel: 'Conflict',
    statusBarLabel: 'Conflict',
    title: 'This project changed elsewhere. Your work is safe on this device.'
  },
  refused: {
    topBarLabel: 'Too large',
    statusBarLabel: 'Too large',
    title: 'Too large for your account. Saved on this device.'
  },
  paused: {
    topBarLabel: 'Autosave off',
    statusBarLabel: 'Autosave off',
    title:
      'Saved on this device · cloud autosave is off. Ctrl/Cmd+S updates your account.'
  }
};
