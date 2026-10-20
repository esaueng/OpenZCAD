import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  toBodyId,
  type DatumAxisEdgeSource,
  type DatumAxisFaceSource,
  type FeatureId
} from '@openzcad/shared';
import { newCanonicalPlaneRef } from '@openzcad/geometry';
import { DatumAxisForm, type DatumAxisPick } from './DatumAxisForm';
import {
  newDatumAxisFormState,
  type DatumAxisSubmission
} from '../../lib/datumAxes';

/**
 * R01: the Axis card authors each of the four constructors, fills the slot
 * its mode asks for from a viewport pick, says why a pick cannot serve, and
 * commits nothing until the exact check passes.
 */

const planes = (['XY', 'XZ', 'YZ'] as const).map((plane) => {
  const source = newCanonicalPlaneRef(plane, 0);
  return {
    key: `canonical:${plane}`,
    label: { XY: 'Top (XY)', XZ: 'Front (XZ)', YZ: 'Right (YZ)' }[plane],
    source
  };
});

const edge: DatumAxisEdgeSource = {
  type: 'edge',
  bodyId: toBodyId('body_block'),
  edgeReference: {
    kind: 'edge',
    producingFeatureId: 'feat_block' as FeatureId,
    lineageName: 'edge.side',
    currentHash: 7,
    witnessVersion: 1,
    witness: {
      curveType: 'LINE',
      length: 20_000_000,
      closed: false,
      endpoints: [
        [20_000_000, 0, 0],
        [20_000_000, 0, 20_000_000]
      ],
      midpoint: [20_000_000, 0, 10_000_000]
    }
  }
};

const face: DatumAxisFaceSource = {
  type: 'face',
  bodyId: toBodyId('body_post'),
  faceReference: {
    kind: 'face',
    producingFeatureId: 'feat_post' as FeatureId,
    lineageName: 'face.side',
    currentHash: 9,
    witnessVersion: 1,
    witness: {
      surfaceType: 'cylinder',
      perimeter: 1,
      centroid: null,
      analytic: { kind: 'none' },
      closure: { u: 'closed', v: 'open' }
    }
  }
};

function renderForm(pick: DatumAxisPick | null = null) {
  const onPreflight = vi.fn(async () => ({ status: 'ready' as const }));
  const onSubmit = vi.fn();
  const view = render(
    <DatumAxisForm
      initial={newDatumAxisFormState('Axis 1')}
      planes={planes}
      scope={{}}
      pick={pick}
      onPreflight={onPreflight}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />
  );
  return { ...view, onPreflight, onSubmit };
}

afterEach(cleanup);

describe('Axis card (R01)', () => {
  it('creates an axis through two typed points only after the check', async () => {
    const { onPreflight, onSubmit } = renderForm();
    expect(screen.getByLabelText('Name')).toHaveValue('Axis 1');
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('From point'), {
      target: { value: 'typed' }
    });
    fireEvent.change(screen.getByLabelText('To point'), {
      target: { value: 'typed' }
    });
    // Two points at the origin are the same point.
    expect(screen.getByText(/two different points/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('To point Z'), {
      target: { value: '10' }
    });
    fireEvent.click(screen.getByLabelText('Reverse direction'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submission = {
      name: 'Axis 1',
      definition: {
        kind: 'two-point',
        points: [
          { type: 'point', point: { x: 0, y: 0, z: 0 } },
          { type: 'point', point: { x: 0, y: 0, z: 10 } }
        ],
        reverseDirection: true
      }
    };
    expect(onPreflight).toHaveBeenCalledWith(submission);
    expect(onSubmit).toHaveBeenCalledWith(submission);
  });

  it('meets two chosen planes and refuses the same plane twice', async () => {
    const { onSubmit } = renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Two planes' }));
    fireEvent.change(screen.getByLabelText('Plane A'), {
      target: { value: 'canonical:XZ' }
    });
    fireEvent.change(screen.getByLabelText('Plane B'), {
      target: { value: 'canonical:XZ' }
    });
    expect(screen.getByText(/needs two different planes/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Plane B'), {
      target: { value: 'canonical:YZ' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(
      (onSubmit.mock.calls[0]![0] as DatumAxisSubmission).definition
    ).toEqual({
      kind: 'plane-intersection',
      sources: [planes[1]!.source, planes[2]!.source]
    });
  });

  it('takes a picked straight edge, and says why a curved one cannot serve', async () => {
    const pick = (
      key: string,
      value: DatumAxisPick['edge']
    ): DatumAxisPick => ({
      key,
      edge: value,
      vertex: null,
      revolution: null,
      plane: null
    });
    const { rerender, onSubmit, onPreflight } = renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Along edge' }));
    const props = {
      initial: newDatumAxisFormState('Axis 1'),
      planes,
      scope: {},
      onPreflight,
      onSubmit,
      onCancel: vi.fn()
    };
    rerender(
      <DatumAxisForm
        {...props}
        pick={pick('curved', {
          reason: 'An axis runs along a straight edge; this edge is curved.'
        })}
      />
    );
    expect(screen.getByText(/this edge is curved/)).toBeInTheDocument();
    rerender(<DatumAxisForm {...props} pick={pick('straight', edge)} />);
    expect(screen.getByText('Along Picked edge')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(
      (onSubmit.mock.calls[0]![0] as DatumAxisSubmission).definition
    ).toEqual({
      kind: 'edge',
      source: edge
    });
  });

  it('takes a picked cylinder for its axis', async () => {
    const { rerender, onSubmit, onPreflight } = renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Cylinder axis' }));
    rerender(
      <DatumAxisForm
        initial={newDatumAxisFormState('Axis 1')}
        planes={planes}
        scope={{}}
        pick={{
          key: 'post',
          edge: null,
          vertex: null,
          revolution: face,
          plane: null
        }}
        onPreflight={onPreflight}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(
      (onSubmit.mock.calls[0]![0] as DatumAxisSubmission).definition
    ).toEqual({
      kind: 'cylinder',
      source: face
    });
  });

  it('shows the build’s refusal and commits nothing', async () => {
    const onPreflight = vi.fn(async () => ({
      status: 'refused' as const,
      reason:
        'Feature "Axis 1": An axis where two planes meet needs planes that are not parallel; these are parallel.'
    }));
    const onSubmit = vi.fn();
    render(
      <DatumAxisForm
        initial={{
          ...newDatumAxisFormState('Axis 1'),
          mode: 'plane-intersection',
          sourceA: planes[0]!.source,
          sourceB: { type: 'datum', datumFeatureId: 'feat_lid' as FeatureId }
        }}
        planes={planes}
        scope={{}}
        onPreflight={onPreflight}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(
      await screen.findByText(/Not created — An axis where two planes meet/)
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
