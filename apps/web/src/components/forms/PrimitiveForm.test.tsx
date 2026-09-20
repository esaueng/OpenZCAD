import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PrimitiveForm } from './FeatureForms';

describe('PrimitiveForm dimension validation', () => {
  it.each(['-5', '0', 'w - 10'])(
    'rejects %s before mouse or keyboard submission and allows correction',
    (value) => {
      const onSubmit = vi.fn();
      render(
        <PrimitiveForm
          kind="box"
          scope={{ w: 5 }}
          initialName="QA Box"
          submitLabel="Create"
          onSubmit={onSubmit}
        />
      );
      const width = screen.getByRole('textbox', { name: 'Width (X)' });
      fireEvent.change(width, { target: { value } });
      expect(width).toHaveAttribute('aria-invalid', 'true');
      expect(width).toHaveAccessibleDescription('Must be greater than zero.');
      expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
      fireEvent.keyDown(width, { key: 'Enter' });
      fireEvent.submit(width.closest('form')!);
      expect(onSubmit).not.toHaveBeenCalled();
      fireEvent.change(width, { target: { value: 'w * 2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      expect(onSubmit).toHaveBeenCalledWith('QA Box', {
        width: 'w * 2',
        height: 18,
        depth: 24
      });
    }
  );

  it('validates Apply and responds to changed parameter values', () => {
    const props = {
      kind: 'box' as const,
      initialName: 'QA Box',
      initialDimensions: { width: 'w', height: 18, depth: 24 },
      submitLabel: 'Apply',
      onSubmit: vi.fn()
    };
    const { rerender } = render(<PrimitiveForm {...props} scope={{ w: 30 }} />);
    // Nothing differs from the document yet, so Apply has nothing to do.
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    const height = screen.getByRole('textbox', { name: 'Height (Z)' });
    fireEvent.change(height, { target: { value: '20' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    fireEvent.change(height, { target: { value: '24' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    fireEvent.change(height, { target: { value: '20' } });
    rerender(<PrimitiveForm {...props} scope={{ w: -5 }} />);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('enables Apply for a rename alone', () => {
    render(
      <PrimitiveForm
        kind="box"
        scope={{}}
        initialName="QA Box"
        initialDimensions={{ width: 30, height: 18, depth: 24 }}
        submitLabel="Apply"
        onSubmit={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Renamed' }
    });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('allows a pointed cone but rejects two zero radii', () => {
    render(
      <PrimitiveForm
        kind="cone"
        scope={{}}
        initialName="QA Cone"
        submitLabel="Create"
        onSubmit={vi.fn()}
      />
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Top radius' }), {
      target: { value: '0' }
    });
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Bottom radius' }), {
      target: { value: '0' }
    });
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });
});
