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
  it('asks for a target body only when there is a choice to make', () => {
    const props = {
      operation: 'hole' as const,
      scope: {},
      faceOptions: faces,
      onPreflight: vi.fn(),
      onSubmit: vi.fn()
    };
    const view = render(<ModelingOperationsForm {...props} bodies={bodies} />);
    expect(screen.queryByLabelText('Target body')).toBeNull();
    // The one body is still the target the hole is drilled into.
    expect(screen.getByRole('button', { name: faces[0]!.label })).toBeVisible();

    view.rerender(
      <ModelingOperationsForm
        {...props}
        bodies={[
          ...bodies,
          {
            bodyId: toBodyId('other_body'),
            name: 'Other body',
            consumed: false
          }
        ]}
      />
    );
    expect(screen.getByLabelText('Target body')).toHaveValue(bodyId);
  });

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
    fireEvent.click(screen.getByRole('button', { name: 'Create hole' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Checking that the result builds'
    );

    view.rerender(
      <ModelingOperationsForm
        {...props}
        viewportFacePick={{ bodyId, hash: 43 }}
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
    // The older check answered for the old face: it creates nothing.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create hole' })).toBeEnabled()
    );
    expect(props.onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create hole' }));
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
        viewportFacePick={{ bodyId, hash: 42 }}
      />
    );
    expect(
      screen.getByRole('button', { name: faces[0]!.label })
    ).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Create hole' })).toBeDisabled();
  });

  it('toggles shell opening faces from viewport picks and replaces a thicken face', () => {
    const extraFace = {
      ...faces[0]!,
      hash: 43,
      topologyId: 'face:43',
      label: 'Second plane'
    };
    const shellProps = {
      operation: 'shell' as const,
      scope: {},
      bodies,
      faceOptions: [...faces, extraFace],
      onPreflight: vi.fn(),
      onSubmit: vi.fn()
    };
    const view = render(<ModelingOperationsForm {...shellProps} />);
    view.rerender(
      <ModelingOperationsForm
        {...shellProps}
        viewportFacePick={{ bodyId, hash: 42 }}
      />
    );
    view.rerender(
      <ModelingOperationsForm
        {...shellProps}
        viewportFacePick={{ bodyId, hash: 43 }}
      />
    );
    expect(
      screen.getByRole('button', { name: `1 ${faces[0]!.label}` })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: `2 ${extraFace.label}` })
    ).toHaveAttribute('aria-pressed', 'true');
    // A second click on a face already in the list takes it out again.
    view.rerender(
      <ModelingOperationsForm
        {...shellProps}
        viewportFacePick={{ bodyId, hash: 42 }}
      />
    );
    expect(
      screen.getByRole('button', { name: faces[0]!.label })
    ).toHaveAttribute('aria-pressed', 'false');
    expect(
      screen.getByRole('button', { name: `1 ${extraFace.label}` })
    ).toHaveAttribute('aria-pressed', 'true');
    view.unmount();

    const thickenProps = { ...shellProps, operation: 'thicken' as const };
    const thicken = render(<ModelingOperationsForm {...thickenProps} />);
    thicken.rerender(
      <ModelingOperationsForm
        {...thickenProps}
        viewportFacePick={{ bodyId, hash: 42 }}
      />
    );
    thicken.rerender(
      <ModelingOperationsForm
        {...thickenProps}
        viewportFacePick={{ bodyId, hash: 43 }}
      />
    );
    expect(
      screen.getByRole('button', { name: faces[0]!.label })
    ).toHaveAttribute('aria-pressed', 'false');
    expect(
      screen.getByRole('button', { name: `1 ${extraFace.label}` })
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('follows a viewport pick onto another body when the workspace retargets it', () => {
    const otherBodyId = toBodyId('other_body');
    const props = {
      operation: 'shell' as const,
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
    expect(screen.getByLabelText('Target body')).toHaveValue(bodyId);
    view.rerender(
      <ModelingOperationsForm
        {...props}
        initialTarget={otherBodyId}
        viewportFacePick={{ bodyId: otherBodyId, hash: 42 }}
      />
    );
    expect(screen.getByLabelText('Target body')).toHaveValue(otherBodyId);
    expect(
      screen.getByRole('button', { name: `1 ${faces[0]!.label}` })
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows a face still to pick as a hint, and a bad value as an error', () => {
    render(
      <ModelingOperationsForm
        operation="hole"
        scope={{}}
        bodies={bodies}
        faceOptions={faces}
        onPreflight={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    const hint = screen.getByText(/Click a flat face in the viewport/);
    expect(hint).toHaveClass('muted');
    expect(hint).not.toHaveClass('field-error');
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: faces[0]!.label }));
    fireEvent.change(screen.getByLabelText('Diameter'), {
      target: { value: '-3' }
    });
    expect(
      screen.getByText('Hole diameter must resolve to a positive value.')
    ).toHaveClass('field-error');
  });

  it('checks the exact result and creates a typed shell in one press', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Create shell' }));

    expect(screen.getByRole('status')).toHaveTextContent(
      'Checking that the result builds'
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onPreflight).toHaveBeenCalledWith({
      operation: 'shell',
      input: {
        name: 'Shell',
        targetBodyId: bodyId,
        openingFaceHashes: [42],
        thickness: 'wall / 2'
      }
    });

    await act(async () => {
      resolvePreflight?.({ status: 'ready' });
    });
    // No second press: the checked values are the ones created.
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      onPreflight.mock.calls[0]![0]
    );
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

    fireEvent.click(screen.getByRole('button', { name: 'Create mirror' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not created — The mirror plane intersects unsupported imported topology.'
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
      screen.getByRole('button', { name: 'Create solid offset' })
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
    fireEvent.click(screen.getByRole('button', { name: 'Create loft' }));
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

  it('reads Apply instead of Create while editing an existing feature', async () => {
    const onPreflight = vi.fn(async () => ({ status: 'ready' as const }));
    render(
      <ModelingOperationsForm
        operation="hole"
        editing
        scope={{}}
        bodies={bodies}
        faceOptions={faces}
        onPreflight={onPreflight}
        onSubmit={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: faces[0]!.label }));
    expect(screen.getByRole('button', { name: 'Apply hole' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create hole' })).toBeNull();
  });
});

it.each(['removed', 'changed'] as const)(
  'refuses Apply when a checked profile is %s while the editor is open',
  async (change) => {
    const profile = {
      id: 'profile',
      label: 'Selected profile',
      section: {
        sketchId: toSketchId('sketch_selected'),
        profile: {
          profileId: 'profile_a',
          regionFingerprint: 1,
          sourceArea: 4,
          samplePoint: { x: 0, y: 0 }
        }
      }
    };
    const props = {
      operation: 'helical-sweep' as const,
      editing: true,
      bodies: [],
      scope: {},
      profileOptions: [profile],
      onPreflight: vi.fn(async () => ({ status: 'ready' as const })),
      onSubmit: vi.fn()
    };
    const view = render(<ModelingOperationsForm {...props} />);
    // The first press checks and applies the values it checked.
    fireEvent.click(
      screen.getByRole('button', { name: 'Apply helical sweep' })
    );
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledOnce());
    view.rerender(
      <ModelingOperationsForm
        {...props}
        profileOptions={
          change === 'removed'
            ? []
            : [
                {
                  ...profile,
                  section: {
                    ...profile.section,
                    profile: {
                      ...profile.section.profile,
                      profileId: 'profile_b'
                    }
                  }
                }
              ]
        }
      />
    );
    // A second press with references changed since the check refuses.
    fireEvent.click(
      screen.getByRole('button', { name: 'Apply helical sweep' })
    );
    expect(props.onSubmit).toHaveBeenCalledOnce();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      change === 'removed'
        ? 'Selected profile no longer resolves uniquely'
        : 'selection changed after the result was checked'
    );
  }
);

describe('Hole position', () => {
  const topFace: ModelingFaceOption = {
    hash: 7,
    topologyId: 'face:7',
    label: 'Top face',
    surfaceType: 'plane',
    normal: { x: 0, y: 0, z: 1 }
  };

  it('names the world axis U and V run along on the picked face', () => {
    render(
      <ModelingOperationsForm
        operation="hole"
        scope={{}}
        bodies={bodies}
        faceOptions={[topFace]}
        onPreflight={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Top face' }));
    expect(screen.getByLabelText('U · along −Y')).toHaveValue('0');
    expect(screen.getByLabelText('V · along +X')).toHaveValue('0');
  });

  it('puts a refusal about where the hole sits under its position', async () => {
    const onSubmit = vi.fn();
    render(
      <ModelingOperationsForm
        operation="hole"
        scope={{}}
        bodies={bodies}
        faceOptions={[topFace]}
        onPreflight={async () => ({
          status: 'refused',
          reason:
            'Feature "Hole": The hole removed no material — it misses the body.'
        })}
        onSubmit={onSubmit}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Top face' }));
    fireEvent.change(screen.getByLabelText('U · along −Y'), {
      target: { value: '-40' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create hole' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Not created — The hole removed no material — it misses the body.'
    );
    expect(alert.closest('fieldset')).toHaveTextContent(
      'Position on face (from center)'
    );
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('says why the viewport draws no bore under the position fields', () => {
    const props = {
      operation: 'hole' as const,
      scope: {},
      bodies,
      faceOptions: [topFace],
      onPreflight: vi.fn(),
      onSubmit: vi.fn()
    };
    const view = render(<ModelingOperationsForm {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Top face' }));
    view.rerender(
      <ModelingOperationsForm
        {...props}
        holePreviewNotice="No preview — the hole points away from the body."
      />
    );
    const notice = screen.getByText(
      'No preview — the hole points away from the body.'
    );
    expect(notice.closest('fieldset')).toHaveTextContent(
      'Position on face (from center)'
    );
    // Advisory: it does not stop the exact check from being asked.
    expect(screen.getByRole('button', { name: 'Create hole' })).toBeEnabled();
  });

  it('lets the exact refusal replace the preview notice', async () => {
    render(
      <ModelingOperationsForm
        operation="hole"
        scope={{}}
        bodies={bodies}
        faceOptions={[topFace]}
        holePreviewNotice="This position misses the body."
        onPreflight={async () => ({
          status: 'refused',
          reason: 'The hole removed no material — it misses the body.'
        })}
        onSubmit={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Top face' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create hole' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not created — The hole removed no material — it misses the body.'
    );
    expect(
      screen.queryByText('This position misses the body.')
    ).not.toBeInTheDocument();
  });

  it('hands the viewport the widest tool and nothing for a size that cannot drill', () => {
    const onHoleDraftChange = vi.fn();
    render(
      <ModelingOperationsForm
        operation="hole"
        scope={{}}
        bodies={bodies}
        faceOptions={[topFace]}
        onPreflight={vi.fn()}
        onSubmit={vi.fn()}
        onHoleDraftChange={onHoleDraftChange}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Top face' }));
    fireEvent.change(screen.getByLabelText('Diameter'), {
      target: { value: '5' }
    });
    fireEvent.change(screen.getByLabelText('Style'), {
      target: { value: 'counterbore' }
    });
    fireEvent.change(screen.getByLabelText('Counterbore diameter'), {
      target: { value: '11' }
    });
    expect(onHoleDraftChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ diameter: 5, outerDiameter: 11 })
    );
    // The form's own line refuses a zero diameter; the viewport stays empty
    // rather than adding a second message.
    fireEvent.change(screen.getByLabelText('Diameter'), {
      target: { value: '0' }
    });
    expect(onHoleDraftChange).toHaveBeenLastCalledWith(null);
    expect(
      screen.getByText('Hole diameter must resolve to a positive value.')
    ).toBeInTheDocument();
  });
});
