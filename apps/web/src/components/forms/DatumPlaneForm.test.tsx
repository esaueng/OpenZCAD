import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  addDatumPlane,
  createProjectDocument,
  findFeature
} from '@openzcad/document-core';
import {
  toBodyId,
  toUserId,
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
