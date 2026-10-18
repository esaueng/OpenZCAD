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

    // The cell stays, empty, so the buttons after it keep their tracks.
    expect(container.querySelector('.param-value')).toBeEmptyDOMElement();
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

describe('ParameterRow type picker (F05)', () => {
  it('sets the quantity and shows a refusal', async () => {
    const onSetQuantity = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        'Feature "Block" uses "width": expected a length.'
      );
    render(
      <ParameterRow
        parameter={parameter('80')}
        value={80}
        onSet={vi.fn()}
        onSetQuantity={onSetQuantity}
      />
    );
    const picker = screen.getByLabelText('Type of width');
    expect(picker).toHaveValue('unitless');
    fireEvent.change(picker, { target: { value: 'length' } });
    expect(onSetQuantity).toHaveBeenLastCalledWith('width', 'length');
    fireEvent.change(picker, { target: { value: 'angle' } });
    expect(onSetQuantity).toHaveBeenLastCalledWith('width', 'angle');
    expect(
      await screen.findByText(/uses "width": expected a length/)
    ).toBeInTheDocument();
  });

  it('clears a refusal on the next choice and ignores a superseded answer', async () => {
    let answerFirst: (value: string | null) => void = () => {};
    const onSetQuantity = vi
      .fn()
      .mockResolvedValueOnce('No: Feature "Block" uses "width".')
      .mockImplementationOnce(
        () => new Promise<string | null>((resolve) => (answerFirst = resolve))
      )
      .mockResolvedValueOnce(null);
    render(
      <ParameterRow
        parameter={parameter('80')}
        value={80}
        onSet={vi.fn()}
        onSetQuantity={onSetQuantity}
      />
    );
    const picker = screen.getByLabelText('Type of width');
    fireEvent.change(picker, { target: { value: 'angle' } });
    expect(await screen.findByText(/No: Feature "Block"/)).toBeInTheDocument();
    // A new choice clears it at once.
    fireEvent.change(picker, { target: { value: 'number' } });
    expect(screen.queryByText(/No: Feature "Block"/)).toBeNull();
    // A later choice lands first; the slow refusal of the earlier one is
    // stale and never shows.
    fireEvent.change(picker, { target: { value: 'length' } });
    await Promise.resolve();
    answerFirst('Late refusal');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Late refusal')).toBeNull();
  });

  it('drops a refusal and an in-flight answer when undo retypes it', async () => {
    let answer: (value: string | null) => void = () => {};
    const onSetQuantity = vi
      .fn()
      .mockResolvedValueOnce('No: Feature "Block" uses "width".')
      .mockImplementationOnce(
        () => new Promise<string | null>((resolve) => (answer = resolve))
      );
    const props = {
      value: 80,
      onSet: vi.fn(),
      onSetQuantity,
      table: 'width:=80'
    };
    const { rerender } = render(
      <ParameterRow parameter={parameter('80')} {...props} />
    );
    const picker = screen.getByLabelText('Type of width');
    fireEvent.change(picker, { target: { value: 'angle' } });
    expect(await screen.findByText(/No: Feature "Block"/)).toBeInTheDocument();
    // Undo or a collaborator types it as a length; no expression changed.
    const typed = { ...parameter('80'), quantity: 'length' as const };
    rerender(<ParameterRow parameter={typed} {...props} />);
    expect(screen.queryByText(/No: Feature "Block"/)).toBeNull();
    expect(picker).toHaveValue('length');
    // A choice in flight across a retype answers the old type: ignored.
    fireEvent.change(picker, { target: { value: 'number' } });
    rerender(
      <ParameterRow
        parameter={{ ...typed, quantity: 'angle' as const }}
        {...props}
      />
    );
    answer('Late refusal');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Late refusal')).toBeNull();
  });

  it('renders a stored type it does not know without crashing', () => {
    render(
      <ParameterRow
        parameter={
          { ...parameter('80'), quantity: 'mass' } as unknown as ParameterNode
        }
        value={80}
        onSet={vi.fn()}
        onSetQuantity={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Type of width')).toHaveAttribute(
      'title',
      'width is a mass'
    );
  });

  it('offers a suggestion on a unitless parameter without applying it', () => {
    const onSetQuantity = vi.fn();
    render(
      <ParameterRow
        parameter={parameter('80')}
        value={80}
        onSet={vi.fn()}
        onSetQuantity={onSetQuantity}
        suggestedQuantity="length"
      />
    );
    const picker = screen.getByLabelText('Type of width');
    expect(picker).toHaveValue('unitless');
    expect(picker).toHaveClass('suggested');
    expect(picker).toHaveAttribute(
      'title',
      'width is unitless; its uses suggest a length'
    );
    expect(screen.getByRole('option', { name: 'Length' })).toHaveTextContent(
      'len'
    );
    expect(onSetQuantity).not.toHaveBeenCalled();
  });

  it('clears to unitless with null and is absent where retyping is not offered', () => {
    const onSetQuantity = vi.fn();
    const typed = { ...parameter('80'), quantity: 'length' } as ParameterNode;
    const { rerender } = render(
      <ParameterRow
        parameter={typed}
        value={80}
        onSet={vi.fn()}
        onSetQuantity={onSetQuantity}
      />
    );
    const picker = screen.getByLabelText('Type of width');
    expect(picker).toHaveValue('length');
    fireEvent.change(picker, { target: { value: 'unitless' } });
    expect(onSetQuantity).toHaveBeenLastCalledWith('width', null);
    rerender(<ParameterRow parameter={typed} value={80} onSet={vi.fn()} />);
    expect(screen.queryByLabelText('Type of width')).toBeNull();
  });
});
