import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BodyRepresentation, ParameterNode } from '@openzcad/shared';
import { ParametersPanel, parameterCount } from './ParametersPanel';

function parameter(name: string, expression: string): ParameterNode {
  return {
    id: `node_${name}`,
    kind: 'parameter',
    parameterId: `parameter_${name}`,
    name,
    expression,
    value: Number(expression)
  } as unknown as ParameterNode;
}

function renderPanel(
  overrides: Partial<ComponentProps<typeof ParametersPanel>> = {}
) {
  const props: ComponentProps<typeof ParametersPanel> = {
    parameters: [],
    parameterValues: {},
    onSetParameter: vi.fn(),
    onViewActivityLog: vi.fn(),
    onDeleteParameter: vi.fn(),
    onRenameParameter: vi.fn().mockReturnValue(null),
    onExposeParameter: vi.fn(),
    onDescribeParameter: vi.fn(),
    exposedParameterNames: new Set(),
    bodies: [],
    ...overrides
  };
  return render(<ParametersPanel {...props} />);
}

describe('ParametersPanel', () => {
  it('offers a new parameter and a hint while there are none', () => {
    const { container } = renderPanel();
    expect(container.querySelector('.param-list')).not.toBeNull();
    expect(screen.getByLabelText('New parameter name')).toBeInTheDocument();
    expect(screen.getByText(/and use it in any feature field/)).toHaveClass(
      'sidebar-hint'
    );
    expect(parameterCount([])).toBe(0);
  });

  it('lists each parameter with its expression and drops the hint', () => {
    const parameters = [parameter('w', '60'), parameter('h', '20')];
    renderPanel({ parameters, parameterValues: { w: 60, h: 20 } });
    expect(screen.getByLabelText('Expression for w')).toHaveValue('60');
    expect(screen.getByLabelText('Expression for h')).toHaveValue('20');
    expect(screen.queryByText(/and use it in any feature field/)).toBeNull();
    expect(parameterCount(parameters)).toBe(2);
  });

  it('offers the bodies it is given to a new toggle parameter', () => {
    renderPanel({
      bodies: [
        { bodyId: 'body-1', name: 'Plate', consumed: false }
      ] as unknown as BodyRepresentation[],
      onConfigureToggle: vi.fn()
    });
    fireEvent.change(screen.getByLabelText('New parameter type'), {
      target: { value: 'toggle' }
    });
    const editor = within(
      screen.getByRole('group', { name: 'Show these bodies when on' })
    );
    expect(editor.getByLabelText('Plate')).toBeInTheDocument();
  });
});
