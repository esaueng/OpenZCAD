import {
  AlertTriangle,
  History,
  Layers,
  ListOrdered,
  SlidersHorizontal,
  type LucideIcon
} from 'lucide-react';
import type { PanelId } from '../../lib/panelLayout';

/** What each panel is called: its header, its region and its rail button. */
export const PANEL_TITLES: Readonly<Record<PanelId, string>> = {
  parameters: 'Parameters',
  bodies: 'Objects',
  history: 'History',
  revisions: 'Revisions',
  diagnostics: 'Diagnostics'
};

export const PANEL_ICONS: Readonly<Record<PanelId, LucideIcon>> = {
  parameters: SlidersHorizontal,
  bodies: Layers,
  history: ListOrdered,
  revisions: History,
  diagnostics: AlertTriangle
};

/** The instrument rail's panel buttons, top to bottom. */
export const RAIL_PANEL_ORDER: readonly PanelId[] = [
  'bodies',
  'history',
  'parameters',
  'revisions',
  'diagnostics'
];
