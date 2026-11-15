import { describe, expect, it } from 'vitest';
import { copyBaseName, DEMO_DEFINITIONS } from './demoDefinitions';

describe('copyBaseName', () => {
  it('drops the sample prefix from a copy of a sample', () => {
    const bracket = DEMO_DEFINITIONS[0]!;
    expect(copyBaseName(bracket.projectId, bracket.name)).toBe(
      'Mounting Bracket'
    );
  });

  it('keeps a user project’s name as typed, prefix and all', () => {
    expect(copyBaseName('project_mine', 'Demo · My part')).toBe(
      'Demo · My part'
    );
  });
});
