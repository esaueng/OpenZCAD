import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  cloneDocument,
  addSketchFeature,
  addSketchObjects,
  booleanBodies,
  createCheckpoint,
  createProjectDocument,
  deleteSketchObject,
  findSketch,
  updateSketchObject,
  deleteFeature,
  deleteParameter,
  duplicateProjectDocument,
  evaluateExpression,
  extrudeSketch,
  getLatestBodyId,
  getLatestSketchId,
  getParameterScope,
  listFeaturesInOrder,
  listParameters,
  normalizeDocument,
  resolveParamValue,
  revolveSketch,
  setParameter,
  updateFeature,
  updateSketch
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  sanitizeFileName,
  toUserId
} from '@openzcad/shared';

const user = () => toUserId('user_test');

describe('document-core', () => {
  it('creates a stable project scaffold', () => {
    const document = createProjectDocument('Test', user());
    expect(document.name).toBe('Test');
    expect(
      Object.values(document.nodes).some((node) => node.kind === 'project')
    ).toBe(true);
    expect(document.revisions).toHaveLength(1);
    expect(document.checkpoints).toHaveLength(1);
    expect(document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(document.assets).toEqual({});
    expect(document.parameterOrder).toEqual([]);
  });

  it('migrates legacy documents without losing their canonical data', () => {
    const current = createProjectDocument('Legacy', user());
    const legacy = structuredClone(current) as Partial<typeof current>;
    delete legacy.schemaVersion;
    delete legacy.assets;
    delete legacy.checkpoints;

    const migrated = normalizeDocument(legacy as typeof current);

    expect(migrated.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(migrated.projectId).toBe(current.projectId);
    expect(migrated.nodes).toEqual(current.nodes);
    expect(migrated.assets).toEqual({});
    expect(migrated.checkpoints).toHaveLength(1);
    expect(migrated.checkpoints[0]?.reason).toBe('Migrated save point');
  });

  it('records save checkpoints without changing model version', () => {
    const document = createProjectDocument('Checkpoint', user());
    const saved = createCheckpoint(document, 'Manual save');

    expect(saved.version).toBe(document.version);
    expect(saved.checkpoints).toHaveLength(2);
    expect(saved.checkpoints.at(-1)?.reason).toBe('Manual save');
  });

  it('sanitizes malformed and unbounded checkpoint history on load', () => {
    const document = createProjectDocument('Checkpoint', user());
    document.checkpoints = [
      ...Array.from({ length: 120 }, (_, index) => ({
        ...document.checkpoints[0]!,
        checkpointId: `checkpoint_${index}`
      })),
      { reason: { unsafe: true } } as never
    ];

    const normalized = normalizeDocument(document);
    expect(normalized.checkpoints).toHaveLength(99);
    expect(
      normalized.checkpoints.every(
        (checkpoint) => typeof checkpoint.reason === 'string'
      )
    ).toBe(true);
  });

  it('gives a duplicate a fresh latest revision identity', () => {
    const source = createProjectDocument('Source', user());
    const duplicate = duplicateProjectDocument(source, 'Copy', user());

    expect(duplicate.revisions.at(-1)?.revisionId).not.toBe(
      source.revisions.at(-1)?.revisionId
    );
    expect(duplicate.checkpoints.at(-1)?.revisionId).toBe(
      duplicate.revisions.at(-1)?.revisionId
    );
  });

  it('adds primitives and extrudes sketches into bodies', () => {
    let document = createProjectDocument('Test', user());
    document = addPrimitiveFeature(document, {
      name: 'Box 1',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 20, depth: 30 }
    });

    const sketchResult = addSketchFeature(document, {
      name: 'Sketch 1',
      plane: 'XY',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 20,
        height: 10,
        centerX: 0,
        centerY: 0
      }
    });
    document = extrudeSketch(sketchResult.document, {
      name: 'Extrude',
      sketchId: sketchResult.sketchId,
      distance: 15
    }).document;

    expect(document.bodyOrder).toHaveLength(2);
    expect(getLatestBodyId(document)).toBeTruthy();
  });

  it('rejects a boolean whose targets are not two distinct bodies', () => {
    let document = createProjectDocument('Boolean Targets', user());
    for (const name of ['A', 'B']) {
      document = addPrimitiveFeature(document, {
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      });
    }
    const [first, second] = document.bodyOrder;

    expect(() =>
      booleanBodies(document, {
        name: 'Lonely',
        operation: 'union',
        targetBodyIds: [first!]
      })
    ).toThrow(/at least two target bodies/);
    expect(() =>
      booleanBodies(document, {
        name: 'Twice',
        operation: 'union',
        targetBodyIds: [first!, first!]
      })
    ).toThrow(/same body twice/);

    const merged = booleanBodies(document, {
      name: 'Merged',
      operation: 'union',
      targetBodyIds: [first!, second!]
    });
    expect(merged.document.bodyOrder).toHaveLength(3);
  });

  it('migrates v3 sketch nodes to planeRef without touching other nodes', () => {
    const base = createProjectDocument('SketchMigrate', user());
    const { document: withSketch } = addSketchFeature(base, {
      name: 'Sketch 1',
      plane: 'XZ',
      offset: 5,
      object: {
        objectKind: 'circle',
        radius: 10,
        centerX: 0,
        centerY: 0
      }
    });
    // Simulate a v3 save: strip planeRef, keep the legacy fields.
    const legacy = structuredClone(withSketch);
    legacy.schemaVersion = 3 as typeof legacy.schemaVersion;
    for (const node of Object.values(legacy.nodes)) {
      if (node.kind === 'sketch') {
        // @ts-expect-error building a v3 node shape on purpose
        delete node.planeRef;
        node.plane = 'XZ';
        node.offset = 5;
      }
    }

    const migrated = normalizeDocument(legacy);
    const sketch = Object.values(migrated.nodes).find(
      (node) => node.kind === 'sketch'
    );
    expect(sketch?.kind).toBe('sketch');
    expect(sketch?.kind === 'sketch' && sketch.planeRef).toEqual({
      type: 'canonical',
      plane: 'XZ',
      offset: 5
    });
    expect(migrated.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    // Idempotent: already-migrated nodes pass through untouched.
    const again = normalizeDocument(migrated);
    expect(again.nodes).toEqual(migrated.nodes);
  });

  it('replays schema-v4 projects unchanged while upgrading the version tag', () => {
    const current = createProjectDocument('Schema v4', user());
    const legacy = structuredClone(current);
    legacy.schemaVersion = 4 as typeof legacy.schemaVersion;

    const migrated = normalizeDocument(legacy);

    expect(migrated.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(migrated.nodes).toEqual(legacy.nodes);
    expect(migrated.commandLog).toEqual(legacy.commandLog);
    expect(migrated.derived).toEqual(legacy.derived);
  });

  it('upgrades additive schema-v5 projects to v6 without rewriting history', () => {
    const current = createProjectDocument('Schema v5', user());
    const legacy = structuredClone(current);
    legacy.schemaVersion = 5 as typeof legacy.schemaVersion;

    const migrated = normalizeDocument(legacy);

    expect(migrated.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(migrated.nodes).toEqual(legacy.nodes);
    expect(migrated.featureOrder).toEqual(legacy.featureOrder);
    expect(migrated.bodyOrder).toEqual(legacy.bodyOrder);
    expect(migrated.commandLog).toEqual(legacy.commandLog);
  });

  it('accepts v4 multi-object sketches and edits objects individually', () => {
    const base = createProjectDocument('MultiObject', user());
    const { document: withSketch, sketchId } = addSketchFeature(base, {
      name: 'Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        { objectKind: 'circle', radius: 63, centerX: 0, centerY: 0 },
        { objectKind: 'circle', radius: 40, centerX: 0, centerY: 0 },
        { objectKind: 'line', x1: -70, y1: 0, x2: 70, y2: 20 }
      ]
    });
    let sketch = findSketch(withSketch, sketchId);
    expect(sketch?.objectIds).toHaveLength(3);

    const { document: withMore, objectNodeIds } = addSketchObjects(withSketch, {
      sketchId,
      objects: [
        {
          objectKind: 'arc',
          centerX: 0,
          centerY: 0,
          radius: 20,
          startAngleDeg: 0,
          endAngleDeg: 90
        }
      ]
    });
    sketch = findSketch(withMore, sketchId);
    expect(sketch?.objectIds).toHaveLength(4);
    expect(objectNodeIds).toHaveLength(1);

    const updated = updateSketchObject(withMore, {
      sketchId,
      objectId: objectNodeIds[0]!,
      data: {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 25,
        startAngleDeg: 0,
        endAngleDeg: 180
      }
    });
    const arcNode = updated.nodes[objectNodeIds[0]!];
    expect(
      arcNode?.kind === 'sketch-object' &&
        arcNode.data.objectKind === 'arc' &&
        arcNode.data.radius
    ).toBe(25);

    const removed = deleteSketchObject(updated, {
      sketchId,
      objectId: objectNodeIds[0]!
    });
    expect(findSketch(removed, sketchId)?.objectIds).toHaveLength(3);
    expect(removed.nodes[objectNodeIds[0]!]).toBeUndefined();
  });

  it('replays v3 sketch payloads to the same node graph', () => {
    // v3 command logs carry {plane, offset, object} and a single objectNodeId.
    const base = createProjectDocument('Replay', user());
    const { document: next, sketchId } = addSketchFeature(base, {
      name: 'Legacy sketch',
      plane: 'YZ',
      offset: 2,
      object: {
        objectKind: 'polygon',
        sides: 6,
        radius: 8,
        centerX: 1,
        centerY: 2
      }
    });
    const sketch = findSketch(next, sketchId);
    expect(sketch?.planeRef).toEqual({
      type: 'canonical',
      plane: 'YZ',
      offset: 2
    });
    expect(sketch?.objectIds).toHaveLength(1);
    const objectNode = next.nodes[sketch!.objectIds[0]!];
    expect(objectNode?.kind).toBe('sketch-object');
  });

  it('does not mutate the input document', () => {
    const original = createProjectDocument('Test', user());
    const nodeCount = Object.keys(original.nodes).length;
    addPrimitiveFeature(original, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    expect(Object.keys(original.nodes)).toHaveLength(nodeCount);
    expect(original.featureOrder).toHaveLength(0);
    expect(original.version).toBe(1);
  });
});

describe('parameters', () => {
  it('upserts parameters and evaluates dependent expressions in any order', () => {
    let document = createProjectDocument('Params', user());
    document = setParameter(document, {
      name: 'total',
      expression: 'width * 2'
    });
    document = setParameter(document, { name: 'width', expression: '21' });

    const { scope, errors } = getParameterScope(document);
    expect(errors).toEqual([]);
    expect(scope.width).toBe(21);
    expect(scope.total).toBe(42);

    document = setParameter(document, { name: 'width', expression: '10' });
    expect(getParameterScope(document).scope.total).toBe(20);
    expect(listParameters(document)).toHaveLength(2);
  });

  it('reports cycles and unknown references as per-parameter errors', () => {
    let document = createProjectDocument('Params', user());
    document = setParameter(document, { name: 'a', expression: 'b + 1' });
    document = setParameter(document, { name: 'b', expression: 'a + 1' });
    const { scope, errors } = getParameterScope(document);
    expect(Object.keys(scope)).toHaveLength(0);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/Parameter "a"/);
  });

  it('rejects invalid names and deletes by name', () => {
    let document = createProjectDocument('Params', user());
    expect(() =>
      setParameter(document, { name: '2bad', expression: '1' })
    ).toThrow(/not a valid parameter name/);
    expect(() =>
      setParameter(document, { name: 'sin', expression: '1' })
    ).toThrow(/not a valid parameter name/);
    document = setParameter(document, { name: 'keep', expression: '5' });
    document = deleteParameter(document, { name: 'keep' });
    expect(listParameters(document)).toHaveLength(0);
    expect(() => deleteParameter(document, { name: 'keep' })).toThrow(
      /not found/
    );
  });

  it('resolves literal and expression ParamValues', () => {
    expect(resolveParamValue(4, {})).toBe(4);
    expect(resolveParamValue('w / 2', { w: 9 })).toBe(4.5);
    expect(() => resolveParamValue('missing', {}, 'width')).toThrow(/^width:/);
  });
});

describe('feature editing', () => {
  it('merges primitive dimension patches and renames', () => {
    let document = createProjectDocument('Edit', user());
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 20, depth: 30 }
    });
    const feature = listFeaturesInOrder(document)[0]!;
    document = updateFeature(document, {
      featureId: feature.featureId,
      name: 'Base Block',
      data: { dimensions: { width: 'w * 2' } }
    });
    const updated = listFeaturesInOrder(document)[0]!;
    expect(updated.name).toBe('Base Block');
    expect(updated.data.featureKind).toBe('primitive');
    if (updated.data.featureKind === 'primitive') {
      expect(updated.data.dimensions).toEqual({
        width: 'w * 2',
        height: 20,
        depth: 30
      });
    }
  });

  it('refuses to change a feature kind', () => {
    let document = createProjectDocument('Edit', user());
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const feature = listFeaturesInOrder(document)[0]!;
    expect(() =>
      updateFeature(document, {
        featureId: feature.featureId,
        data: { featureKind: 'extrude' } as never
      })
    ).toThrow(/cannot change kind/);
  });

  it('updates sketch plane, offset, and profile', () => {
    let document = createProjectDocument('Edit', user());
    const { document: withSketch, sketchId } = addSketchFeature(document, {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 10,
        height: 10,
        centerX: 0,
        centerY: 0
      }
    });
    document = updateSketch(withSketch, {
      sketchId,
      plane: 'XZ',
      offset: 'lift',
      object: { objectKind: 'circle', radius: 7, centerX: 1, centerY: 2 }
    });
    const sketch = Object.values(document.nodes).find(
      (node) => node.kind === 'sketch'
    );
    expect(sketch?.kind).toBe('sketch');
    if (sketch?.kind === 'sketch') {
      expect(sketch.planeRef).toEqual({
        type: 'canonical',
        plane: 'XZ',
        offset: 'lift'
      });
      const objectNode = document.nodes[sketch.objectIds[0]!];
      expect(objectNode?.kind).toBe('sketch-object');
      if (objectNode?.kind === 'sketch-object') {
        expect(objectNode.data).toEqual({
          objectKind: 'circle',
          radius: 7,
          centerX: 1,
          centerY: 2
        });
      }
    }
  });

  it('deletes a feature with its body, and sketch features with their sketches', () => {
    let document = createProjectDocument('Delete', user());
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const { document: withSketch, sketchId } = addSketchFeature(document, {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      object: { objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }
    });
    document = withSketch;

    const [boxFeature, sketchFeature] = listFeaturesInOrder(document);
    document = deleteFeature(document, { featureId: boxFeature!.featureId });
    expect(document.bodyOrder).toHaveLength(0);
    expect(document.featureOrder).toHaveLength(1);

    document = deleteFeature(document, { featureId: sketchFeature!.featureId });
    expect(document.sketchOrder).not.toContain(sketchId);
    expect(
      Object.values(document.nodes).some((node) => node.kind === 'sketch')
    ).toBe(false);
    expect(
      Object.values(document.nodes).some(
        (node) => node.kind === 'sketch-object'
      )
    ).toBe(false);

    const part = document.nodes[document.activePartId];
    expect(part?.kind).toBe('part');
    if (part?.kind === 'part') {
      expect(part.childIds).toHaveLength(0);
    }
  });
});

