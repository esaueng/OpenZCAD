import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BodyId } from '@openzcad/shared';
import { ExtrudeControls } from './ExtrudeControls';

const bodies = [
  { bodyId: 'plate' as BodyId, name: 'Mounting plate' },
  { bodyId: 'arm' as BodyId, name: 'Arm' }
];

describe('ExtrudeControls', () => {
  it('requires an explicit target when multiple bodies exist and preserves Cut on target changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <ExtrudeControls
        choice={{ operation: 'automatic' }}
        bodies={bodies}
        disabled={false}
        onChange={onChange}
        onDistance={vi.fn()}
      />
    );
    await user.selectOptions(screen.getByLabelText('Extrude operation'), 'cut');
    expect(onChange).toHaveBeenLastCalledWith({ operation: 'cut' });
    rerender(
      <ExtrudeControls
        choice={{ operation: 'cut' }}
        bodies={bodies}
        disabled={false}
        onChange={onChange}
        onDistance={vi.fn()}
      />
    );
    expect(screen.getByText('Select a target before applying.')).toBeVisible();
    await user.selectOptions(
      screen.getByLabelText('Extrude target body'),
      'plate'
    );
    expect(onChange).toHaveBeenLastCalledWith({
      operation: 'cut',
      targetBodyId: 'plate'
    });
  });

  it('uses the only body for Add and drops a former Cut target for New Body', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <ExtrudeControls
        choice={{ operation: 'automatic' }}
        bodies={[bodies[0]!]}
        disabled={false}
        onChange={onChange}
        onDistance={vi.fn()}
      />
    );
    await user.selectOptions(screen.getByLabelText('Extrude operation'), 'add');
    expect(onChange).toHaveBeenLastCalledWith({
      operation: 'add',
      targetBodyId: 'plate'
    });
    rerender(
      <ExtrudeControls
        choice={{ operation: 'cut', targetBodyId: bodies[0]!.bodyId }}
        bodies={bodies}
        disabled={false}
        onChange={onChange}
        onDistance={vi.fn()}
      />
    );
    await user.selectOptions(
      screen.getByLabelText('Extrude operation'),
      'new-body'
    );
    expect(onChange).toHaveBeenLastCalledWith({ operation: 'new-body' });
  });

  it('locks operation, target and distance during validation', () => {
    render(
      <ExtrudeControls
        choice={{ operation: 'cut', targetBodyId: bodies[0]!.bodyId }}
        bodies={bodies}
        disabled
        onChange={vi.fn()}
        onDistance={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Extrude operation')).toBeDisabled();
    expect(screen.getByLabelText('Extrude target body')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Distance…' })).toBeDisabled();
  });
});
