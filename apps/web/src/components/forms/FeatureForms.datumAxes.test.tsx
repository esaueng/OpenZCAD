import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBodyId, type FeatureId, type SketchId } from '@openzcad/shared';
import { PatternForm, RevolveForm, TransformForm } from './FeatureForms';

/**
 * R01: revolve, circular pattern and Move offer earlier datum axes beside
 * their own axes, submit the choice as a reference, and an edit that goes
 * back to a sketch or world axis submits none.
 */

const axes = [{ featureId: 'feat_spin' as FeatureId, name: 'Spin' }];
const ref = { type: 'datum-axis', datumFeatureId: 'feat_spin' };
const body = { bodyId: toBodyId('body_block'), name: 'Block', consumed: false };

afterEach(cleanup);

describe('datum axis pickers', () => {
  it('revolves about a chosen datum axis, keeping the sketch axis', () => {
    const onSubmit = vi.fn();
    render(
      <RevolveForm
        scope={{}}
        sketches={[{ sketchId: 'sk_1' as SketchId, name: 'Profile' }]}
        datumAxes={axes}
        submitLabel="Create"
        onSubmit={onSubmit}
      />
    );
    fireEvent.change(screen.getByLabelText('Revolve around'), {
      target: { value: 'datum-axis:feat_spin' }
    });
    expect(screen.getByText(/must lie in the sketch/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ axis: 'vertical', axisRef: ref })
    );
  });

  it('an edit back to a sketch axis drops the datum axis', () => {
    const onSubmit = vi.fn();
    render(
      <RevolveForm
        scope={{}}
        sketches={[{ sketchId: 'sk_1' as SketchId, name: 'Profile' }]}
        initial={{
          name: 'Ring',
          sketchId: 'sk_1' as SketchId,
          axis: 'horizontal',
          axisRef: ref as never
        }}
        datumAxes={axes}
        submitLabel="Apply"
        onSubmit={onSubmit}
      />
    );
    expect(screen.getByLabelText('Revolve around')).toHaveDisplayValue('Spin');
    fireEvent.change(screen.getByLabelText('Revolve around'), {
      target: { value: 'horizontal' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('axisRef');
    expect((onSubmit.mock.calls[0]![0] as { axis: string }).axis).toBe(
      'horizontal'
    );
  });

  it('patterns about a datum axis, and only a circular pattern offers one', () => {
    const onSubmit = vi.fn();
    const { unmount } = render(
      <PatternForm
        kind="circular"
        scope={{}}
        bodies={[body]}
        datumAxes={axes}
        submitLabel="Create"
        onSubmit={onSubmit}
      />
    );
    fireEvent.change(screen.getByLabelText('Axis'), {
      target: { value: 'datum-axis:feat_spin' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ patternKind: 'circular', axisRef: ref })
    );
    unmount();
    render(
      <PatternForm
        kind="linear"
        scope={{}}
        bodies={[body]}
        datumAxes={axes}
        submitLabel="Create"
        onSubmit={vi.fn()}
      />
    );
    expect(screen.queryByRole('option', { name: 'Spin' })).toBeNull();
  });

  it('rotates a body about an axis from the Rotate about axis card', () => {
    const onSubmit = vi.fn();
    render(
      <TransformForm
        scope={{}}
        bodies={[body]}
        defaultName="Rotate"
        axisOnly
        datumAxes={axes}
        submitLabel="Create"
        onSubmit={onSubmit}
      />
    );
    // Only the turn: no move, rotation, scale or pivot fields.
    expect(screen.queryByLabelText(/^Move X/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Angle about axis in degrees'), {
      target: { value: '45' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Rotate',
        translation: { x: 0, y: 0, z: 0 },
        axisRotation: { axis: ref, angleDeg: 45 }
      })
    );
  });

  it('a Move edit can clear its axis turn', () => {
    const onSubmit = vi.fn();
    render(
      <TransformForm
        scope={{}}
        bodies={[body]}
        initial={{
          name: 'Turn',
          targetBodyId: body.bodyId,
          translation: { x: 0, y: 0, z: 5 },
          rotationDeg: { x: 0, y: 0, z: 0 },
          axisRotation: { axis: ref as never, angleDeg: 90 }
        }}
        datumAxes={axes}
        submitLabel="Apply"
        onSubmit={onSubmit}
      />
    );
    expect(screen.getByLabelText('Rotate about axis')).toHaveDisplayValue(
      'Spin'
    );
    fireEvent.change(screen.getByLabelText('Rotate about axis'), {
      target: { value: '' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('axisRotation');
  });
});
