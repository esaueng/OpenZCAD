import { describe, expect, it } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

import {
  CAD_PATCH_JSON_SCHEMA,
  CAD_PATCH_OPERATION_KINDS,
  createCadDocumentDigest,
  describeCadPatchOperation,
  parseCadPatchProposal,
  type CadDigestDrawing,
  type CadDocumentDigest
} from './index';

const drawing: CadDigestDrawing = {
  sheetId: 'dsht_one',
  name: 'Sheet 1',
  units: 'mm',
  scale: '1:1',
  paperMm: { width: 420, height: 297 },
  ready: true,
  views: [
    {
      viewId: 'dvw_front',
      orientation: 'front',
      parentViewId: null,
      centerMm: { x: 100, y: 120 },
      widthMm: 20,
      heightMm: 10,
      bodyIds: ['body_box'],
      edgeInventoryComplete: true,
      edges: [
        {
          ref: 'v1:e1',
          bodyId: 'body_box',
          hash: 11,
          curve: 'line',
          length: 20,
          ends: [
            [-10, 5],
            [10, 5]
          ]
        },
        {
          ref: 'v1:e2',
          bodyId: 'body_box',
          hash: 12,
          curve: 'line',
          length: 10,
          ends: [
            [10, -5],
            [10, 5]
          ]
        },
        {
          ref: 'v1:e3',
          bodyId: 'body_box',
          hash: 13,
          curve: 'circle',
          length: 18.85,
          center: [0, 0],
          radius: 3,
          faceOn: true
        },
        {
          ref: 'v1:e4',
          bodyId: 'body_box',
          hash: 14,
          curve: 'circle',
          length: 18.85,
          center: [0, 0],
          radius: 3,
          faceOn: false
        }
      ]
    }
  ],
  annotations: [
    {
      annotationId: 'dann_old',
      kind: 'linear',
      viewId: 'dvw_front',
      edgeRefs: ['v1:e1', 'v1:e1'],
      value: 20,
      label: '20',
      broken: null
    }
  ]
};

function digest(withDrawing: CadDigestDrawing | null = drawing) {
  const base = createCadDocumentDigest(
    createProjectDocument('Plate', toUserId('test')),
    { featureIds: [], bodyIds: [], topologies: [] }
  );
  const out: CadDocumentDigest = withDrawing
    ? { ...base, drawing: withDrawing }
    : base;
  return out;
}

const width = {
  annotationKind: 'linear',
  viewId: 'dvw_front',
  direction: 'horizontal',
  from: { edgeRef: 'v1:e1', anchor: 'first' },
  to: { edgeRef: 'v1:e1', anchor: 'second' },
  edgeRefs: [],
  text: null,
  placementMm: { x: 0, y: 12 },
  decimals: null
};
const height = {
  ...width,
  direction: 'vertical',
  from: { edgeRef: 'v1:e2', anchor: 'first' },
  to: { edgeRef: 'v1:e2', anchor: 'second' },
  placementMm: { x: 18, y: 0 }
};
const hole = {
  annotationKind: 'diameter',
  viewId: 'dvw_front',
  direction: null,
  from: null,
  to: null,
  edgeRefs: ['v1:e3'],
  text: null,
  placementMm: { x: 8, y: 8 },
  decimals: 1
};

function proposal(...operations: unknown[]) {
  return {
    proposalId: 'p1',
    summary: 'Dimension the plate',
    assumptions: [],
    preserveGeometry: false,
    operations
  };
}

const add = (...annotations: unknown[]) => ({
  kind: 'add_drawing_annotations',
  sheetId: 'dsht_one',
  annotations
});

