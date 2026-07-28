/**
 * Settings navigation metadata and the rules for which sections a user can see.
 *
 * This lives apart from `SettingsPage.tsx` because both of its consumers are
 * about *which* sections exist rather than how they render: the "Find a setting"
 * index, and the assistant kill switch that has to take the whole AI section
 * away. Keeping it JSX-free makes both directly unit-testable.
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
      'AI assistant'
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
    detail: 'Projection, grid, and display',
    settings: ['Projection', 'Show construction grid', 'Display mode']
  },
  {
    id: 'sketching',
    label: 'Sketching',
    detail: 'Linear and angular snapping',
    settings: [
      'Snap sketch input',
      'Linear snap',
      'Angular snap',
      'Direct manipulation (experimental)'
    ]
  },
  {
    id: 'files',
    label: 'Files & autosave',
    detail: 'Recovery, imports, and exports',
    settings: ['Local autosave', 'Cloud revisions', 'STEP and STL exports']
  },
  {
    id: 'assistant',
    label: 'AI Assistant',
    detail: 'Provider, model, and credential',
    settings: [
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
    settings: ['Cloud profile', 'Preference synchronization']
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    detail: 'Keyboard controls',
    settings: []
  },
  {
    id: 'privacy',
    label: 'Privacy & data',
    detail: 'Local data and reset actions',
    settings: ['Reset application settings', 'Project data']
  },
  {
    id: 'advanced',
    label: 'Advanced',
    detail: 'Architecture and diagnostics',
    settings: ['Geometry kernel', 'Document authority', 'Settings schema']
  }
];

export interface SettingsSectionVisibility {
  /** `settings.assistant.enabled`. False removes the AI section entirely. */
  assistantEnabled: boolean;
  /** Raw "Find a setting" query; blank matches everything. */
  query?: string;
}

/**
 * The sections a user may navigate to. A disabled assistant is filtered out
 * before the query is applied, so no search term — "model", "token",
 * "provider" — can surface AI configuration on an AI-free workspace.
 */
export function visibleSettingsSections({
  assistantEnabled,
  query = ''
}: SettingsSectionVisibility): SettingsSectionMeta[] {
  const available = assistantEnabled
    ? [...SETTINGS_SECTIONS]
    : SETTINGS_SECTIONS.filter((section) => section.id !== 'assistant');
  const normalized = query.trim().toLowerCase();
  return normalized
    ? available.filter((section) =>
        `${section.label} ${section.detail} ${section.settings.join(' ')}`
          .toLowerCase()
          .includes(normalized)
      )
    : available;
}
