import { describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { countClosedProfileSketches } from './profileAvailability';

describe('closed sketch availability with document units', () => {
  it.each(['mm', 'cm', 'inch'] as const)(
    'keeps a unit-bearing profile available in %s',
    (units) => {
      const document = addSketchFeature(
        createProjectDocument('Unit profile', toUserId('profile_units'), units),
        {
          name: 'Rectangle',
          plane: 'XY',
          offset: 0,
          object: {
            objectKind: 'rectangle',
            width: '5 mm + 2 cm',
            height: 'height',
            centerX: 0,
            centerY: 0
          }
        }
      ).document;
      expect(countClosedProfileSketches(document, { height: 1 })).toBe(1);
      expect(countClosedProfileSketches(document, {})).toBe(0);
    }
  );

  it('has no available profile without a document', () => {
    expect(countClosedProfileSketches(null, {})).toBe(0);
  });
});