describe('drawing annotation operations (D06 slice E)', () => {
  it('offers both operations under the strict schema rules', () => {
    expect(CAD_PATCH_OPERATION_KINDS).toEqual(
      expect.arrayContaining([
        'add_drawing_annotations',
        'remove_drawing_annotations'
      ])
    );
    const strict = (schema: unknown): void => {
      if (!schema || typeof schema !== 'object') return;
      const record = schema as Record<string, unknown>;
      if (record.type === 'object' && record.properties) {
        expect(record.additionalProperties).toBe(false);
        expect([...(record.required as string[])].sort()).toEqual(
          Object.keys(record.properties).sort()
        );
      }
      Object.values(record).forEach((value) =>
        Array.isArray(value) ? value.forEach(strict) : strict(value)
      );
    };
    const variants = CAD_PATCH_JSON_SCHEMA.properties.operations.items.anyOf;
    variants
      .filter((variant) =>
        String(variant.properties.kind.const).includes('drawing')
      )
      .forEach(strict);
  });

  it('grounds each edge ref in the digest', () => {
    const parsed = parseCadPatchProposal(
      proposal(add(width, height, hole)),
      digest()
    );
    const operation = parsed.operations[0]!;
    expect(operation.kind).toBe('add_drawing_annotations');
    if (operation.kind !== 'add_drawing_annotations') return;
    expect(operation.edges).toEqual({
      'v1:e1': { bodyId: 'body_box', hash: 11 },
      'v1:e2': { bodyId: 'body_box', hash: 12 },
      'v1:e3': { bodyId: 'body_box', hash: 13 }
    });
    expect(describeCadPatchOperation(operation)).toBe(
      'Add 3 dimensions to the sheet'
    );
    // A grounded proposal (the Worker's, or a reload) parses again as is.
    expect(parseCadPatchProposal(parsed, digest())).toEqual(parsed);
    expect(parseCadPatchProposal(parsed)).toEqual(parsed);
  });

  it('refuses an edge the digest does not list', () => {
    expect(() =>
      parseCadPatchProposal(
        proposal(
          add({ ...width, from: { edgeRef: 'v1:e99', anchor: 'first' } })
        ),
        digest()
      )
    ).toThrow(/v1:e99.*does not list/);
  });

  it('refuses a grounded edge that disagrees with the digest', () => {
    const forged = {
      ...add(width),
      edges: { 'v1:e1': { bodyId: 'body_box', hash: 99 } }
    };
    expect(() => parseCadPatchProposal(proposal(forged), digest())).toThrow(
      /differently/
    );
  });

  it('checks each kind against what its edges can measure', () => {
    const refuse = (spec: unknown, pattern: RegExp) =>
      expect(() =>
        parseCadPatchProposal(proposal(add(spec)), digest())
      ).toThrow(pattern);
    refuse({ ...hole, edgeRefs: ['v1:e4'] }, /true shape/);
    refuse({ ...hole, edgeRefs: ['v1:e1'] }, /true shape/);
    refuse(
      { ...width, from: { edgeRef: 'v1:e1', anchor: 'center' } },
      /anchor "center"/
    );
    refuse(
      { ...width, to: { edgeRef: 'v1:e3', anchor: 'second' } },
      /open edge/
    );
    refuse(
      {
        ...hole,
        annotationKind: 'angle',
        decimals: null,
        edgeRefs: ['v1:e1', 'v1:e3']
      },
      /not straight/
    );
  });

  it('refuses malformed specs before any digest is read', () => {
    const refuse = (spec: unknown, pattern: RegExp) =>
      expect(() => parseCadPatchProposal(proposal(add(spec)))).toThrow(pattern);
    refuse({ ...width, viewId: null }, /names no view/);
    refuse({ ...width, direction: null }, /direction/);
    refuse({ ...width, edgeRefs: ['v1:e1'] }, /from and to/);
    refuse({ ...hole, direction: 'horizontal' }, /only a linear/);
    refuse({ ...hole, edgeRefs: [] }, /exactly one/);
    refuse({ ...hole, decimals: 9 }, /decimals/);
    refuse({ ...hole, text: 'hi' }, /only a note/);
    refuse(
      { ...hole, annotationKind: 'note', text: ' ', decimals: null },
      /needs text/
    );
    refuse({ ...width, placementMm: { x: Infinity, y: 0 } }, /placementMm/);
  });

  it('scopes a proposal to the sheet the user is on', () => {
    expect(() =>
      parseCadPatchProposal(
        proposal({ ...add(width), sheetId: 'dsht_other' }),
        digest()
      )
    ).toThrow(/not the sheet/);
    expect(() =>
      parseCadPatchProposal(proposal(add(width)), digest(null))
    ).toThrow(/Draw workspace/);
    expect(() =>
      parseCadPatchProposal(
        proposal(add(width)),
        digest({ ...drawing, ready: false })
      )
    ).toThrow(/Update it/);
    expect(() =>
      parseCadPatchProposal(
        proposal(add(width), { ...add(height), sheetId: 'dsht_two' })
      )
    ).toThrow(/one sheet/);
  });

  it('never mixes a sheet edit with a model edit', () => {
    expect(() =>
      parseCadPatchProposal(
        proposal(add(width), {
          kind: 'rename_feature',
          featureId: 'feature_box',
          name: 'Plate'
        })
      )
    ).toThrow(/either the model or a drawing sheet/);
  });

  it('removes only annotations on the sheet', () => {
    const remove = (annotationIds: string[]) =>
      proposal({
        kind: 'remove_drawing_annotations',
        sheetId: 'dsht_one',
        annotationIds
      });
    const parsed = parseCadPatchProposal(remove(['dann_old']), digest());
    expect(describeCadPatchOperation(parsed.operations[0]!)).toBe(
      'Remove 1 annotation from the sheet'
    );
    expect(() =>
      parseCadPatchProposal(remove(['dann_gone']), digest())
    ).toThrow(/not on the sheet/);
    expect(() =>
      parseCadPatchProposal(remove(['dann_old', 'dann_old']))
    ).toThrow(/Invalid remove_drawing_annotations/);
  });
});
