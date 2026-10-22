/**
 * The Settings section ids, kept apart from `settingsSections.ts`.
 *
 * The workspace restores the open Settings section at startup
 * (`settingsViewState.ts`), and validating against the full section index
 * pulled its search terms, and with them the whole control reference, into
 * the entry chunk. Settings itself is a lazy chunk; only this list is needed
 * at first paint. `settingsSections.test.ts` keeps the two in step.
 */
export const SETTINGS_SECTION_IDS = [
  'general',
  'appearance',
  'viewport',
  'controls',
  'sketching',
  'saving',
  'account',
  'encryption',
  'assistant',
  'privacy',
  'advanced'
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/**
 * Ids a stored Settings view may still name from before a section was
 * renamed, mapped to the section that now holds the same settings.
 */
export const LEGACY_SETTINGS_SECTION_IDS: Readonly<
  Record<string, SettingsSectionId>
> = {
  files: 'saving',
  shortcuts: 'controls'
};
