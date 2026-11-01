import { Box, DraftingCompass, Eye, SlidersHorizontal } from 'lucide-react';
import type { WorkspaceMode } from './panelState';
import type { WorkspaceSaveState } from './cloudProjectAutosave';

/**
 * The four workspaces, in the order they appear. Each hint doubles as the
 * tooltip body — the one place the difference between the modes is spelled
 * out, which matters most for Tweak, a mode a shared-link visitor may be
 * meeting for the first time.
 */
export const WORKSPACE_MODE_OPTIONS: ReadonlyArray<{
  mode: WorkspaceMode;
  label: string;
  hint: string;
  Icon: typeof Eye;
}> = [
  {
    mode: 'view',
    label: 'View',
    hint: 'Read the model. Measure, orbit, inspect — nothing changes.',
    Icon: Eye
  },
  {
    mode: 'tweak',
    label: 'Tweak',
    hint: 'Adjust parameters and export. The design itself stays locked.',
    Icon: SlidersHorizontal
  },
  {
    mode: 'build',
    label: 'Build',
    hint: 'Full modeling workspace. Sketch, features, history.',
    Icon: Box
  },
  {
    mode: 'drawing',
    // A verb like its neighbours, and no wider than them: the segments are
    // equal, so the longest label sets the whole switch's width.
    label: 'Draw',
    hint: 'Lay out drawing sheets and export PDF or SVG. The model stays read-only.',
    Icon: DraftingCompass
  }
];

/**
 * Labels a chip cycles through in ordinary use. Each chip below reserves the
 * widest of these so a presence or account change never resizes it — and no
 * more, so the chip stays as narrow as its own cycle allows. The save label is
 * sized to its own text (see TopBar).
 */
// "Joining…" rather than "Connecting…": the room is joined for the opening
// frames of every cloud project, and the longer word would either resize the
// chip on the way in or cost the bar four characters for good.
export const COLLABORATION_LABEL_RESERVE = [
  '9 live',
  'Offline',
  'Joining…',
  'Not shared',
  'Unavailable'
];
export const ACCOUNT_LABEL_RESERVE = ['Checking', 'Signed out'];

export type SaveGlyph = 'busy' | 'warning' | 'saved' | 'idle';
export function saveGlyphFor(state: WorkspaceSaveState): SaveGlyph {
  if (state === 'saving' || state === 'syncing') return 'busy';
  if (
    state === 'conflict' ||
    state === 'repair' ||
    state === 'refused' ||
    state === 'local-source' ||
    state === 'room-only' ||
    state === 'checkpoint-failed'
  ) {
    return 'warning';
  }
  return state === 'synced' ? 'saved' : 'idle';
}
