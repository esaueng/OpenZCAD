import { CONTROL_REFERENCE_SEARCH_TERMS } from './controlReference';

/**
 * Settings navigation metadata and search rules.
 *
 * This lives apart from `SettingsPage.tsx` so the "Find a setting" index stays
 * JSX-free and directly unit-testable.
 */

export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'viewport'
  | 'sketching'
  | 'files'
  | 'assistant'
  | 'account'
  | 'shortcuts'
  | 'privacy'
  | 'advanced';

export interface SettingsSectionMeta {
  id: SettingsSectionId;
  label: string;
  detail: string;
  /**
   * Titles of the individual settings this section renders, so "Find a setting"
   * can match what the user actually sees rather than only section headings.
   * Kept in step with the rendered SettingRow titles by a test.
   */
  settings: string[];
  /** Additional searchable copy that is not rendered as a SettingRow title. */
  searchTerms?: readonly string[];
}

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  {
    id: 'general',
    label: 'General',
    detail: 'Startup and project defaults',
    settings: [
      'Reopen the last project',
      'Default units',
      'Confirm destructive actions',
      'Cloud features'
    ]
  },
  {
    id: 'appearance',
    label: 'Appearance',
    detail: 'Density and accessibility',
    settings: ['Theme', 'Interface density', 'Reduce motion']
  },
  {
    id: 'viewport',
    label: 'Viewport',
    detail: 'Projection, navigation, grid, and display',
    settings: [
      'Projection',
      'Show construction grid',
      'Zoom toward the pointer',
      'Middle-button drag',
      'Display mode'
    ]
  },
  {
    id: 'sketching',
    label: 'Sketching',
    detail: 'Linear and angular snapping',
    settings: [
      'Show sketch grid',
      'Snap to sketch grid',
      'Geometry snapping',
      'Automatic inferencing',
      'Linear snap',
      'Snap tolerance',
      'Angular snap',
      'Direct manipulation (experimental)'
    ]
  },
  {
    id: 'files',
    label: 'Files & autosave',
    detail: 'Recovery, imports, and exports',
    settings: [
      'Local autosave',
      'Cloud autosave',
      'Cloud autosave delay',
      'Cloud revisions',
      'Account storage',
      'STEP and STL exports'
    ]
  },
  {
    id: 'assistant',
    label: 'AI Assistant',
    detail: 'Provider, model, and credential',
    settings: [
      'AI assistant',
      'Credential source',
      'Provider',
      'API endpoint',
      'Model',
      'Reasoning level',
      'Output budget',
      'Request timeout',
      'Personal API token'
    ]
  },
  {
    id: 'account',
    label: 'Account',
    detail: 'Identity and synchronization',
    settings: ['Project sharing', 'Cloud profile', 'Preference synchronization']
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    detail: 'Keyboard, mouse, and viewport controls',
    settings: [],
    searchTerms: CONTROL_REFERENCE_SEARCH_TERMS
  },
  {
    id: 'privacy',
    label: 'Privacy & data',
    detail: 'Local and cloud data controls',
    settings: [
      'Reset application settings',
      'Local project data',
      'Delete all cloud projects',
      'Delete cloud profile',
      'Delete all cloud data',
      'Cloud data'
    ],
    searchTerms: [
      'delete account',
      'erase account',
      'delete projects',
      'erase cloud',
      'remove profile',
      'permanent deletion'
    ]
  },
  {
    id: 'advanced',
    label: 'Advanced',
    detail: 'Architecture, kernel version, and diagnostics',
    settings: [
      'Geometry kernel',
      'Kernel version',
      'Document authority',
      'Settings schema',
      'Cloud project storage'
    ]
  }
];

export interface SettingsSectionVisibility {
  /** Device-local offline mode removes every cloud-only settings surface. */
  cloudFunctionsEnabled?: boolean;
  /** Raw "Find a setting" query; blank matches everything. */
  query?: string;
}

/** The settings sections matching the current navigation query. */
export function visibleSettingsSections({
  cloudFunctionsEnabled = true,
  query = ''
}: SettingsSectionVisibility): SettingsSectionMeta[] {
  const available = SETTINGS_SECTIONS.filter(
    (section) =>
      (cloudFunctionsEnabled || section.id !== 'account') &&
      (cloudFunctionsEnabled || section.id !== 'assistant')
  );
  const normalized = query.trim().toLowerCase();
  return normalized
    ? available.filter((section) =>
        `${section.label} ${section.detail} ${section.settings.join(' ')} ${section.searchTerms?.join(' ') ?? ''}`
          .toLowerCase()
          .includes(normalized)
      )
    : available;
}
