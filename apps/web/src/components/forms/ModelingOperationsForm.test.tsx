import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toBodyId, toSketchId } from '@openzcad/shared';
import type { BodyOption } from './FeatureForms';
import { ModelingOperationsForm } from './ModelingOperationsForm';
import type {
  ModelingOperationSubmission,
  ModelingFaceOption
} from '../../lib/modelingOperations';

const bodyId = toBodyId('body_form');
const bodies: BodyOption[] = [{ bodyId, name: 'Main body', consumed: false }];
const faces: ModelingFaceOption[] = [
  {
    hash: 42,
    topologyId: 'face:42',
    label: 'Plane face box · face · z max · #0000002a',
    surfaceType: 'plane'
  }
];

describe('Modeling operations form', () => {
  it('consumes a viewport Hole pick without losing edited fields or accepting an older preflight', async () => {
    let resolvePreflight: ((value: { status: 'ready' }) => void) | undefined;
    const onPreflight = vi.fn(
      (_submission: ModelingOperationSubmission) =>
        new Promise<{ status: 'ready' }>((resolve) => {
          resolvePreflight = resolve;
        })
    );
    const extraFace = {
      ...faces[0]!,
      hash: 43,
      topologyId: 'face:43',
      label: 'Second plane'
    };
    const props = {
      operation: 'hole' as const,
      scope: {},
      bodies,
      faceOptions: [...faces, extraFace],
      onPreflight,
      onSubmit: vi.fn()
    };
    const view = render(<ModelingOperationsForm {...props} />);
    fireEvent.click(screen.getByRole('button', { name: faces[0]!.label }));
    fireEvent.change(screen.getByLabelText('Diameter'), {
      target: { value: '5' }
    });
    fireEvent.change(screen.getByLabelText('Style'), {
      target: { value: 'countersink' }
    });
    fireEvent.change(screen.getByLabelText('Countersink diameter'), {
      target: { value: '9' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check exact result' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Checking the exact kernel result'
    );

    view.rerender(
      <ModelingOperationsForm
        {...props}
        viewportHoleFacePick={{ bodyId, hash: 43 }}
      />
    );
    expect(
      screen.getByRole('button', { name: `1 ${extraFace.label}` })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Diameter')).toHaveValue('5');
    expect(screen.getByLabelText('Style')).toHaveValue('countersink');
    expect(screen.getByLabelText('Countersink diameter')).toHaveValue('9');
    await act(async () => {
      resolvePreflight?.({ status: 'ready' });
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Check exact result' })
      ).toBeEnabled()
    );
    expect(screen.queryByRole('button', { name: 'Create hole' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check exact result' }));
    expect(onPreflight.mock.calls[1]?.[0]).toMatchObject({
      operation: 'hole',
      input: {
        faceHash: 43,
        diameter: 5,
        style: 'countersink',
        countersinkDiameter: 9
      }
    });
  });

  it('ignores a stale viewport pick for another Hole target and clears the old entry on target change', () => {
    const otherBodyId = toBodyId('other_body');
    const props = {
      operation: 'hole' as const,
      scope: {},
      bodies: [
        ...bodies,
        { bodyId: otherBodyId, name: 'Other body', consumed: false }
      ],
      faceOptions: faces,
      onPreflight: vi.fn(),
      onSubmit: vi.fn()
    };
    const view = render(<ModelingOperationsForm {...props} />);
    fireEvent.click(screen.getByRole('button', { name: faces[0]!.label }));
    fireEvent.change(screen.getByLabelText('Target body'), {
      target: { value: otherBodyId }
    });
    view.rerender(
      <ModelingOperationsForm
        {...props}
        viewportHoleFacePick={{ bodyId, hash: 42 }}
      />
    );
    expect(
      screen.getByRole('button', { name: faces[0]!.label })
    ).toHaveAttribute('aria-pressed', 'false');
    expect(
      screen.getByRole('button', { name: 'Check exact result' })
    ).toBeDisabled();
  });

  it('announces pending and ready preflight before submitting a typed shell', async () => {
    let resolvePreflight: ((value: { status: 'ready' }) => void) | undefined;
    const onPreflight = vi.fn(
      (_submission: ModelingOperationSubmission) =>
        new Promise<{ status: 'ready' }>((resolve) => {
          resolvePreflight = resolve;
        })
    );
    const onSubmit = vi.fn();
    render(
      <ModelingOperationsForm
        operation="shell"
        scope={{ wall: 4 }}
        bodies={bodies}
        faceOptions={faces}
        onPreflight={onPreflight}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: faces[0]!.label }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Wall thickness' }), {
      target: { value: 'wall / 2' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check exact result' }));

    expect(screen.getByRole('status')).toHaveTextContent(
      'Checking the exact kernel result'
    );
    expect(onPreflight).toHaveBeenCalledWith({
      operation: 'shell',
      input: {
        name: 'Shell',
        targetBodyId: bodyId,
        openingFaceHashes: [42],
        thickness: 'wall / 2'
      }
    });

    resolvePreflight?.({ status: 'ready' });
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Exact preflight passed'
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create shell' }));
    expect(onSubmit).toHaveBeenCalledWith(onPreflight.mock.calls[0]![0]);
  });

  it('shows an exact refusal as an alert and does not submit', async () => {
    const onSubmit = vi.fn();
    render(
      <ModelingOperationsForm
        operation="mirror"
        scope={{}}
        bodies={bodies}
        onPreflight={async () => ({
          status: 'refused',
          reason: 'The mirror plane intersects unsupported imported topology.'
        })}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Check exact result' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Exact preflight refused: The mirror plane intersects unsupported imported topology.'
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders a capability refusal verbatim and blocks checking', () => {
    // The form must show whatever reason it is handed, in full: this used to
    // be OpenCascade's convex-planar solid-offset limit, and a refusal that
    // only says "unsupported" is how a user is left with no next step.
    const onPreflight = vi.fn();
    render(
      <ModelingOperationsForm
        operation="solid-offset"
        scope={{}}
        bodies={bodies}
        unsupportedReason="Sharp solid offset is refused because curved, non-convex, or unproven topology cannot be proven correct."
        onPreflight={onPreflight}
        onSubmit={() => undefined}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'curved, non-convex, or unproven topology cannot be proven correct'
    );
    expect(
      screen.getByRole('button', { name: 'Recheck exact result' })
    ).toBeDisabled();
    expect(onPreflight).not.toHaveBeenCalled();
  });

  it('preflights ordered loft profiles through the shared exact gate', async () => {
    const profiles = ['Lower', 'Upper'].map((label, index) => ({
      id: label.toLowerCase(),
      label,
      section: {
        sketchId: toSketchId(`sketch_${index}`),
        profile: {
          profileId: `profile_${index}`,
          regionFingerprint: index + 1,
          samplePoint: { x: 0, y: 0 },
          sourceArea: 10 + index
        }
      }
    }));
    const onPreflight = vi.fn(async () => ({ status: 'ready' as const }));
    render(
      <ModelingOperationsForm
        operation="loft"
        scope={{}}
        bodies={[]}
        profileOptions={profiles}
        onPreflight={onPreflight}
        onSubmit={() => undefined}
      />
    );

    fireEvent.change(screen.getByLabelText('Surface mode'), {
      target: { value: 'smooth' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check exact result' }));
    await waitFor(() => expect(onPreflight).toHaveBeenCalledTimes(1));
    expect(onPreflight).toHaveBeenCalledWith({
      operation: 'loft',
      input: {
        name: 'Loft',
        sections: [profiles[0]!.section, profiles[1]!.section],
        mode: 'smooth'
      }
    });
  });
});
