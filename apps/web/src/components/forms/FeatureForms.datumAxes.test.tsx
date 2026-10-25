import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBodyId, type FeatureId } from '@openzcad/shared';
import { TransformForm } from './FeatureForms';

/**
 * R01: a Move offers earlier datum axes to turn about, submits the choice as
 * a reference, and an edit that goes back to no axis submits none. (Revolve,
 * circular pattern and Rotate about axis pick theirs in place.)
 */

const axes = [{ featureId: 'feat_spin' as FeatureId, name: 'Spin' }];
const ref = { type: 'datum-axis', datumFeatureId: 'feat_spin' };
const body = { bodyId: toBodyId('body_block'), name: 'Block', consumed: false };

afterEach(cleanup);

describe('datum axis pickers', () => {
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
