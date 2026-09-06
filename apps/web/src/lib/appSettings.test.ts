import { describe, expect, it } from 'vitest';
import { defaultAppSettings, normalizeAppSettings } from './appSettings';

describe('appSettings experiments', () => {
  it('leaves the workspace column off by default', () => {
    expect(defaultAppSettings().experiments.workspaceColumn).toBe(false);
    // Settings written before the flag existed carry no `workspaceColumn`
    // key at all; that has to read as off, not as a parse failure.
    const legacy = normalizeAppSettings({
      schemaVersion: 1,
      experiments: { directManipulation: true }
    });
    expect(legacy.experiments.workspaceColumn).toBe(false);
    expect(legacy.experiments.directManipulation).toBe(true);
  });

  it('keeps the workspace column on once chosen', () => {
    const chosen = normalizeAppSettings({
      schemaVersion: 1,
      experiments: { workspaceColumn: true }
    });
    expect(chosen.experiments.workspaceColumn).toBe(true);
  });
});
