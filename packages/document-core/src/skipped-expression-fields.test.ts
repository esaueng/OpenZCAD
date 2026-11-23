import { describe, expect, it } from 'vitest';
import {
  toUserId,
  type DocumentNode,
  type FeatureData,
  type ProjectDocument,
  type SketchConstraintData,
  type SketchNode,
  type SketchPromotion
} from '@openzcad/shared';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  findParameterReferences,
  newTypedParameterMisuse,
  parameterQuantityRefusal,
  renameParameter,
  setParameter,
  suggestParameterQuantity,
  typedParameterMisuse
} from './index';
import { rewriteNodeExpressions } from './parameter-expressions';

/**
 * I03 follow-up to #1955: four expression fields the hand-written visitor
 * skipped, so a parameter rename stranded them and F05 never checked them —
 * a tapped hole's thread `length` and `clearance` (lengths, read as a
 * Thread's), a sketch pattern's `layout.spacing` (a length) and
 * `layout.stepDeg` (degrees). They now behave like a hole's `diameter` or a
 * distance constraint's `value`. A promotion's `sourceData` stays the
 * verbatim, unvisited record S04 keeps (see `UnvisitedQuantity`).
 */

const blank = () =>
  createProjectDocument('Skipped fields', toUserId('user_i03_skipped'));

/** `len` a length, `turn` an angle, `n` untyped. */
function withParameters(): ProjectDocument {
  let document = setParameter(blank(), {
    name: 'len',
    expression: '8 mm',
    quantity: 'length'
  });
  document = setParameter(document, {
    name: 'turn',
    expression: '30 deg',
    quantity: 'angle'
  });
  return setParameter(document, { name: 'n', expression: '4' });
}

