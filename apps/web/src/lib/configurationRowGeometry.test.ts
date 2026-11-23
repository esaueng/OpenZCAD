import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  addConfigurationColumn,
  addConfigurationRow,
  addPrimitiveFeature,
  createConfigurations,
  createProjectDocument,
  listParameters,
  setConfigurationCell,
  setParameter
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type GeometryReadyState,
  type ProjectDocument
} from '@openzcad/shared';
import {
  currentConfigurationRow,
  useConfigurationRowGeometry,
  type BuildRowGeometry
} from './configurationRowGeometry';
import { planarFaceTarget, selectionBodies } from './planarFaceTarget';

function plate(): ProjectDocument {
  let document = createProjectDocument('Plate', toUserId('user_rows'));
  document = setParameter(document, { name: 'width', expression: '20' });
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 10, depth: 4 }
  });
  document = createConfigurations(document, { rowId: 'small', name: 'Small' });
  document = addConfigurationColumn(document, {
    column: { kind: 'parameter', parameterId: widthId(document) }
  });
  document = addConfigurationRow(document, { rowId: 'large', name: 'Large' });
  return largeWidth(document, '45');
}

function widthId(document: ProjectDocument) {
  return listParameters(document).find((p) => p.name === 'width')!.parameterId;
}

function largeWidth(document: ProjectDocument, value: string) {
  return setConfigurationCell(document, {
    rowId: 'large',
    column: { kind: 'parameter', parameterId: widthId(document) },
    value
  });
}

const ready = {
  bodyRepresentations: {},
  warnings: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
  analysis: 'pending'
} as GeometryReadyState;

describe('a configuration row build an export reads', () => {
  it('is only the build of the row as the document now stands', async () => {
    let finish: (() => void) | undefined;
    let calls = 0;
    const build: BuildRowGeometry = () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(ready);
      // The second build is still running.
      return new Promise((resolve) => {
        finish = () => resolve(ready);
      });
    };
    const first = plate();
    const { result, rerender } = renderHook(
      ({ document }) => useConfigurationRowGeometry(document, ['large'], build),
      { initialProps: { document: first } }
    );
    await waitFor(() =>
      expect(currentConfigurationRow(result.current, 'large')).not.toBeNull()
    );
    expect(
      listParameters(currentConfigurationRow(result.current, 'large')!).find(
        (p) => p.name === 'width'
      )!.expression
    ).toBe('45');

    // Large changes while the model rebuilds: the old build stays drawn,
    // but nothing that must match the model may read it.
    rerender({ document: largeWidth(first, '60') });
    await waitFor(() => expect(finish).toBeDefined());
    expect(result.current.builds.get('large')).toBeDefined();
    expect(currentConfigurationRow(result.current, 'large')).toBeNull();

    await act(async () => {
      finish!();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(currentConfigurationRow(result.current, 'large')).not.toBeNull()
    );
    expect(
      listParameters(currentConfigurationRow(result.current, 'large')!).find(
        (p) => p.name === 'width'
      )!.expression
    ).toBe('60');
  });
});

describe('a planar face picked on another configuration row', () => {
  const bodyId = 'body_plate' as BodyId;
  const body = (topologyId: string) =>
    ({
      bodyId,
      name: 'Plate',
      topology: {
        faces: [
          {
            topologyId,
            hash: 7,
            triangleCount: 2,
            geometry: {
              surfaceType: 'plane',
              center: { x: 0, y: 0, z: 4 },
              normal: { x: 0, y: 0, z: 1 }
            }
          }
        ],
        edges: []
      }
    }) as unknown as ProjectDocument['derived']['bodyRepresentations'][BodyId];
  const selection = {
    kind: 'face' as const,
    bodyId,
    topologyId: 'face_row_only',
    hash: 99
  };

  it('resolves against the shown row’s bodies, not the active row’s', () => {
    // The active row builds the plate without that face.
    const active = { [bodyId]: body('face_other') };
    const shown = {
      derived: { bodyRepresentations: { [bodyId]: body('face_row_only') } }
    } as unknown as ProjectDocument;
    expect(planarFaceTarget(active, selection)).toBe(null);
    expect(
      planarFaceTarget(selectionBodies(active, false, shown), selection)
    ).toMatchObject({ bodyId, topologyId: 'face_row_only' });
    // A preview replaces the model wholesale, and no row is shown.
    expect(selectionBodies(active, true, shown)).toBe(active);
    expect(selectionBodies(active, false, null)).toBe(active);
  });
});
