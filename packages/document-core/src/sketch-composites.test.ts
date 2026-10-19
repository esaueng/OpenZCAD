import { describe, expect, it } from 'vitest';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toEntityId,
  toUserId,
  type EntityId,
  type ProjectDocument,
  type SketchComposite,
  type SketchCompositeId,
  type SketchId,
  type SketchObjectData
} from '@openzcad/shared';
import {
  addSketchComposite,
  addSketchFeature,
  createProjectDocument,
  createSketchFeatureIds,
  deleteSketchObject,
  findSketch,
  normalizeDocument
} from './index';

/**
 * S04 (schema v23): the composite record that names a drawn rectangle's or
 * polygon's lines as one object. It groups, never moves geometry; it is
 * validated on load and on add, and it dissolves with any member.
 */

const line = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  construction = false
): SketchObjectData => ({
  objectKind: 'line',
  x1,
  y1,
  x2,
  y2,
  ...(construction ? { construction: true } : {})
});

function square(extra: SketchObjectData[] = []) {
  const objects = [
    line(0, 0, 4, 0),
    line(4, 0, 4, 4),
    line(4, 4, 0, 4),
    line(0, 4, 0, 0),
    ...extra
  ];
  const ids = createSketchFeatureIds(objects.length);
  const { document } = addSketchFeature(
    createProjectDocument('S04', toUserId('user_s04')),
    {
      name: 'Square',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects,
      ids
    }
  );
  return { document, sketchId: ids.sketchId, objectIds: ids.objectNodeIds };
}

const record = (
  edgeIds: EntityId[],
  helperIds?: EntityId[]
): SketchComposite => ({
  compositeId: 'scmp_one' as SketchCompositeId,
  compositeKind: 'rectangle',
  method: 'center',
  edgeIds,
  ...(helperIds ? { helperIds } : {})
});

function withComposites(
  document: ProjectDocument,
  sketchId: SketchId,
  composites: unknown
): ProjectDocument {
  const copy = JSON.parse(JSON.stringify(document)) as ProjectDocument;
  (
    findSketch(copy, sketchId) as unknown as Record<string, unknown>
  ).composites = composites;
  return copy;
}

