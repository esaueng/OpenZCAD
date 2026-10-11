import { describe, expect, it } from 'vitest';
import type { ProjectDocument } from '@openzcad/shared';
import {
  beginFieldDefinition,
  createFieldDefinitionTracker,
  editFormVersion
} from './fieldParameterDefinitions';

function at(version: number, reason: string, projectId = 'proj-a') {
  return {
    projectId,
    version,
    revisions: [{ reason }]
  } as unknown as Pick<ProjectDocument, 'projectId' | 'version' | 'revisions'>;
}

describe('edit form version across a field definition (G5)', () => {
  it('keeps the version the form had through every version a definition commits', () => {
    const tracker = createFieldDefinitionTracker();
    expect(editFormVersion(tracker, at(18, 'Edit box'))).toBe(18);
    const settle = beginFieldDefinition(tracker, 'hgt', at(18, 'Edit box'));
    // Rendered before the definition returns, and more than one version.
    expect(editFormVersion(tracker, at(19, 'Set parameter hgt'))).toBe(18);
    expect(editFormVersion(tracker, at(20, 'Set parameter hgt'))).toBe(18);
    settle();
    // Still kept once it has settled, on every later render.
    expect(editFormVersion(tracker, at(20, 'Set parameter hgt'))).toBe(18);
  });

  it('moves on for anything else', () => {
    const tracker = createFieldDefinitionTracker();
    const settle = beginFieldDefinition(tracker, 'hgt', at(4, 'Add box'));
    // A parameter set from the panel, an undo, a collaborator's edit.
    expect(editFormVersion(tracker, at(5, 'Set parameter width'))).toBe(5);
    settle();
    expect(editFormVersion(tracker, at(6, 'Set parameter hgt'))).toBe(6);
    expect(editFormVersion(tracker, at(7, 'Undo Set parameter hgt'))).toBe(7);
  });

  it('keeps projects apart', () => {
    const tracker = createFieldDefinitionTracker();
    const settle = beginFieldDefinition(tracker, 'hgt', at(4, 'Add box'));
    expect(editFormVersion(tracker, at(5, 'Set parameter hgt'))).toBe(4);
    settle();
    expect(editFormVersion(tracker, at(5, 'Set parameter hgt', 'proj-b'))).toBe(
      5
    );
  });

  it('chains definitions made one after another from the same form', () => {
    const tracker = createFieldDefinitionTracker();
    const first = beginFieldDefinition(tracker, 'a', at(3, 'Add box'));
    // The workspace reads the committed document once more before settling,
    // whether or not it rendered that version.
    expect(editFormVersion(tracker, at(4, 'Set parameter a'))).toBe(3);
    first();
    const second = beginFieldDefinition(tracker, 'b', at(4, 'Set parameter a'));
    expect(editFormVersion(tracker, at(5, 'Set parameter b'))).toBe(3);
    second();
    expect(editFormVersion(tracker, at(6, 'Edit box'))).toBe(6);
  });
});
