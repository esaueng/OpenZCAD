import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  addDatumPlane,
  createProjectDocument,
  findFeature
} from '@openzcad/document-core';
import {
  toBodyId,
  toUserId,
  type EdgeVertexPointSource,
  type FacePlaneSource,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import type { CommandManager } from '@openzcad/command-system';
import {
  DatumPlaneCard,
  DatumPlaneWorkspaceCard,
  type DatumPlaneCardApp
} from './DatumPlaneForm';
import { ModelingOperationsForm } from './ModelingOperationsForm';
import type { DatumPlaneSubmission } from '../../lib/datumPlanes';

const XY = { type: 'canonical', plane: 'XY', offset: 0 } as const;

function documentWithDatum() {
  return addDatumPlane(
    createProjectDocument('Plane card', toUserId('user_plane_card')),
    {
      name: 'Plane 1',
      definition: { kind: 'offset', source: XY, offset: 10 }
    }
  );
}

describe('Plane card (R01-C)', () => {
  it('creates an offset plane on Top (XY) only after the check passes', async () => {
    const onPreflight = vi.fn(async () => ({ status: 'ready' as const }));
    const onSubmit = vi.fn();
    render(
      <DatumPlaneCard
        document={createProjectDocument('New', toUserId('user_plane_card'))}
        editing={null}
        scope={{}}
        pickedFace={null}
        onPreflight={onPreflight}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Name')).toHaveValue('Plane 1');
    expect(screen.getByLabelText('Offset from')).toHaveDisplayValue('Top (XY)');
    fireEvent.change(screen.getByLabelText('Offset'), {
      target: { value: '-4' }
    });
    fireEvent.click(screen.getByLabelText('Flip normal'));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submission = {
      name: 'Plane 1',
      definition: {
        kind: 'offset',
        source: XY,
        offset: -4,
        reverseNormal: true
      }
    };
    expect(onPreflight).toHaveBeenCalledWith(submission);
    expect(onSubmit).toHaveBeenCalledWith(submission);
  });

  it('shows a refusal and creates nothing', async () => {
    const onSubmit = vi.fn();
    render(
      <DatumPlaneCard
        document={documentWithDatum().document}
        editing={null}
        scope={{}}
        pickedFace={null}
        onPreflight={async () => ({
          status: 'refused',
          reason: 'Feature "Plane 2": the planes are not parallel.'
        })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Midplane' }));
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Plane B'), {
      target: { value: 'canonical:YZ' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(
      await screen.findByText('Not created — the planes are not parallel.')
    ).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('offers a picked face and reopens an edited datum with Apply', () => {
    const { document, featureId } = documentWithDatum();
    const face: FacePlaneSource = {
      type: 'face',
      bodyId: toBodyId('body_lid'),
      faceHash: 7,
      faceReference: {
        schemaVersion: 5,
        kind: 'face'
      } as unknown as FacePlaneSource['faceReference'],
      sourceArea: 100,
      sourceCenter: { x: 0, y: 0, z: 20 },
      sourceCentroid: { x: 0, y: 0, z: 20 },
      sourceNormal: { x: 0, y: 0, z: 1 },
      frame: {
        origin: { x: 0, y: 0, z: 20 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        zAxis: { x: 0, y: 0, z: 1 }
      }
    };
    const view = render(
      <DatumPlaneCard
        document={document}
        editing={null}
        scope={{}}
        pickedFace={face}
        onPreflight={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    // A new plane starts on the face the user had picked.
    expect(screen.getByLabelText('Offset from')).toHaveDisplayValue(
      'Picked face 1'
    );
    // In Midplane, a second face picked with the card open becomes plane B
    // and the first stays on offer as A.
    fireEvent.click(screen.getByRole('button', { name: 'Midplane' }));
    view.rerender(
      <DatumPlaneCard
        document={document}
        editing={null}
        scope={{}}
        pickedFace={{ ...face, faceHash: 8 }}
        onPreflight={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Plane A')).toHaveDisplayValue(
      'Picked face 1'
    );
    expect(screen.getByLabelText('Plane B')).toHaveDisplayValue(
      'Picked face 2'
    );
    view.unmount();
    render(
      <DatumPlaneCard
        document={document}
        editing={findFeature(document, featureId)!}
        scope={{}}
        pickedFace={null}
        onPreflight={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Apply' })).toBeVisible();
    expect(screen.getByLabelText('Offset')).toHaveValue('10');
    // An edited datum cannot offer itself as its own source.
    expect(
      screen.queryByRole('option', { name: 'Plane 1' })
    ).not.toBeInTheDocument();
  });
});

describe('Split and Mirror datum picker (R01-C)', () => {
  it('submits the datum by id and keeps it on reopen', async () => {
    const datumFeatureId = 'feat_datum' as FeatureId;
    const bodyId = toBodyId('body_split');
    const onPreflight = vi.fn(async () => ({ status: 'ready' as const }));
    const onSubmit = vi.fn();
    render(
      <ModelingOperationsForm
        operation="split"
        scope={{}}
        bodies={[{ bodyId, name: 'Body', consumed: false }]}
        datumOptions={[{ featureId: datumFeatureId, label: 'Plane 1' }]}
        onPreflight={onPreflight}
        onSubmit={onSubmit}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Plane 1' }));
    expect(screen.getByRole('button', { name: 'Plane 1' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    // The numbers are not consulted for a datum, so they are not offered.
    expect(screen.queryByText('Plane origin')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create split body' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      operation: 'split',
      input: {
        name: 'Split',
        targetBodyId: bodyId,
        plane: { type: 'datum', datumFeatureId }
      }
    });
    // A principal plane replaces the datum.
    fireEvent.click(screen.getByRole('button', { name: 'Top (XY)' }));
    expect(screen.getByText('Plane origin')).toBeVisible();
  });
});

describe('Plane workspace card commit (R01-C)', () => {
  it('withdraws a creation still validating when the card closes', async () => {
    const document = createProjectDocument('Cancel', toUserId('user_plane'));
    const frame = {
      origin: { x: 0, y: 0, z: 10 },
      u: { x: 1, y: 0, z: 0 },
      v: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 }
    };
    const runTransaction = vi.fn(async () => 'committed' as const);
    const app = {
      managerRef: { current: { document } as unknown as CommandManager },
      geometry: {
        // Every datum in the candidate resolves.
        syncOnce: async (candidate: ProjectDocument) => ({
          ...candidate.derived,
          datumFrames: Object.fromEntries(
            candidate.featureOrder.map((id) => [id, frame])
          )
        })
      },
      validatedFeature: { runTransaction },
      ensureCanEdit: () => true,
      newFeatureName: (name: string) => name,
      setStatus: vi.fn(),
      editCardSessionRef: { current: null },
      editSessionIsCurrent: () => true,
      finishFeatureEdit: vi.fn(),
      finishFeatureCreation: vi.fn(),
      validateSelectionEdit: () => true,
      handleDeleteFeature: vi.fn(),
      cancelPanel: vi.fn(),
      closeFeaturePanel: vi.fn()
    } as unknown as DatumPlaneCardApp;
    const view = render(
      <DatumPlaneWorkspaceCard
        document={document}
        editFeature={null}
        scope={{}}
        selection={null}
        editDisabledReason={null}
        exactGeometryReady
        app={app}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(runTransaction).toHaveBeenCalledTimes(1));
    const options = (
      runTransaction.mock.calls[0] as unknown as [
        unknown,
        { cancelled(): boolean }
      ]
    )[1];
    expect(options.cancelled()).toBe(false);
    // Reused to edit an existing datum: no longer the card that asked.
    const { document: withDatum, featureId } = addDatumPlane(document, {
      name: 'Plane 9',
      definition: {
        kind: 'offset',
        source: { type: 'canonical', plane: 'XY', offset: 0 },
        offset: 3
      }
    });
    view.rerender(
      <DatumPlaneWorkspaceCard
        document={withDatum}
        editFeature={findFeature(withDatum, featureId)!}
        scope={{}}
        selection={null}
        editDisabledReason={null}
        exactGeometryReady
        app={app}
      />
    );
    expect(options.cancelled()).toBe(true);
    view.unmount();
    expect(options.cancelled()).toBe(true);

    // A newer draft typed while a commit validates withdraws the old one.
    runTransaction.mockClear();
    render(
      <DatumPlaneWorkspaceCard
        document={document}
        editFeature={null}
        scope={{}}
        selection={null}
        editDisabledReason={null}
        exactGeometryReady
        app={app}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(runTransaction).toHaveBeenCalledTimes(1));
    const pending = (
      runTransaction.mock.calls[0] as unknown as [
        unknown,
        { cancelled(): boolean }
      ]
    )[1];
    expect(pending.cancelled()).toBe(false);
    fireEvent.change(screen.getByLabelText('Offset'), {
      target: { value: '12' }
    });
    expect(pending.cancelled()).toBe(true);
  });
});

describe('Plane card and the viewport handle (R01)', () => {
  it('adds a handle drag to a plain-number offset and leaves an expression alone', () => {
    const { document, featureId } = documentWithDatum();
    const offsetDragRef: { current: ((delta: number) => void) | null } = {
      current: null
    };
    const { unmount } = render(
      <DatumPlaneCard
        document={document}
        editing={findFeature(document, featureId)!}
        scope={{ lid: 7 }}
        pickedFace={null}
        onPreflight={vi.fn(async () => ({ status: 'ready' as const }))}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        offsetDragRef={offsetDragRef}
      />
    );
    expect(screen.getByLabelText('Offset')).toHaveValue('10');
    act(() => offsetDragRef.current?.(2.5));
    expect(screen.getByLabelText('Offset')).toHaveValue('12.5');
    act(() => offsetDragRef.current?.(-0.25));
    expect(screen.getByLabelText('Offset')).toHaveValue('12.25');
    // A sub-thousandth offset keeps its digits through a drag.
    fireEvent.change(screen.getByLabelText('Offset'), {
      target: { value: '0.0004' }
    });
    act(() => offsetDragRef.current?.(1));
    expect(screen.getByLabelText('Offset')).toHaveValue('1.0004');
    fireEvent.change(screen.getByLabelText('Offset'), {
      target: { value: 'lid + 1' }
    });
    act(() => offsetDragRef.current?.(5));
    expect(screen.getByLabelText('Offset')).toHaveValue('lid + 1');
    unmount();
    expect(offsetDragRef.current).toBeNull();
  });

  it('reports the draft Offset only while distance is all that changed', () => {
    const { document, featureId } = documentWithDatum();
    const onOffsetDraft = vi.fn();
    const { unmount } = render(
      <DatumPlaneCard
        document={document}
        editing={findFeature(document, featureId)!}
        scope={{ lid: 7 }}
        pickedFace={null}
        onPreflight={vi.fn(async () => ({ status: 'ready' as const }))}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onOffsetDraft={onOffsetDraft}
      />
    );
    // Reported as the change from the opened offset (10).
    expect(onOffsetDraft).toHaveBeenLastCalledWith(0);
    fireEvent.change(screen.getByLabelText('Offset'), {
      target: { value: '14' }
    });
    expect(onOffsetDraft).toHaveBeenLastCalledWith(4);
    // An expression cannot be drawn ahead of its evaluation.
    fireEvent.change(screen.getByLabelText('Offset'), {
      target: { value: 'lid + 1' }
    });
    expect(onOffsetDraft).toHaveBeenLastCalledWith(null);
    fireEvent.change(screen.getByLabelText('Offset'), {
      target: { value: '3' }
    });
    expect(onOffsetDraft).toHaveBeenLastCalledWith(-7);
    // Flipping the normal changes more than the distance.
    fireEvent.click(screen.getByLabelText('Flip normal'));
    expect(onOffsetDraft).toHaveBeenLastCalledWith(null);
    unmount();
    expect(onOffsetDraft).toHaveBeenLastCalledWith(null);
  });

  it("focuses its Offset for the handle's exact entry", () => {
    const { document, featureId } = documentWithDatum();
    const offsetEntryRef: { current: (() => boolean) | null } = {
      current: null
    };
    const { unmount } = render(
      <DatumPlaneCard
        document={document}
        editing={findFeature(document, featureId)!}
        scope={{}}
        pickedFace={null}
        onPreflight={vi.fn(async () => ({ status: 'ready' as const }))}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        offsetEntryRef={offsetEntryRef}
      />
    );
    let opened = false;
    act(() => {
      opened = offsetEntryRef.current?.() ?? false;
    });
    expect(opened).toBe(true);
    expect(screen.getByLabelText('Offset')).toHaveFocus();
    unmount();
    expect(offsetEntryRef.current).toBeNull();
  });
});

describe('Plane card: three points and parallel at a point (R01)', () => {
  const vertexEdge = (
    a: [number, number, number],
    b: [number, number, number],
    name: string
  ): EdgeVertexPointSource => ({
    type: 'edge-vertex',
    bodyId: toBodyId('body_block'),
    edgeReference: {
      kind: 'edge',
      producingFeatureId: 'feat_block' as FeatureId,
      lineageName: name,
      currentHash: 1,
      witnessVersion: 1,
      witness: {
        curveType: 'LINE',
        length: 20,
        closed: false,
        // Quantized in the 1e-6 quantum, deliberately out of order.
        endpoints: [b.map((c) => c * 1e6), a.map((c) => c * 1e6)] as never,
        midpoint: [0, 0, 0]
      }
    },
    end: 0
  });

  it('creates a three-point plane from typed positions', async () => {
    const onSubmit = vi.fn<(submission: DatumPlaneSubmission) => void>();
    render(
      <DatumPlaneCard
        document={createProjectDocument('New', toUserId('user_plane_card'))}
        editing={null}
        scope={{ h: 4 }}
        pickedFace={null}
        onPreflight={async () => ({ status: 'ready' as const })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Three points' }));
    expect(
      screen.getByText(/Pick an edge end for the first point/)
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    const typed = (slot: string, x: string, y: string, z: string) => {
      fireEvent.change(screen.getByLabelText(slot), {
        target: { value: 'typed' }
      });
      fireEvent.change(screen.getByLabelText(`${slot} X`), {
        target: { value: x }
      });
      fireEvent.change(screen.getByLabelText(`${slot} Y`), {
        target: { value: y }
      });
      fireEvent.change(screen.getByLabelText(`${slot} Z`), {
        target: { value: z }
      });
    };
    typed('Point 1', '0', '0', 'h');
    typed('Point 2', '0', '0', 'h');
    typed('Point 3', '0', '10', 'h');
    expect(
      screen.getByText('A three-point plane needs three different points.')
    ).toBeVisible();
    typed('Point 2', '10', '0', 'h');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Plane 1',
      definition: {
        kind: 'three-point',
        points: [
          { type: 'point', point: { x: 0, y: 0, z: 'h' } },
          { type: 'point', point: { x: 10, y: 0, z: 'h' } },
          { type: 'point', point: { x: 0, y: 10, z: 'h' } }
        ]
      }
    });
  });

  it('fills point slots from successive edge picks, labelled by position', async () => {
    const document = createProjectDocument(
      'Picks',
      toUserId('user_plane_card')
    );
    const picks = [
      vertexEdge([0, 0, 20], [20, 0, 20], 'edge:a'),
      { ...vertexEdge([0, 0, 20], [20, 0, 20], 'edge:a'), end: 1 as const },
      vertexEdge([0, 20, 20], [20, 20, 20], 'edge:b')
    ];
    const onSubmit = vi.fn<(submission: DatumPlaneSubmission) => void>();
    const props = {
      document,
      editing: null,
      scope: {},
      pickedFace: null,
      onPreflight: async () => ({ status: 'ready' as const }),
      onSubmit,
      onCancel: vi.fn()
    };
    const view = render(<DatumPlaneCard {...props} pickedVertex={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Three points' }));
    for (const pick of picks) {
      view.rerender(<DatumPlaneCard {...props} pickedVertex={pick} />);
    }
    // End 0 sorts first by quantized x: (0, 0, 20) on edge a.
    expect(screen.getByLabelText('Point 1')).toHaveDisplayValue(
      'Picked vertex (0, 0, 20)'
    );
    expect(screen.getByLabelText('Point 2')).toHaveDisplayValue(
      'Picked vertex (20, 0, 20)'
    );
    expect(screen.getByLabelText('Point 3')).toHaveDisplayValue(
      'Picked vertex (0, 20, 20)'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0].definition).toEqual({
      kind: 'three-point',
      points: picks
    });
  });

  it('says why a picked edge cannot give a vertex', () => {
    render(
      <DatumPlaneCard
        document={createProjectDocument('New', toUserId('user_plane_card'))}
        editing={null}
        scope={{}}
        pickedFace={null}
        pickedVertex={{ reason: 'A closed edge has no end vertex.' }}
        onPreflight={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Parallel at point' }));
    expect(screen.getByText('A closed edge has no end vertex.')).toBeVisible();
  });

  it('creates a parallel plane through a point and reopens it for edit', async () => {
    const empty = createProjectDocument(
      'Parallel',
      toUserId('user_plane_card')
    );
    const onSubmit = vi.fn<(submission: DatumPlaneSubmission) => void>();
    render(
      <DatumPlaneCard
        document={empty}
        editing={null}
        scope={{}}
        pickedFace={null}
        onPreflight={async () => ({ status: 'ready' as const })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Parallel at point' }));
    expect(screen.getByLabelText('Parallel to')).toHaveDisplayValue('Top (XY)');
    fireEvent.change(screen.getByLabelText('Through point'), {
      target: { value: 'typed' }
    });
    fireEvent.change(screen.getByLabelText('Through point Z'), {
      target: { value: '7' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const definition = onSubmit.mock.calls[0]![0].definition;
    expect(definition).toEqual({
      kind: 'parallel-point',
      source: XY,
      point: { type: 'point', point: { x: 0, y: 0, z: 7 } }
    });

    const saved = addDatumPlane(empty, { name: 'Lid', definition });
    cleanup();
    render(
      <DatumPlaneCard
        document={saved.document}
        editing={findFeature(saved.document, saved.featureId)!}
        scope={{}}
        pickedFace={null}
        onPreflight={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(
      screen.getByRole('button', { name: 'Parallel at point' })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Through point Z')).toHaveValue('7');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeVisible();
  });
});
