import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PrimitiveForm } from './FeatureForms';
import {
  ParameterDefinitionProvider,
  type ParameterDefinition
} from './parameterDefinition';

describe('PrimitiveForm dimension validation', () => {
  // Production QA CAD-004: an inch project refused both inputs as needing
  // "the document's units", which the form had all along.
  it('accepts unit-suffixed sizes in an inch document and previews them in inches', () => {
    const onSubmit = vi.fn();
    render(
      <PrimitiveForm
        kind="box"
        scope={{}}
        documentUnits="inch"
        initialName="Imperial fixture"
        submitLabel="Create"
        onSubmit={onSubmit}
      />
    );
    const width = screen.getByRole('textbox', { name: 'Width (X)' });
    fireEvent.change(width, { target: { value: '1 in + 25.4 mm' } });
    expect(width).not.toHaveAttribute('aria-invalid');
    expect(width).toHaveAccessibleDescription('= 2');
    const depth = screen.getByRole('textbox', { name: 'Depth (Y)' });
    fireEvent.change(depth, { target: { value: '25.4 mm' } });
    expect(depth).toHaveAccessibleDescription('= 1');
    const cornerX = screen.getByRole('textbox', { name: 'Corner X' });
    fireEvent.change(cornerX, { target: { value: '12.7 mm' } });
    expect(cornerX).toHaveAccessibleDescription('= 0.5');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledWith(
      'Imperial fixture',
      { width: '1 in + 25.4 mm', height: '25.4 mm', depth: 24 },
      { x: '12.7 mm', y: 0, z: 0 }
    );
  });

  it.each([
    ['30 deg', 'expected a length, not an angle or area'],
    ['(2 mm) * (3 mm)', 'expected a length, not an angle or area']
  ])('refuses %s in a size field by its dimension', (value, reason) => {
    render(
      <PrimitiveForm
        kind="box"
        scope={{}}
        documentUnits="inch"
        initialName="Imperial fixture"
        submitLabel="Create"
        onSubmit={vi.fn()}
      />
    );
    const width = screen.getByRole('textbox', { name: 'Width (X)' });
    fireEvent.change(width, { target: { value } });
    expect(width).toHaveAttribute('aria-invalid', 'true');
    expect(width).toHaveAccessibleDescription(expect.stringContaining(reason));
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it.each(['-5', '0', 'w - 10'])(
    'rejects %s before mouse or keyboard submission and allows correction',
    (value) => {
      const onSubmit = vi.fn();
      render(
        <PrimitiveForm
          kind="box"
          scope={{ w: 5 }}
          documentUnits="mm"
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
      documentUnits: 'mm' as const,
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
        documentUnits="mm"
        initialName="QA Box"
        initialDimensions={{ width: 30, height: 18, depth: 24 }}
        submitLabel="Apply"
        onSubmit={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    // A dimmed Apply alone read as broken; the card says why it is off.
    expect(screen.getByText(/No changes yet/)).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Renamed' }
    });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    expect(screen.queryByText(/No changes yet/)).toBeNull();
  });

  it('puts Cancel before Apply, as the in-place Cancel/Done bar does', () => {
    render(
      <PrimitiveForm
        kind="box"
        scope={{}}
        documentUnits="mm"
        initialName="QA Box"
        initialDimensions={{ width: 30, height: 18, depth: 24 }}
        submitLabel="Apply"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(cancel).toHaveAttribute('aria-keyshortcuts', 'Escape');
    expect(
      cancel.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('allows a pointed cone but rejects two zero radii', () => {
    render(
      <PrimitiveForm
        kind="cone"
        scope={{}}
        documentUnits="mm"
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
        documentUnits="mm"
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
        documentUnits="mm"
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
        documentUnits="mm"
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
        documentUnits="mm"
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
        documentUnits="mm"
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

describe('PrimitiveForm defines a parameter from a field (G5)', () => {
  it('creates a box over a parameter defined in its Width field', async () => {
    const onSubmit = vi.fn();
    const defined: Array<[string, string]> = [];
    function Workspace() {
      const [scope, setScope] = useState<Record<string, number>>({});
      const definition: ParameterDefinition = {
        has: (name) => name in scope,
        define: async (name, expression) => {
          defined.push([name, expression]);
          setScope((current) => ({ ...current, [name]: Number(expression) }));
          return null;
        }
      };
      return (
        <ParameterDefinitionProvider value={definition}>
          <PrimitiveForm
            documentUnits="mm"
            kind="box"
            scope={scope}
            initialName="Box"
            submitLabel="Create"
            onSubmit={onSubmit}
          />
        </ParameterDefinitionProvider>
      );
    }
    render(<Workspace />);
    const width = screen.getByRole('textbox', { name: 'Width (X)' });
    const previous = (width as HTMLInputElement).value;
    fireEvent.change(width, { target: { value: 'width' } });
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    const value = await screen.findByRole('textbox', {
      name: 'Value for new parameter width'
    });
    expect(value).toHaveValue(previous);
    // Enter in the value defines; it does not reach the card's Enter.
    await act(async () => {
      fireEvent.keyDown(value, { key: 'Enter' });
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(defined).toEqual([['width', previous]]);
    expect(screen.getByText(`= ${previous}`)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
    // Back in the field, Enter creates the box over the new parameter.
    expect(width).toHaveFocus();
    fireEvent.keyDown(width, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith(
      'Box',
      { width: 'width', height: 18, depth: 24 },
      { x: 0, y: 0, z: 0 }
    );
  });
});
