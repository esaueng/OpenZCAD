import { describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  normalizeDocument
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toSketchReferenceAnnotationId,
  toUserId,
  type SketchReferenceDimension
} from '@openzcad/shared';
import {
  resolveSketchReferenceDimension,
  sketchConstraintsForSolve
} from '@openzcad/shared';

function user() {
  return toUserId('user_test');
}

describe('S02-A reference dimension schema envelope', () => {
  it('stays on the current additive v15 schema with no version bump', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(15);
  });

  it('leaves a document without reference dimensions byte-identical', () => {
    const created = addSketchFeature(createProjectDocument('Plain', user()), {
      name: 'Sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 3, y2: 4 }]
    });
    const before = JSON.stringify(created.document);
    const normalized = normalizeDocument(
      JSON.parse(before) as Parameters<typeof normalizeDocument>[0]
    );
    expect(JSON.stringify(normalized)).toBe(before);
    const sketch = findSketch(normalized, created.sketchId)!;
    expect(sketch.referenceDimensions).toBeUndefined();
    expect(sketchConstraintsForSolve(sketch)).toEqual(sketch.constraints ?? []);
  });

  it('loads an old document without the optional field unchanged', () => {
    const created = addSketchFeature(createProjectDocument('Legacy', user()), {
      name: 'Sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [{ objectKind: 'circle', radius: 4, centerX: 10, centerY: 20 }]
    });
    const legacy = JSON.parse(JSON.stringify(created.document)) as ReturnType<
      typeof normalizeDocument
    >;
    for (const node of Object.values(legacy.nodes)) {
      if (node.kind === 'sketch') {
        expect('referenceDimensions' in node).toBe(false);
      }
    }
    const migrated = normalizeDocument(legacy);
    const sketch = findSketch(migrated, created.sketchId)!;
    expect(sketch.referenceDimensions).toBeUndefined();
    expect(sketch.constraints ?? []).toEqual([]);
  });

  it('round-trips annotation identity and targets, recomputing the value', () => {
    const created = addSketchFeature(createProjectDocument('Ref', user()), {
      name: 'Sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 3, y2: 4 }]
    });
    const sketch = findSketch(created.document, created.sketchId)!;
    const objectId = sketch.objectIds[0]!;
    const annotation: SketchReferenceDimension = {
      annotationId: toSketchReferenceAnnotationId('sref_roundtrip'),
      data: {
        dimensionKind: 'distance',
        a: { objectId, point: 'start' },
        b: { objectId, point: 'end' }
      }
    };
    const withRef = JSON.parse(
      JSON.stringify({
        ...created.document,
        nodes: {
          ...created.document.nodes,
          [sketch.id]: { ...sketch, referenceDimensions: [annotation] }
        }
      })
    ) as ReturnType<typeof normalizeDocument>;
    const reopened = normalizeDocument(withRef);
    const restored = findSketch(reopened, created.sketchId)!;
    expect(restored.referenceDimensions).toEqual([annotation]);
    // No SketchConstraint was added and the solver input is untouched.
    expect(restored.constraints ?? []).toEqual([]);
    expect(sketchConstraintsForSolve(restored)).toEqual([]);

    const byId = new Map(
      restored.objectIds.map((id) => {
        const node = reopened.nodes[id];
        if (node?.kind !== 'sketch-object') {
          throw new Error('object missing');
        }
        return [id, node.data] as const;
      })
    );
    const outcome = resolveSketchReferenceDimension(
      byId,
      restored.referenceDimensions![0]!,
      (value) => (typeof value === 'number' ? value : undefined)
    );
    expect(outcome.status).toBe('current');
    if (outcome.status === 'current' && outcome.dimensionKind === 'distance') {
      expect(outcome.value).toBeCloseTo(5, 12);
    } else {
      throw new Error('expected a current distance after reopen');
    }
  });

  it('keeps an invalid target repairable without a stale number', () => {
    const created = addSketchFeature(createProjectDocument('Broken', user()), {
      name: 'Sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 3, y2: 4 }]
    });
    const sketch = findSketch(created.document, created.sketchId)!;
    const annotation: SketchReferenceDimension = {
      annotationId: toSketchReferenceAnnotationId('sref_broken'),
      data: {
        dimensionKind: 'distance',
        a: { objectId: sketch.objectIds[0]!, point: 'start' },
        b: { objectId: 'ent_gone' as never, point: 'end' }
      }
    };
    const persisted: unknown = JSON.parse(JSON.stringify([annotation]));
    expect(persisted).toEqual([
      {
        annotationId: 'sref_broken',
        data: {
          dimensionKind: 'distance',
          a: { objectId: sketch.objectIds[0], point: 'start' },
          b: { objectId: 'ent_gone', point: 'end' }
        }
      }
    ]);
    const byId = new Map(
      sketch.objectIds.map((id) => {
        const node = created.document.nodes[id];
        if (node?.kind !== 'sketch-object') {
          throw new Error('object missing');
        }
        return [id, node.data] as const;
      })
    );
    const outcome = resolveSketchReferenceDimension(
      byId,
      annotation,
      (value) => (typeof value === 'number' ? value : undefined)
    );
    expect(outcome.status).toBe('unresolved');
    if (outcome.status === 'unresolved') {
      expect(outcome.reason).toContain('sref_broken');
      // No numeric value rides along with an unresolved row.
      expect('value' in outcome).toBe(false);
      expect('valueDeg' in outcome).toBe(false);
    }
  });
});