function onlyNode<K extends DocumentNode['kind']>(
  document: ProjectDocument,
  kind: K
): Extract<DocumentNode, { kind: K }> {
  const nodes = Object.values(document.nodes).filter(
    (node): node is Extract<DocumentNode, { kind: K }> => node.kind === kind
  );
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

/** A tapped hole whose thread length and clearance read the given text. */
function tappedHole(
  document: ProjectDocument,
  tapped: { length: string; clearance: string },
  diameter = '5'
): ProjectDocument {
  const next = addPrimitiveFeature(structuredClone(document), {
    name: 'Hole',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  const feature = onlyNode(next, 'feature');
  feature.data = {
    featureKind: 'hole',
    targetBodyId: 'body',
    faceHash: 0,
    style: 'simple',
    diameter,
    depthMode: 'blind',
    depth: 10,
    position: { u: 0, v: 0 },
    tapped: { ...tapped, cosmetic: false }
  } as unknown as FeatureData;
  return next;
}

function hole(document: ProjectDocument) {
  const feature = onlyNode(document, 'feature');
  if (feature.data.featureKind !== 'hole') throw new Error('expected a hole');
  return feature.data;
}

/** A sketch holding a linear and a circular pattern relation. */
function patternedSketch(
  document: ProjectDocument,
  spacing: string,
  stepDeg: string
): ProjectDocument {
  const next = addSketchFeature(document, {
    name: 'Sketch',
    objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }]
  }).document;
  const sketch = onlyNode(next, 'sketch');
  const patterns: SketchConstraintData[] = [
    {
      constraintKind: 'pattern',
      source: 'a',
      instances: [{ objectId: 'b', step: 1 }],
      layout: { kind: 'linear', direction: 'c', spacing }
    } as SketchConstraintData,
    {
      constraintKind: 'pattern',
      source: 'a',
      instances: [{ objectId: 'b', step: 1 }],
      layout: {
        kind: 'circular',
        pivot: { objectId: 'c', point: 'start' },
        stepDeg,
        orientation: 'rotate'
      }
    } as SketchConstraintData
  ];
  sketch.constraints = patterns.map((data, index) => ({
    constraintId: `pattern-${index}` as never,
    data
  }));
  return next;
}

function layouts(document: ProjectDocument) {
  return (onlyNode(document, 'sketch').constraints ?? []).map(
    ({ data }) => data.constraintKind === 'pattern' && data.layout
  );
}

describe('a tapped hole thread length and clearance', () => {
  it('are length fields', () => {
    const seen: Record<string, unknown> = {};
    rewriteNodeExpressions(
      onlyNode(
        tappedHole(withParameters(), { length: 'tl', clearance: 'tc' }),
        'feature'
      ),
      (expression, dimension) => {
        seen[expression] = dimension;
        return expression;
      }
    );
    expect(seen).toMatchObject({ tl: 'length', tc: 'length' });
  });

  it('follow a parameter rename', () => {
    const document = tappedHole(withParameters(), {
      length: 'len * 2',
      clearance: 'len / 40'
    });
    const renamed = renameParameter(document, {
      name: 'len',
      newName: 'thread'
    });
    expect(hole(renamed).tapped).toMatchObject({
      length: 'thread * 2',
      clearance: 'thread / 40'
    });
  });

  it.each(['length', 'clearance'] as const)(
    'refuse an angle parameter in %s, as the diameter does',
    (field) => {
      const reads = { length: '6', clearance: '0.1', [field]: 'turn' };
      const before = tappedHole(withParameters(), {
        length: '6',
        clearance: '0.1'
      });
      const after = tappedHole(withParameters(), reads);
      // The same complaint the diameter already raised.
      const control = tappedHole(
        withParameters(),
        { length: '6', clearance: '0.1' },
        'turn'
      );
      expect(newTypedParameterMisuse(before, control)).toMatch(
        /uses "turn": .*expected a length/
      );
      expect(newTypedParameterMisuse(before, after)).toMatch(
        /uses "turn": .*expected a length/
      );
      // The build refuses the hole by name.
      expect(typedParameterMisuse(after)).toEqual([
        expect.objectContaining({
          featureId: onlyNode(after, 'feature').featureId
        })
      ]);
    }
  );

  it.each(['length', 'clearance'] as const)(
    'refuse retyping a parameter %s reads, and suggest its quantity',
    (field) => {
      const reads = { length: '6', clearance: '0.1', [field]: 'n' };
      const document = tappedHole(withParameters(), reads);
      expect(parameterQuantityRefusal(document, 'n', 'angle')).toMatch(
        /uses "n": .*expected a length/
      );
      expect(parameterQuantityRefusal(document, 'n', 'length')).toBeNull();
      expect(suggestParameterQuantity(document, 'n')).toBe('length');
    }
  );
});

describe('a sketch pattern spacing and step angle', () => {
  it('are a length and an angle field', () => {
    const seen: Record<string, unknown> = {};
    rewriteNodeExpressions(
      onlyNode(patternedSketch(withParameters(), 'gap', 'step'), 'sketch'),
      (expression, dimension) => {
        seen[expression] = dimension;
        return expression;
      }
    );
    expect(seen).toMatchObject({ gap: 'length', step: 'angle' });
  });

  it('follow a parameter rename', () => {
    const document = patternedSketch(withParameters(), 'len + 1', 'turn / 2');
    let renamed = renameParameter(document, { name: 'len', newName: 'pitch' });
    renamed = renameParameter(renamed, { name: 'turn', newName: 'sweep' });
    expect(layouts(renamed)).toEqual([
      expect.objectContaining({ spacing: 'pitch + 1' }),
      expect.objectContaining({ stepDeg: 'sweep / 2' })
    ]);
  });

  it('refuse an angle in the spacing and a length in the step angle', () => {
    const before = patternedSketch(withParameters(), '5', '30');
    const badSpacing = patternedSketch(withParameters(), 'turn', '30');
    const badStep = patternedSketch(withParameters(), '5', 'len');
    expect(newTypedParameterMisuse(before, badSpacing)).toMatch(
      /uses "turn": .*expected a length/
    );
    expect(newTypedParameterMisuse(before, badStep)).toMatch(
      /uses "len": .*expected an angle/
    );
    // The right quantities pass, as on a distance or angle constraint.
    expect(
      newTypedParameterMisuse(
        before,
        patternedSketch(withParameters(), 'len', 'turn')
      )
    ).toBeNull();
    // The build refuses the sketch's feature by name.
    expect(typedParameterMisuse(badStep)).toEqual([
      expect.objectContaining({
        featureId: onlyNode(badStep, 'feature').featureId
      })
    ]);
  });

  it('refuse retyping a parameter they read, and suggest its quantity', () => {
    const spaced = patternedSketch(withParameters(), 'n', '30');
    expect(parameterQuantityRefusal(spaced, 'n', 'angle')).toMatch(
      /uses "n": .*expected a length/
    );
    expect(suggestParameterQuantity(spaced, 'n')).toBe('length');
    const stepped = patternedSketch(withParameters(), '5', 'n');
    expect(parameterQuantityRefusal(stepped, 'n', 'length')).toMatch(
      /uses "n": .*expected an angle/
    );
    expect(suggestParameterQuantity(stepped, 'n')).toBe('angle');
  });
});

describe("a promotion's inert source record", () => {
  /** A sketch whose only reader of `n` is a promotion's legacy record. */
  function promoted(): ProjectDocument {
    const document = addSketchFeature(withParameters(), {
      name: 'Sketch',
      objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }]
    }).document;
    const sketch: SketchNode = onlyNode(document, 'sketch');
    sketch.promotions = [
      {
        promotionId: 'promotion',
        version: 1,
        sourceObjectId: 'rectangle',
        sourceData: {
          objectKind: 'rectangle',
          width: 'n * 2',
          height: 'turn',
          centerX: 0,
          centerY: 0
        },
        sourceName: 'Rectangle'
      } as unknown as SketchPromotion
    ];
    return document;
  }
  const record = (document: ProjectDocument) =>
    onlyNode(document, 'sketch').promotions![0]!.sourceData as unknown as {
      width: string;
      height: string;
    };

  it('stays verbatim through a parameter rename, as S04 keeps it', () => {
    let renamed = renameParameter(promoted(), { name: 'n', newName: 'count' });
    renamed = renameParameter(renamed, { name: 'turn', newName: 'lean' });
    expect(record(renamed)).toMatchObject({ width: 'n * 2', height: 'turn' });
  });

  it('never blocks an edit or a build over data nothing reads', () => {
    const document = promoted();
    // `height` reads an angle as a length: hidden, inert, and not a misuse.
    expect(typedParameterMisuse(document)).toEqual([]);
    expect(newTypedParameterMisuse(withParameters(), document)).toBeNull();
    expect(parameterQuantityRefusal(document, 'n', 'angle')).toBeNull();
    expect(findParameterReferences(document, 'n')).toEqual([]);
    expect(suggestParameterQuantity(document, 'n')).toBeNull();
  });
});
