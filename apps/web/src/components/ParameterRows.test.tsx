import { fireEvent, render, screen } from '@testing-library/react';
import type { ParameterNode } from '@openzcad/shared';
import { describe, expect, it, vi } from 'vitest';
import { AddParameterRow, ParameterRow } from './ParameterRows';

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

describe('ParameterRow Tweak exposure', () => {
  it('reports the opposite state when the eye is clicked', () => {
    const onExpose = vi.fn();
    const { rerender } = render(
      <ParameterRow
        parameter={parameter('80')}
        value={80}
        onSet={vi.fn()}
        onExpose={onExpose}
        exposedInTweak
      />
    );

    const hide = screen.getByRole('button', {
      name: 'Hide width in Tweak mode'
    });
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(hide);
    expect(onExpose).toHaveBeenCalledWith('width', false);

    rerender(
      <ParameterRow
        parameter={{ ...parameter('80'), exposed: false }}
        value={80}
        onSet={vi.fn()}
        onExpose={onExpose}
        exposedInTweak={false}
      />
    );
    const show = screen.getByRole('button', {
      name: 'Show width in Tweak mode'
    });
    expect(show).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(show);
    expect(onExpose).toHaveBeenLastCalledWith('width', true);
  });
});

describe('parameter rename', () => {
  it('renames from the parameter row and trims the new name', async () => {
    const onRename = vi.fn().mockReturnValue(null);
    render(
      <ParameterRow
        parameter={parameter('80')}
        value={80}
        onSet={vi.fn()}
        onRename={onRename}
      />
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Rename parameter width' })
    );
    const input = screen.getByRole('textbox', {
      name: 'Rename parameter width'
    });
    fireEvent.change(input, { target: { value: ' plate_width ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).toHaveBeenCalledWith('width', 'plate_width');
  });

  it('keeps the editor open and reports a refused rename', async () => {
    render(
      <ParameterRow
        parameter={parameter('80')}
        value={80}
        onSet={vi.fn()}
        onRename={vi.fn().mockReturnValue('That name already exists.')}
      />
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Rename parameter width' })
    );
    const input = screen.getByRole('textbox', {
      name: 'Rename parameter width'
    });
    fireEvent.change(input, { target: { value: 'height' } });
    fireEvent.blur(input);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That name already exists. No change applied.'
    );
    expect(
      screen.getByRole('textbox', { name: 'Rename parameter width' })
    ).toHaveValue('height');
  });
});

describe('on/off parameter controls', () => {
  it('renders an accessible switch and follows undo/collaborator values', () => {
    const onSet = vi.fn();
    const toggle = {
      ...parameter('1'),
      name: 'show_text',
      toggle: { bodyIds: [] }
    };
    const { rerender } = render(
      <ParameterRow parameter={toggle} value={1} onSet={onSet} />
    );
    const control = screen.getByRole('switch', { name: 'Toggle show_text' });
    expect(control).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(control);
    expect(onSet).toHaveBeenCalledWith('show_text', '0');
    rerender(
      <ParameterRow
        parameter={{ ...toggle, expression: '0' }}
        value={0}
        onSet={onSet}
      />
    );
    expect(control).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(control);
    expect(onSet).toHaveBeenLastCalledWith('show_text', '1');
  });

  it('creates a switch with the chosen bodies rather than a numeric expression', () => {
    const onSet = vi.fn();
    const configure = vi.fn();
    render(
      <AddParameterRow
        onSet={onSet}
        onConfigureToggle={configure}
        bodies={[{ bodyId: 'body_text' as never, name: 'Text' }]}
      />
    );
    fireEvent.change(screen.getByLabelText('New parameter type'), {
      target: { value: 'toggle' }
    });
    fireEvent.change(screen.getByLabelText('New parameter name'), {
      target: { value: 'show_text' }
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
    expect(configure).toHaveBeenCalledWith('show_text', ['body_text']);
    expect(onSet).not.toHaveBeenCalled();
  });
});
