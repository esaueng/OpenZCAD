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
      expect(onSubmit).toHaveBeenCalledWith(
        'QA Box',
        { width: 'w * 2', height: 18, depth: 24 },
        { x: 0, y: 0, z: 0 }
      );
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

describe('PrimitiveForm position row', () => {
  it.each([
    ['box', 'Corner', /lowest X, Y and Z/],
    ['cylinder', 'Base center', /bottom face.*rises along \+Z/]
  ] as const)('names the point a %s is placed by', (kind, anchor, hint) => {
    render(
      <PrimitiveForm
        kind={kind}
        scope={{}}
        initialName="Part"
        submitLabel="Create"
        onSubmit={vi.fn()}
      />
    );
    const group = screen.getByRole('group', { name: 'Position' });
    expect(group).toHaveTextContent(hint);
    for (const axis of ['X', 'Y', 'Z']) {
      // The default placement is the origin, shown rather than implied.
      expect(
        screen.getByRole('textbox', { name: `${anchor} ${axis}` })
      ).toHaveValue('0');
    }
  });

  it('submits the typed position with the dimensions', () => {
    const onSubmit = vi.fn();
    render(
      <PrimitiveForm
        kind="cylinder"
        scope={{ lift: 24 }}
        initialName="Cylinder"
        submitLabel="Create"
        onSubmit={onSubmit}
      />
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Base center X' }), {
      target: { value: '15' }
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Base center Z' }), {
      target: { value: 'lift' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledWith(
      'Cylinder',
      { radius: 6, height: 28 },
      { x: 15, y: 0, z: 'lift' }
    );
  });

  it('rejects an unresolvable position before submission', () => {
    const onSubmit = vi.fn();
    render(
      <PrimitiveForm
        kind="box"
        scope={{}}
        initialName="Box"
        submitLabel="Create"
        onSubmit={onSubmit}
      />
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Corner Y' }), {
      target: { value: 'missing_parameter' }
    });
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('shows the current placement and enables Apply for a move alone', () => {
    const onSubmit = vi.fn();
    render(
      <PrimitiveForm
        kind="box"
        scope={{}}
        initialName="Box"
        initialDimensions={{ width: 30, height: 18, depth: 24 }}
        initialPosition={{ x: 10, y: 0, z: 5 }}
        submitLabel="Apply"
        onSubmit={onSubmit}
      />
    );
    const cornerX = screen.getByRole('textbox', { name: 'Corner X' });
    expect(cornerX).toHaveValue('10');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    fireEvent.change(cornerX, { target: { value: '12' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onSubmit).toHaveBeenCalledWith(
      'Box',
      { width: 30, height: 18, depth: 24 },
      { x: 12, y: 0, z: 5 }
    );
  });
});

describe('PrimitiveForm submit button', () => {
  it('is named by its verb, with Enter as its shortcut rather than its title', () => {
    render(
      <PrimitiveForm
        kind="box"
        scope={{}}
        initialName="Box"
        submitLabel="Create"
        onSubmit={vi.fn()}
      />
    );
    const create = screen.getByRole('button', { name: 'Create' });
    // A `title="Enter"` was what assistive tech announced for every Create
    // and Apply; the key is a shortcut, not the button's name or tooltip.
    expect(create).not.toHaveAttribute('title');
    expect(create).toHaveAttribute('aria-keyshortcuts', 'Enter');
    expect(create).toHaveAccessibleName('Create');
    expect(create).toHaveAccessibleDescription('');
  });
});
