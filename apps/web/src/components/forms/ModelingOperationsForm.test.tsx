import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toBodyId } from '@openzcad/shared';
import type { BodyOption } from './FeatureForms';
import { ModelingOperationsForm } from './ModelingOperationsForm';
import {
  OCCT_SHARP_OFFSET_LIMITATION,
  type ModelingOperationSubmission,
  type ModelingFaceOption
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

  it('renders the OCCT curved/non-convex limitation and blocks checking', () => {
    const onPreflight = vi.fn();
    render(
      <ModelingOperationsForm
        operation="solid-offset"
        scope={{}}
        bodies={bodies}
        unsupportedReason={OCCT_SHARP_OFFSET_LIMITATION}
        onPreflight={onPreflight}
        onSubmit={() => undefined}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'curved, non-convex, or unproven topology is refused'
    );
    expect(
      screen.getByRole('button', { name: 'Recheck exact result' })
    ).toBeDisabled();
    expect(onPreflight).not.toHaveBeenCalled();
  });
});