describe('evaluateExpression', () => {
  const scope = { width: 10, height: 4 };

  it('evaluates arithmetic with precedence and parentheses', () => {
    expect(evaluateExpression('1 + 2 * 3', {})).toBe(7);
    expect(evaluateExpression('(1 + 2) * 3', {})).toBe(9);
    expect(evaluateExpression('10 / 4', {})).toBe(2.5);
    expect(evaluateExpression('-3 + 5', {})).toBe(2);
    expect(evaluateExpression('2 * -4', {})).toBe(-8);
    expect(evaluateExpression('.5 + 1.25', {})).toBe(1.75);
  });

  it('supports power, functions, and the pi constant', () => {
    expect(evaluateExpression('2 ^ 10', {})).toBe(1024);
    expect(evaluateExpression('2 ^ 3 ^ 2', {})).toBe(512);
    expect(evaluateExpression('sqrt(81)', {})).toBe(9);
    expect(evaluateExpression('min(3, 8, -2)', {})).toBe(-2);
    expect(evaluateExpression('max(width, height)', scope)).toBe(10);
    expect(evaluateExpression('sin(30)', {})).toBeCloseTo(0.5, 10);
    expect(evaluateExpression('cos(60)', {})).toBeCloseTo(0.5, 10);
    expect(evaluateExpression('round(2.6)', {})).toBe(3);
    expect(evaluateExpression('pi', {})).toBeCloseTo(Math.PI, 12);
    expect(evaluateExpression('2 * pi * 10', {})).toBeCloseTo(62.8318, 3);
    expect(evaluateExpression('-2 ^ 2', {})).toBe(-4);
    expect(evaluateExpression('(-2) ^ 2', {})).toBe(4);
    expect(evaluateExpression('2 ^ -2', {})).toBe(0.25);
    expect(evaluateExpression('2e3 + 5e-1', {})).toBe(2000.5);
  });

  it('resolves identifiers from the provided scope', () => {
    expect(evaluateExpression('width * height / 2', scope)).toBe(20);
    expect(evaluateExpression('width - (height + 1)', scope)).toBe(5);
  });

  it('rejects unknown identifiers instead of touching globals', () => {
    expect(() => evaluateExpression('globalThis', scope)).toThrow(
      /Unknown identifier/
    );
    expect(() => evaluateExpression('alert(1)', scope)).toThrow();
  });

  it('rejects malformed expressions', () => {
    expect(() => evaluateExpression('1 +', {})).toThrow();
    expect(() => evaluateExpression('(1 + 2', {})).toThrow();
    expect(() => evaluateExpression('1 ; 2', {})).toThrow(
      /Unexpected character/
    );
    expect(() => evaluateExpression('1 / 0', {})).toThrow(/finite/);
    expect(() => evaluateExpression('sqrt(4, 9)', {})).toThrow(/one argument/);
    expect(() => evaluateExpression('nope(1)', {})).toThrow(/Unknown function/);
  });
});

