import { render, screen } from '@testing-library/react';
import type { ParameterNode } from '@openzcad/shared';
import { describe, expect, it, vi } from 'vitest';
import { ParameterRow } from './ParameterRows';

function parameter(expression: string): ParameterNode {
  return {
    id: 'node_width',
    parentId: null,
    revisionId: null,
    kind: 'parameter',
    parameterId: 'parameter_width',
    name: 'width',
    expression,
    value: 80
  } as ParameterNode;
}

describe('ParameterRow evaluated value', () => {
  it('hides a readout that repeats the canonical expression', () => {
    const { container } = render(
      <ParameterRow parameter={parameter('80')} value={80} onSet={vi.fn()} />
    );

    expect(container.querySelector('.param-value')).toBeNull();
  });

  it('shows the evaluated value for an expression', () => {
    render(
      <ParameterRow
        parameter={parameter('plate_t + 4')}
        value={12}
        onSet={vi.fn()}
      />
    );

    expect(screen.getByText('12')).toHaveClass('param-value');
  });

  it('shows an error when the expression cannot be evaluated', () => {
    render(
      <ParameterRow
        parameter={parameter('missing + 4')}
        value={undefined}
        onSet={vi.fn()}
      />
    );

    expect(screen.getByText('err')).toHaveClass('param-value', 'error');
  });
});
