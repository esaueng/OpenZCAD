import { describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  deleteParameter,
  expressionIdentifiers,
  extrudeSketch,
  findParameterReferences,
  findSketch,
  listParameters,
  setParameter
} from '@openzcad/document-core';
import { commandFactories, replayCommands } from '@openzcad/command-system';
import { toUserId } from '@openzcad/shared';

/**
 * Deleting a parameter used to strand every expression that read it. A broken
 * feature at least reports a build error on its own row with the typed text
 * still there; a sketch dimension does not — the constraint keeps a name that
 * no longer resolves, the solve quietly stops moving the geometry, and the
 * panel shows nothing about which parameter went missing.
 */

const USER = toUserId('user_param_refs');

function documentWithSketch() {
  let document = createProjectDocument('Refs', USER, 'mm');
  document = setParameter(document, { name: 'span', expression: '40' });
  document = setParameter(document, { name: 'unused', expression: '7' });
  const created = addSketchFeature(document, {
    name: 'Profile',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { objectKind: 'line', x1: 20, y1: 0, x2: 30, y2: 0 }
    ]
  });
  return { document: created.document, sketchId: created.sketchId };
}

function withDrivingDistance() {
  const { document, sketchId } = documentWithSketch();
  const sketch = findSketch(document, sketchId)!;
  const [a, b] = sketch.objectIds;
  const command = commandFactories.addSketchConstraint({
    sketchId,
    constraint: {
      constraintKind: 'distance',
      a: { objectId: a!, point: 'start' },
      b: { objectId: b!, point: 'end' },
      value: 'span'
    }
  });
  command.validate(document);
  return { document: command.apply(document), sketchId };
}

describe('expressionIdentifiers', () => {
  it('reads scope variables and ignores functions and constants', () => {
    expect(expressionIdentifiers('span * 2')).toEqual(['span']);
    expect(expressionIdentifiers('max(wall, pi) + sqrt(span)')).toEqual([
      'wall',
      'span'
    ]);
    expect(expressionIdentifiers('12')).toEqual([]);
  });

  it('reads nothing out of text that is not an expression', () => {
    expect(expressionIdentifiers('open-sans')).toEqual(['open', 'sans']);
    expect(expressionIdentifiers("a string with 'quotes")).toEqual([]);
  });
});

describe('findParameterReferences', () => {
  it('finds a driving sketch dimension', () => {
    const { document } = withDrivingDistance();
    const references = findParameterReferences(document, 'span');
    expect(references).toHaveLength(1);
    expect(references[0]!.label).toBe('Sketch "Profile"');
    expect(references[0]!.expressions).toEqual(['span']);
  });

  it('finds a feature dimension and another parameter', () => {
    const created = documentWithSketch();
    const sketchId = created.sketchId;
    let document = created.document;
    document = setParameter(document, {
      name: 'wall',
      expression: 'span / 4'
    });
    document = extrudeSketch(document, {
      name: 'Wall',
      sketchId,
      distance: 'span * 2'
    }).document;
    const labels = findParameterReferences(document, 'span').map(
      (reference) => reference.label
    );
    expect(labels).toContain('Parameter "wall"');
    expect(labels).toContain('Feature "Wall"');
  });

  it('ignores ids, enum discriminants, and unrelated parameters', () => {
    const { document } = withDrivingDistance();
    // 'unused' is a real parameter that nothing reads. If the walk counted
    // any string that merely tokenizes, sketch ids and plane names would
    // show up here.
    expect(findParameterReferences(document, 'unused')).toEqual([]);
  });

  it('does not count a parameter reading itself', () => {
    let document = createProjectDocument('Self', USER, 'mm');
    document = setParameter(document, { name: 'w', expression: '3' });
    document = setParameter(document, { name: 'w', expression: '2 * 4' });
    expect(findParameterReferences(document, 'w')).toEqual([]);
  });

  it('reports nothing for a parameter that already fails to evaluate', () => {
    let document = createProjectDocument('Broken', USER, 'mm');
    document = setParameter(document, { name: 'a', expression: 'b + 1' });
    document = setParameter(document, { name: 'b', expression: 'a + 1' });
    // Neither resolves, so no expression anywhere is reading a live value —
    // deleting one repairs the document instead of breaking it.
    expect(findParameterReferences(document, 'a')).toEqual([]);
  });
});

describe('parameter.delete refuses to strand readers', () => {
  it('refuses while a sketch dimension drives from it', () => {
    const { document } = withDrivingDistance();
    const command = commandFactories.deleteParameter({ name: 'span' });
    expect(() => command.validate(document)).toThrow(
      /Cannot delete parameter "span".*Sketch "Profile"/s
    );
  });

  it('allows deleting a parameter nothing reads', () => {
    const { document } = withDrivingDistance();
    const command = commandFactories.deleteParameter({ name: 'unused' });
    expect(() => command.validate(document)).not.toThrow();
    const next = command.apply(document);
    expect(listParameters(next).map((one) => one.name)).toEqual(['span']);
  });

  it('names every holder and counts the rest', () => {
    const created = documentWithSketch();
    const sketchId = created.sketchId;
    let document = created.document;
    for (const name of ['w1', 'w2', 'w3', 'w4']) {
      document = setParameter(document, { name, expression: 'span + 1' });
    }
    document = extrudeSketch(document, {
      name: 'Wall',
      sketchId,
      distance: 'span'
    }).document;
    const command = commandFactories.deleteParameter({ name: 'span' });
    expect(() => command.validate(document)).toThrow(/5 values still read it/);
    expect(() => command.validate(document)).toThrow(/\+2 more/);
  });

  it('still replays a delete recorded before the guard existed', () => {
    // `replayCommands` goes straight to the document-core function without
    // validate, so an older log keeps producing the document it always did.
    const { document } = withDrivingDistance();
    const replayed = replayCommands(document, [
      {
        kind: 'parameter.delete',
        payload: { name: 'span' },
        replayVersion: 1,
        label: 'Delete parameter span',
        timestamp: '2026-01-01T00:00:00.000Z'
      }
    ]);
    expect(listParameters(replayed).map((one) => one.name)).toEqual(['unused']);
    // And the raw document-core function is still unguarded, which is what
    // makes that replay path work.
    expect(() => deleteParameter(document, { name: 'span' })).not.toThrow();
  });
});
