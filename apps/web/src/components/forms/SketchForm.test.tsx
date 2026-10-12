import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SketchForm, type SketchFormValue } from './FeatureForms';

const initial: SketchFormValue = {
  name: 'Profile',
  plane: 'XY',
  offset: '2.54 mm',
  object: {
    objectKind: 'rectangle',
    width: '1 in + 25.4 mm',
    height: '10 mm',
    centerX: '1 cm',
    centerY: '-5 mm'
  }
};

function change(label: string, value: string) {
  fireEvent.change(screen.getByRole('textbox', { name: label }), {
    target: { value }
  });
}

describe('history sketch form unit context', () => {
  it.each([
    { units: 'mm', width: '= 50.8', offset: '= 2.54' },
    { units: 'cm', width: '= 5.08', offset: '= 0.254' },
    { units: 'inch', width: '= 2', offset: '= 0.1' }
  ] as const)(
    'can rename a saved unit-bearing sketch in $units without rewriting expressions',
    ({ units, width, offset }) => {
      const onSubmit = vi.fn();
      render(
        <SketchForm
          scope={{}}
          units={units}
          initial={initial}
          submitLabel="Apply"
          onSubmit={onSubmit}
        />
      );
      expect(screen.getByLabelText('Width')).toHaveAccessibleDescription(width);
      expect(screen.getByLabelText('Plane offset')).toHaveAccessibleDescription(
        offset
      );
      expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
      change('Name', 'Renamed profile');
      fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
        ...initial,
        name: 'Renamed profile'
      });
    }
  );

  it('keeps bare values in document units and supports the default context', () => {
    const onSubmit = vi.fn();
    render(<SketchForm scope={{}} submitLabel="Create" onSubmit={onSubmit} />);
    change('Width', '40');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      name: 'Sketch',
      plane: 'XZ',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 40,
        height: 18,
        centerX: 0,
        centerY: 0
      }
    });
  });

  it.each([
    { label: 'Width', expression: '30 deg' },
    { label: 'Center X', expression: '2 mm * 3 mm' },
    { label: 'Plane offset', expression: '45 deg' }
  ])(
    'refuses a wrong dimension in $label without committing',
    ({ label, expression }) => {
      const onSubmit = vi.fn();
      render(
        <SketchForm
          scope={{}}
          units="cm"
          initial={initial}
          submitLabel="Apply"
          onSubmit={onSubmit}
        />
      );
      change(label, expression);
      const input = screen.getByRole('textbox', { name: label });
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAccessibleDescription(/expected a length/);
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
    }
  );

  it.each(['0 mm', '1 cm - 20 mm'])(
    'checks the converted circle radius %s before Apply',
    (expression) => {
      const onSubmit = vi.fn();
      render(
        <SketchForm
          scope={{}}
          units="cm"
          initial={{
            ...initial,
            object: {
              objectKind: 'circle',
              radius: '1 cm',
              centerX: 0,
              centerY: 0
            }
          }}
          submitLabel="Apply"
          onSubmit={onSubmit}
        />
      );
      change('Radius', expression);
      expect(screen.getByLabelText('Radius')).toHaveAccessibleDescription(
        'Must be greater than zero.'
      );
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
      fireEvent.keyDown(screen.getByLabelText('Radius'), { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
    }
  );

  it('types polygon sides as a count while preserving a valid unit-bearing radius', () => {
    const onSubmit = vi.fn();
    const polygon = {
      objectKind: 'polygon',
      sides: 6,
      radius: '1 in',
      centerX: 0,
      centerY: 0
    } as const;
    render(
      <SketchForm
        scope={{}}
        units="cm"
        initial={{ ...initial, object: polygon }}
        submitLabel="Apply"
        onSubmit={onSubmit}
      />
    );
    expect(screen.getByLabelText('Radius')).toHaveAccessibleDescription(
      '= 2.54'
    );
    change('Sides', '6 mm');
    expect(screen.getByLabelText('Sides')).toHaveAccessibleDescription(
      /a number without units/
    );
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    change('Sides', '3 + 3');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      ...initial,
      object: { ...polygon, sides: '3 + 3' }
    });
  });
});
