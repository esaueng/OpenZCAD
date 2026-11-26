import type { PanelId } from '../../lib/panelLayout';

/**
 * The compact workspace's panel sheet (U12 slice 5): one segmented sheet
 * page in place of the regular workspace's five docked model panels and the
 * floating Comments panel. Pure, so App can name a panel without loading
 * the compact chrome.
 */
export type CompactPanelId = PanelId | 'comments';

/** The segments, left to right: what is built, then what is said about it. */
export const COMPACT_PANEL_ORDER: readonly CompactPanelId[] = [
  'history',
  'bodies',
  'parameters',
  'revisions',
  'diagnostics',
  'comments'
];

/** Each segment's one word: its accessible name and its label when active. */
export const COMPACT_PANEL_TITLES: Readonly<Record<CompactPanelId, string>> = {
  history: 'History',
  bodies: 'Objects',
  parameters: 'Parameters',
  revisions: 'Revisions',
  diagnostics: 'Diagnostics',
  comments: 'Comments'
};

/**
 * The page key the panel sheet takes in the sheet's back stack. One key for
 * every segment: switching segments redraws the page rather than stacking a
 * page per panel, so Back always leaves the panels.
 */
export const PANEL_SHEET_PAGE = 'panels';

/**
 * What Ctrl+\ (Hide or show the model panels) does in the compact
 * workspace: closes an open panel sheet, or opens it on the panel last
 * shown (History the first time).
 */
export function togglePanelSheet(
  open: CompactPanelId | null,
  last: CompactPanelId | null
): CompactPanelId | null {
  return open !== null ? null : (last ?? 'history');
}