describe('sanitizeFileName', () => {
  it('strips path segments and hostile characters', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\temp\\part one.step')).toBe('part-one.step');
    expect(sanitizeFileName('weird\u0001name.stl')).toBe('weirdname.stl');
    expect(sanitizeFileName('....///')).toBe('upload');
    expect(sanitizeFileName('model (v2).stl')).toBe('model-v2-.stl');
  });

  it('caps the length', () => {
    expect(
      sanitizeFileName(`${'a'.repeat(300)}.stl`).length
    ).toBeLessThanOrEqual(128);
  });
});

describe('revolve angle', () => {
  const withProfile = () =>
    addSketchFeature(createProjectDocument('Revolve', toUserId('user_test')), {
      name: 'Profile',
      plane: 'XZ',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 1,
        height: 1,
        centerX: 2.5,
        centerY: 0.5
      }
    }).document;

  const revolveData = (document: ReturnType<typeof withProfile>) => {
    const feature = listFeaturesInOrder(document).find(
      (node) => node.data.featureKind === 'revolve'
    )!;
    return feature.data.featureKind === 'revolve' ? feature.data : undefined;
  };

  it('omits the angle entirely when none is asked for', () => {
    const base = withProfile();
    const document = revolveSketch(base, {
      name: 'Ring',
      sketchId: getLatestSketchId(base)!,
      axis: 'vertical'
    }).document;
    // Not `angleDeg: 360`, but no key at all: a full revolve authored today
    // has to be indistinguishable from one authored before the field existed,
    // so it keeps its ADR-013 semantic lineage.
    expect(revolveData(document)).not.toHaveProperty('angleDeg');
  });

  it('stores an angle, including an expression, when one is asked for', () => {
    const base = withProfile();
    for (const angleDeg of [90, 337.5, 'sweep / 2'] as const) {
      const document = revolveSketch(base, {
        name: 'Wedge',
        sketchId: getLatestSketchId(base)!,
        axis: 'vertical',
        angleDeg
      }).document;
      expect(revolveData(document)?.angleDeg).toBe(angleDeg);
    }
  });

  it('survives normalizeDocument without gaining a default', () => {
    const base = withProfile();
    const document = normalizeDocument(
      revolveSketch(base, {
        name: 'Ring',
        sketchId: getLatestSketchId(base)!,
        axis: 'vertical'
      }).document
    );
    expect(revolveData(document)).not.toHaveProperty('angleDeg');
  });
});

describe('cloneDocument derived sharing', () => {
  it('shares derived by reference and deep-copies canonical content', () => {
    // Derived state is a rebuildable projection carrying the mesh arrays;
    // deep-copying it on every command was the dominant per-edit allocation
    // and multiplied through the undo history. It is never mutated in place
    // (attachDerivedState replaces the whole field), so sharing is safe.
    const document = addPrimitiveFeature(
      createProjectDocument('Clone sharing', toUserId('user_clone')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 5, depth: 2 }
      }
    );
    const clone = cloneDocument(document);

    expect(clone.derived).toBe(document.derived);
    expect(clone.nodes).not.toBe(document.nodes);
    expect(clone.featureOrder).not.toBe(document.featureOrder);
    expect(clone).not.toBe(document);
    expect(clone.nodes).toEqual(document.nodes);
  });
});
