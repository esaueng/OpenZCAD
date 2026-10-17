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
  type FeatureId
} from '@openzcad/shared';
import { DatumPlaneCard } from './DatumPlaneForm';
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
      'Picked face'
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
