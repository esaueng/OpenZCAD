import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InPlaceCommandBar } from './InPlaceCommandBar';

describe('InPlaceCommandBar', () => {
  it('names the command and its step, with no fields', () => {
    render(
      <InPlaceCommandBar
        title="Revolve"
        hint="Pick the axis to turn around"
        canFinish={false}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const bar = screen.getByRole('group', { name: 'Revolve command' });
    expect(bar.textContent).toContain('Pick the axis to turn around');
    expect(bar.querySelector('input, select, textarea')).toBeNull();
  });

  it('holds Done until the command can finish', () => {
    const onDone = vi.fn();
    const { rerender } = render(
      <InPlaceCommandBar
        title="Revolve"
        hint="Drag the angle"
        canFinish={false}
        onDone={onDone}
        onCancel={vi.fn()}
      />
    );
    const done = screen.getByRole('button', { name: /Done/ });
    expect(done).toHaveProperty('disabled', true);
    rerender(
      <InPlaceCommandBar
        title="Revolve"
        hint="Drag the angle"
        canFinish
        onDone={onDone}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Done/ }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('takes nothing but Cancel while locked', () => {
    const onOption = vi.fn();
    const onValue = vi.fn();
    const onAction = vi.fn();
    const onCancel = vi.fn();
    render(
      <InPlaceCommandBar
        title="Extrude"
        hint="Checking"
        canFinish
        locked
        options={[
          {
            id: 'operation',
            label: 'Operation',
            value: 'automatic',
            choices: [
              { value: 'automatic', label: 'Automatic' },
              { value: 'cut', label: 'Cut' }
            ]
          }
        ]}
        onOption={onOption}
        values={[{ id: 'distance', label: 'Distance', text: '10 mm' }]}
        onValue={onValue}
        actions={[{ id: 'reverse', label: 'Reverse direction' }]}
        onAction={onAction}
        onDone={vi.fn()}
        onCancel={onCancel}
      />
    );
    for (const name of ['Cut', 'Distance', 'Reverse direction', 'Done']) {
      const control = screen.getByRole(name === 'Cut' ? 'radio' : 'button', {
        name: new RegExp(name),
        hidden: true
      });
      expect(control).toHaveProperty('disabled', true);
      fireEvent.click(control);
    }
    expect(onOption).not.toHaveBeenCalled();
    expect(onValue).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows a refusal in place of the hint and still cancels', () => {
    const onCancel = vi.fn();
    render(
      <InPlaceCommandBar
        title="Revolve"
        hint="Drag the angle"
        refusal="This revolve did not produce a valid body."
        canFinish={false}
        onDone={vi.fn()}
        onCancel={onCancel}
      />
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toBe(
      'This revolve did not produce a valid body.'
    );
    expect(status.closest('.in-place-command')?.className).toContain('refused');
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('offers rare choices behind Options and reports a pick', () => {
    const onOption = vi.fn();
    render(
      <InPlaceCommandBar
        title="Hole"
        hint="Drag the diameter"
        canFinish
        options={[
          {
            id: 'depthMode',
            label: 'Depth',
            value: 'through',
            choices: [
              { value: 'through', label: 'Through all' },
              { value: 'blind', label: 'Blind' }
            ]
          }
        ]}
        onOption={onOption}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const group = screen.getByRole('radiogroup', { name: 'Depth' });
    expect(
      screen
        .getByRole('radio', { name: 'Through all' })
        .getAttribute('aria-checked')
    ).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Blind' }));
    expect(onOption).toHaveBeenCalledWith('depthMode', 'blind');
    expect(group).toBeTruthy();
  });
  it('explains the chosen choice where the card did', () => {
    const options = (value: string) => [
      {
        id: 'mode',
        label: 'Mode',
        value,
        choices: [
          { value: 'standard', label: 'Standard' },
          { value: 'smooth', label: 'Smooth', note: 'Not exact surfaces.' }
        ]
      }
    ];
    const { rerender } = render(
      <InPlaceCommandBar
        title="Sweep"
        hint="Pick the path"
        canFinish={false}
        options={options('standard')}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByText('Not exact surfaces.')).toBeNull();
    rerender(
      <InPlaceCommandBar
        title="Sweep"
        hint="Pick the path"
        canFinish={false}
        options={options('smooth')}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText('Not exact surfaces.')).toBeTruthy();
  });

  it('puts exact numbers behind Options, each opening entry where it sits', () => {
    const onValue = vi.fn();
    render(
      <InPlaceCommandBar
        title="Box"
        hint="Drag a footprint"
        canFinish
        values={[
          { id: 'x', label: 'Corner X', text: '0 mm' },
          { id: 'y', label: 'Corner Y', text: 'gap' }
        ]}
        onValue={onValue}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Corner Y' }).textContent).toBe(
      'gap'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Corner X' }));
    expect(onValue).toHaveBeenCalledWith('x', { x: 0, y: 0 });
  });

  it('names Done and Cancel by their verbs, their keys as shortcuts', () => {
    render(
      <InPlaceCommandBar
        title="Box"
        hint="Drag a footprint"
        canFinish
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(
      screen
        .getByRole('button', { name: 'Done' })
        .getAttribute('aria-keyshortcuts')
    ).toBe('Enter');
    expect(
      screen
        .getByRole('button', { name: 'Cancel' })
        .getAttribute('aria-keyshortcuts')
    ).toBe('Escape');
  });
});