describe('S04 composite records', () => {
  it('loads a sketch without composites unchanged and never synthesizes one', () => {
    const legacyIds = createSketchFeatureIds(2);
    const legacy = addSketchFeature(
      createProjectDocument('Legacy', toUserId('user_s04')),
      {
        name: 'Plate',
        ids: legacyIds,
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          {
            objectKind: 'rectangle',
            width: 20,
            height: 12,
            centerX: 10,
            centerY: 6
          },
          {
            objectKind: 'polygon',
            sides: 6,
            radius: 5,
            centerX: 40,
            centerY: 0
          }
        ]
      }
    );
    const saved = JSON.parse(
      JSON.stringify({ ...legacy.document, schemaVersion: 21 })
    ) as ProjectDocument;
    const loaded = normalizeDocument(saved);
    const sketch = findSketch(loaded, legacyIds.sketchId)!;
    expect(sketch).toEqual(findSketch(saved, legacyIds.sketchId));
    expect('composites' in sketch).toBe(false);
    expect(loaded.nodes).toEqual(saved.nodes);
  });

  it('adds a record over existing lines and construction helpers', () => {
    const { document, sketchId, objectIds } = square([
      line(0, 0, 4, 4, true),
      line(4, 0, 0, 4, true)
    ]);
    const { document: next, compositeId } = addSketchComposite(document, {
      sketchId,
      composite: {
        compositeKind: 'rectangle',
        method: 'center',
        edgeIds: objectIds.slice(0, 4),
        helperIds: objectIds.slice(4)
      },
      ids: { compositeId: 'scmp_fixed' as SketchCompositeId }
    });
    expect(compositeId).toBe('scmp_fixed');
    expect(findSketch(next, sketchId)!.composites).toEqual([
      {
        compositeKind: 'rectangle',
        method: 'center',
        edgeIds: objectIds.slice(0, 4),
        helperIds: objectIds.slice(4),
        compositeId: 'scmp_fixed'
      }
    ]);
    // Grouping is not geometry: no object moved.
    for (const id of objectIds)
      expect(next.nodes[id]).toEqual(document.nodes[id]);
    expect(normalizeDocument(next)).toEqual(next);
  });

  it('refuses members that are missing, not lines, not construction, or already grouped', () => {
    const { document, sketchId, objectIds } = square([
      line(0, 0, 4, 4),
      { objectKind: 'circle', centerX: 2, centerY: 2, radius: 1 }
    ]);
    const add = (edgeIds: EntityId[], helperIds?: EntityId[]) =>
      addSketchComposite(document, {
        sketchId,
        composite: {
          compositeKind: 'rectangle',
          method: 'corner',
          edgeIds,
          ...(helperIds ? { helperIds } : {})
        }
      });
    const sides = objectIds.slice(0, 4);
    expect(() =>
      add([...sides.slice(0, 3), toEntityId('ent_missing')])
    ).toThrow('has no object ent_missing');
    expect(() => add([...sides.slice(0, 3), objectIds[5]!])).toThrow(
      'sides must be lines, not a circle'
    );
    expect(() => add(sides, [objectIds[4]!])).toThrow(
      'helper must be construction geometry'
    );
    expect(() => add(sides.slice(0, 3))).toThrow('ordered sides');
    const grouped = add(sides).document;
    expect(() =>
      addSketchComposite(grouped, {
        sketchId,
        composite: {
          compositeKind: 'polygon',
          method: 'inscribed',
          edgeIds: sides
        }
      })
    ).toThrow('belongs to more than one composite');
  });

  it('refuses a malformed saved record on load', () => {
    const { document, sketchId, objectIds } = square();
    const sides = objectIds.slice(0, 4);
    const refuse = (composites: unknown) =>
      expect(() =>
        normalizeDocument(withComposites(document, sketchId, composites))
      ).toThrow();
    refuse({});
    refuse([{ ...record(sides), compositeId: 'one' }]);
    refuse([{ ...record(sides), compositeKind: 'ellipse' }]);
    refuse([{ ...record(sides), method: 'inscribed' }]);
    refuse([record(sides.slice(0, 3))]);
    refuse([record([...sides.slice(0, 3), sides[0]!])]);
    refuse([{ ...record(sides), extra: true }]);
    refuse([record(sides), { ...record(sides), compositeId: 'scmp_two' }]);
    // A record whose members were edited away stays loadable: the resolver,
    // not the loader, reports it broken.
    expect(() =>
      normalizeDocument(
        withComposites(document, sketchId, [
          record([...sides.slice(0, 3), toEntityId('ent_gone')])
        ])
      )
    ).not.toThrow();
  });

  it('dissolves only the record that named a deleted member', () => {
    const { document, sketchId, objectIds } = square([
      line(0, 0, 4, 4, true),
      line(4, 0, 0, 4, true),
      line(10, 0, 14, 0),
      line(14, 0, 14, 4),
      line(14, 4, 10, 4),
      line(10, 4, 10, 0)
    ]);
    const first = addSketchComposite(document, {
      sketchId,
      composite: {
        compositeKind: 'rectangle',
        method: 'center',
        edgeIds: objectIds.slice(0, 4),
        helperIds: objectIds.slice(4, 6)
      }
    }).document;
    const both = addSketchComposite(first, {
      sketchId,
      composite: {
        compositeKind: 'rectangle',
        method: 'corner',
        edgeIds: objectIds.slice(6, 10)
      }
    });
    // Deleting a helper dissolves the shape that owns it.
    const helperGone = deleteSketchObject(both.document, {
      sketchId,
      objectId: objectIds[4]!
    });
    expect(
      findSketch(helperGone, sketchId)!.composites!.map((c) => c.compositeId)
    ).toEqual([both.compositeId]);
    const sideGone = deleteSketchObject(helperGone, {
      sketchId,
      objectId: objectIds[7]!
    });
    expect('composites' in findSketch(sideGone, sketchId)!).toBe(false);
    expect(findSketch(sideGone, sketchId)!.objectIds).toHaveLength(8);
  });

  it('refuses a document from a newer schema', () => {
    const { document } = square();
    const newer = PROJECT_DOCUMENT_SCHEMA_VERSION + 1;
    expect(() =>
      normalizeDocument({ ...document, schemaVersion: newer as never })
    ).toThrow(`Unsupported project schema (v${newer})`);
  });
});
