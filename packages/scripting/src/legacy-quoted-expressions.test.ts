import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  setParameter
} from '@openzcad/document-core';
import {
  toUserId,
  type DocumentNode,
  type FeatureData,
  type ProjectDocument,
  type SketchConstraintData
} from '@openzcad/shared';
import { historyModelOf, printHistory, readHistoryText } from './index';

/**
 * Review of #1962: a tapped hole's thread `length` and `clearance` and a
 * sketch pattern's `spacing` and `stepDeg` became expression sites. History
 * text v1 printed before that quoted their expressions (`clearance:
 * "adjust"`); that saved text must still read, while the printer now writes
 * backticks.
 */

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

/** A tapped hole and a patterned sketch reading `adjust` and `step`. */
function sampleDocument(): ProjectDocument {
  let document = createProjectDocument('Legacy', toUserId('user_legacy'));
  document = setParameter(document, { name: 'adjust', expression: '0.1' });
  document = setParameter(document, { name: 'step', expression: '30' });
  document = addPrimitiveFeature(document, {
    name: 'Hole',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  const hole = onlyNode(document, 'feature');
  hole.featureKind = 'hole';
  hole.data = {
    featureKind: 'hole',
    targetBodyId: document.bodyOrder[0],
    faceHash: 0,
    style: 'simple',
    diameter: '5',
    depthMode: 'blind',
    depth: 10,
    position: { u: 0, v: 0 },
    tapped: { length: 'adjust * 60', clearance: 'adjust', cosmetic: false }
  } as unknown as FeatureData;
  document = addSketchFeature(document, {
    name: 'Sketch',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }]
  }).document;
  onlyNode(document, 'sketch').constraints = [
    {
      constraintId: 'pattern-0' as never,
      data: {
        constraintKind: 'pattern',
        source: 'a',
        instances: [{ objectId: 'b', step: 1 }],
        layout: { kind: 'linear', direction: 'c', spacing: 'adjust * 50' }
      } as SketchConstraintData
    },
    {
      constraintId: 'pattern-1' as never,
      data: {
        constraintKind: 'pattern',
        source: 'a',
        instances: [{ objectId: 'b', step: 1 }],
        layout: {
          kind: 'circular',
          pivot: { objectId: 'c', point: 'start' },
          stepDeg: 'step',
          orientation: 'rotate'
        }
      } as SketchConstraintData
    }
  ];
  return document;
}

const SITES = [
  ['length', 'adjust * 60'],
  ['clearance', 'adjust'],
  ['spacing', 'adjust * 50'],
  ['stepDeg', 'step']
] as const;

/** What the printer wrote before these fields were expression sites. */
function legacyText(text: string): string {
  let legacy = text;
  for (const [key, expression] of SITES) {
    const current = `${key}: \`${expression}\``;
    expect(legacy).toContain(current);
    legacy = legacy.replace(current, `${key}: ${JSON.stringify(expression)}`);
  }
  return legacy;
}

describe('history text v1 quoted expressions in fields that became expression sites', () => {
  it('prints backticks and round-trips', () => {
    const document = sampleDocument();
    const text = printHistory(document);
    for (const [key, expression] of SITES) {
      expect(text).toContain(`${key}: \`${expression}\``);
    }
    const read = readHistoryText(text, document);
    expect(read.diagnostics).toEqual([]);
    expect(read.model).toEqual(historyModelOf(document));
  });

  it('reads the legacy quoted spelling at each site to the same document', () => {
    const document = sampleDocument();
    const read = readHistoryText(legacyText(printHistory(document)), document);
    expect(read.diagnostics).toEqual([]);
    expect(read.model).toEqual(historyModelOf(document));
  });

  it('checks a legacy quoted expression like a backtick one when it changes', () => {
    const document = sampleDocument();
    const read = readHistoryText(
      legacyText(printHistory(document)).replace(
        'clearance: "adjust"',
        'clearance: "adjust * 1 deg"'
      ),
      document
    );
    expect(read.diagnostics).toHaveLength(1);
    expect(read.diagnostics[0]!.severity).toBe('error');
    expect(read.diagnostics[0]!.message).toMatch(/expected a length/);
  });

  it('still refuses a quoted string in other expression fields', () => {
    const document = sampleDocument();
    const read = readHistoryText(
      printHistory(document).replace(
        'diameter: `5`',
        'diameter: "adjust * 50"'
      ),
      document
    );
    expect(read.diagnostics).toHaveLength(1);
    expect(read.diagnostics[0]!.severity).toBe('error');
    expect(read.diagnostics[0]!.message).toMatch(/is an expression field/);
  });
});
