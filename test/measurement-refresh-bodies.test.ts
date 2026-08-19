import { describe, expect, it } from 'vitest';
import type { BodyId, BodyRepresentation } from '@openzcad/shared';
import { committedMeasurementBodies } from '../apps/web/src/lib/measurementRefreshBodies';

function body(bodyId: string, consumed = false): BodyRepresentation {
  return {
    bodyId: bodyId as BodyId,
    name: bodyId,
    source: 'primitive',
    mesh: { kind: 'mesh', vertices: [], indices: [] },
    faceCount: 0,
    color: '#fff',
    exportableStep: true,
    consumed,
    volume: 1,
    bbox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 }
    }
  };
}

describe('committed measurement refresh bodies', () => {
  it('keeps hidden committed bodies and excludes consumed history bodies', () => {
    const shown = body('body-shown');
    const hidden = body('body-hidden');
    const consumed = body('body-consumed', true);
    const hiddenBodyIds = new Set<BodyId>([hidden.bodyId]);

    const selected = committedMeasurementBodies({
      [shown.bodyId]: shown,
      [hidden.bodyId]: hidden,
      [consumed.bodyId]: consumed
    });

    expect(selected).toEqual([shown, hidden]);
    expect(
      selected.some((candidate) => hiddenBodyIds.has(candidate.bodyId))
    ).toBe(true);
  });
});
