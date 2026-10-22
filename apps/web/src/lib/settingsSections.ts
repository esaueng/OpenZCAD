import { CONTROL_REFERENCE_SEARCH_TERMS } from './controlReference';
import { KEYMAP_COMMANDS } from './keymap';
import type { SettingsSectionId } from './settingsSectionIds';

/**
 * Settings navigation metadata and search rules.
 *
 * This lives apart from `SettingsPage.tsx` so the "Find a setting" index stays
 * JSX-free and directly unit-testable.
 */

export type { SettingsSectionId };

/**
 * The sidebar heading a section sits under. Advanced has none: it closes the
 * list on its own, below a rule.
 */
export type SettingsSectionGroup = 'Workspace' | 'Cloud and data';

export interface SettingsSectionMeta {
  id: SettingsSectionId;
  label: string;
  detail: string;
  group?: SettingsSectionGroup;
  /**
   * Titles of the individual settings this section renders, so "Find a setting"
   * can match what the user actually sees rather than only section headings.
   * Kept in step with the rendered SettingRow titles by a test.
   */
  settings: string[];
  /** Additional searchable copy that is not rendered as a SettingRow title. */
  searchTerms?: readonly string[];
}

/** What Account still offers while cloud features are off: the way back. */
const CLOUD_SWITCH_SEARCH_TERMS = [
  'offline',
  'offline mode',
  'cloud switch',
  'turn on cloud'
] as const;

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  {
    id: 'general',
    label: 'General',
    detail: 'Startup, new-project and file-unit defaults',
    group: 'Workspace',
    settings: [
      'Default units',
      'Unitless imports',
      'Export units',
      'Reopen the last project',
      'Confirm destructive actions'
    ],
    searchTerms: ['import', 'export', 'stl', 'inches', 'millimeters']
  },
  {
    id: 'appearance',
    label: 'Appearance',
    detail: 'Theme, density, and motion',
    group: 'Workspace',
    settings: ['Theme', 'Interface density', 'Reduce motion'],
    searchTerms: ['dark mode', 'light mode', 'color scheme']
  },
  {
    id: 'viewport',
    label: 'Viewport',
    detail: 'How new views look',
    group: 'Workspace',
    settings: [
      'Projection',
      'Display mode',
      'Show construction grid',
      'Field of view',
      'X-ray opacity',
      'Current view'
    ],
    searchTerms: [
      'wireframe',
      'perspective',
      'orthographic',
      'apply defaults',
      'fov',
      'xray',
      'transparent'
    ]
  },
  {
    id: 'controls',
    label: 'Controls',
    detail: 'Mouse, trackpad, and shortcuts',
    group: 'Workspace',
    settings: ['Scroll wheel', 'Middle-button drag', 'Zoom toward the pointer'],
    searchTerms: [
      'shortcuts',
      'keyboard',
      'mouse',
      'trackpad',
      'navigation',
      ...CONTROL_REFERENCE_SEARCH_TERMS,
      // Every remappable command by name, so "fillet" finds where to give
      // Fillet a key, and the words people use for remapping.
      ...KEYMAP_COMMANDS.map((command) => command.label),
      'remap',
      'keymap',
      'key binding',
      'hotkey',
      'customize shortcuts',
      'Reset all shortcuts'
    ]
  },
  {
    id: 'sketching',
    label: 'Sketching',
    detail: 'Grid, snapping, and inferencing',
    group: 'Workspace',
    settings: [
      'Show sketch grid',
      'Snap to sketch grid',
      'Linear snap',
      'Geometry snapping',
      'Snap tolerance',
      'Automatic inferencing',
      'Relation glyphs',
      'Glyph kinds'
    ]
  },
  {
    id: 'saving',
    label: 'Saving',
    detail: 'Autosave and revisions',
    group: 'Cloud and data',
    settings: [
      'Local autosave',
      'Cloud autosave',
      'Cloud autosave delay',
      'Cloud revisions'
    ],
    searchTerms: ['files', 'autosave', 'save', 'recovery', 'checkpoint']
  },
  {
    id: 'account',
    label: 'Account',
    detail: 'Cloud, profile, sharing, and storage',
    group: 'Cloud and data',
    settings: [
      'Cloud features',
      'Membership',
      'Personal information',
      'Preference synchronization',
      'Project sharing',
      'Account storage',
      'Cloud file storage'
    ],
    searchTerms: [
      ...CLOUD_SWITCH_SEARCH_TERMS,
      'hide name',
      'hide email',
      'screenshot',
      'show personal info',
      'sign in',
      'sign out',
      'log in',
      'login',
      'password',
      'sync preferences',
      'collaboration',
      'storage usage',
      'cloud profile',
      'email sign-in'
    ]
  },
  {
    id: 'assistant',
    label: 'AI Assistant',
    detail: 'Provider, model, and credential',
    group: 'Cloud and data',
    settings: [
      'AI assistant',
      'Credential source',
      'Built-in assistant',
      'Provider',
      'API endpoint',
      'Model',
      'Reasoning level',
      'Personal API token',
      'Connection',
      'Output budget',
      'Request timeout'
    ],
    searchTerms: [
      'api key',
      'deployment',
      'test connection',
      'CAD assistant preferences',
      'custom instructions',
      'training',
      'data use',
      'free model',
      'retention'
    ]
  },
  {
    id: 'privacy',
    label: 'Privacy & data',
    detail: 'Analytics and data deletion',
    group: 'Cloud and data',
    settings: [
      'Usage analytics',
      'Diagnostic report',
      'Cloud account statistics',
      'Local project data',
      'Cloud data',
      'Delete all cloud projects',
      'Delete cloud profile',
      'Delete all cloud data'
    ],
    searchTerms: [
      'delete account',
      'erase account',
      'optional usage analytics',
      'delete projects',
      'erase cloud',
      'remove profile',
      'permanent deletion'
    ]
  },
  {
    id: 'advanced',
    label: 'Advanced',
    detail: 'Editing mode, diagnostics, and reset',
    settings: [
      'Direct manipulation',
      'Geometry kernel',
      'Kernel version',
      'Document authority',
      'Exports',
      'Settings schema',
      'Cloud project storage',
      'Reset application settings'
    ],
    searchTerms: [
      'STEP',
      'STL',
      '3MF',
      'export formats',
      'face drag',
      'offset handle',
      'reset settings',
      'restore defaults'
    ]
  }
];

export interface SettingsSectionVisibility {
  /** Device-local offline mode removes every cloud-only settings surface. */
  cloudFunctionsEnabled?: boolean;
  /** Raw "Find a setting" query; blank matches everything. */
  query?: string;
}

/**
 * Account while cloud features are off: only the switch that turns them back
 * on, so a search for sign-in or sharing does not lead to a page that cannot
 * show them.
 */
function offlineAccount(section: SettingsSectionMeta): SettingsSectionMeta {
  return {
    ...section,
    detail: 'Turn cloud features back on',
    settings: ['Cloud features'],
    searchTerms: CLOUD_SWITCH_SEARCH_TERMS
  };
}

/** The settings sections matching the current navigation query. */
export function visibleSettingsSections({
  cloudFunctionsEnabled = true,
  query = ''
}: SettingsSectionVisibility): SettingsSectionMeta[] {
  const available = cloudFunctionsEnabled
    ? [...SETTINGS_SECTIONS]
    : SETTINGS_SECTIONS.filter((section) => section.id !== 'assistant').map(
        (section) =>
          section.id === 'account' ? offlineAccount(section) : section
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
