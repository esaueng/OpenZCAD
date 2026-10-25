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
});
