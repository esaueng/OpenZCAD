import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExprInput } from './ExprInput';

describe('ExprInput', () => {
  it('says nothing under a blank optional field', () => {
    const { container } = render(
      <ExprInput
        label="End radius (blank = constant)"
        value=""
        scope={{}}
        optional
        onChange={vi.fn()}
      />
    );
    const input = screen.getByRole('textbox', {
      name: 'End radius (blank = constant)'
    });
    expect(container.querySelector('.expr-preview')).toBeNull();
    expect(screen.queryByText('required')).toBeNull();
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('still flags a blank required field', () => {
    render(<ExprInput label="Radius" value="" scope={{}} onChange={vi.fn()} />);
    expect(screen.getByText('required')).toHaveClass('expr-preview', 'error');
    expect(screen.getByRole('textbox', { name: 'Radius' })).toHaveAttribute(
      'aria-invalid',
      'true'
    );
  });

  it('previews an optional expression once one is typed', () => {
    render(
      <ExprInput
        label="End radius (blank = constant)"
        value="r * 2"
        scope={{ r: 3 }}
        optional
        onChange={vi.fn()}
      />
    );
    expect(screen.getByText('= 6')).toHaveClass('expr-preview');
  });

  it('takes an accessible name that says more than its visible label', () => {
    render(
      <ExprInput
        label="dX"
        ariaLabel="Move X in mm"
        value="r * 2"
        scope={{ r: 3 }}
        onChange={vi.fn()}
      />
    );
    const input = screen.getByRole('textbox', { name: 'Move X in mm' });
    expect(screen.getByText('dX')).toBeVisible();
    // The preview stays a description, never part of the name.
    expect(input).toHaveAccessibleDescription('= 6');
  });
});
