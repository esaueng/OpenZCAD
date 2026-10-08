import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ParameterNode } from '@openzcad/shared';
import { describe, expect, it, vi } from 'vitest';
import { AddParameterRow, ParameterRow } from './ParameterRows';

function parameter(name: string, expression: string): ParameterNode {
  return {
    id: `node_${name}`,
    parentId: null,
    revisionId: null,
    kind: 'parameter',
    parameterId: `parameter_${name}`,
    name,
    expression,
    value: Number(expression)
  } as ParameterNode;
}

describe('adding a parameter', () => {
  /*
    The add row cleared both fields as soon as it was submitted, without
    waiting for the answer, so a refused add lost what was typed and showed
    no reason beside it.
  */
  it('keeps the typed text and says why when the add is refused', async () => {
    const user = userEvent.setup();
    const onSet = vi
      .fn()
      .mockResolvedValue('"2x" is not a valid parameter name.');
    render(<AddParameterRow onSet={onSet} />);
    const name = screen.getByLabelText('New parameter name');
    const expression = screen.getByLabelText('New parameter expression');
    await user.type(name, '2x');
    await user.type(expression, '5{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '"2x" is not a valid parameter name. Not added.'
    );
    expect(onSet).toHaveBeenCalledWith('2x', '5');
    expect(name).toHaveValue('2x');
    expect(expression).toHaveValue('5');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription(
      '"2x" is not a valid parameter name. Not added.'
    );

    // Editing clears the refusal; a successful add clears the row.
    onSet.mockResolvedValue(null);
    await user.clear(name);
    expect(screen.queryByRole('alert')).toBeNull();
    await user.type(name, 'x2{Enter}');
    await vi.waitFor(() => expect(name).toHaveValue(''));
    expect(expression).toHaveValue('');
  });

  /*
    Setting a parameter is set-by-name, so "w = 99" typed in the add row
    silently replaced an existing w = 30, and every feature using it.
  */
  it('refuses a name already in the table instead of overwriting it', async () => {
    const user = userEvent.setup();
    const onSet = vi.fn().mockResolvedValue(null);
    render(<AddParameterRow onSet={onSet} existingNames={['w', 'h']} />);
    await user.type(screen.getByLabelText('New parameter name'), ' w ');
    await user.type(
      screen.getByLabelText('New parameter expression'),
      '99{Enter}'
    );

    expect(onSet).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'w already exists. Change it in its own row.'
    );
    expect(screen.getByLabelText('New parameter expression')).toHaveValue('99');
  });

  it('says there are no bodies to bind a new toggle to yet', () => {
    render(<AddParameterRow onSet={vi.fn()} onConfigureToggle={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('New parameter type'), {
      target: { value: 'toggle' }
    });
    expect(screen.getByText('No bodies yet.')).toBeInTheDocument();
  });
});

describe('focus after a parameter rename', () => {
  it('returns focus to the name after a rename closes from the keyboard', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn().mockReturnValue(null);
    render(
      <ParameterRow
        parameter={parameter('width', '80')}
        value={80}
        onSet={vi.fn()}
        onRename={onRename}
      />
    );
    const rename = screen.getByRole('button', {
      name: 'Rename parameter width'
    });
    await user.click(rename);
    await user.keyboard('{Escape}');
    expect(
      screen.getByRole('button', { name: 'Rename parameter width' })
    ).toHaveFocus();

    await user.click(
      screen.getByRole('button', { name: 'Rename parameter width' })
    );
    await user.keyboard('{Control>}a{/Control}plate_width{Enter}');
    expect(onRename).toHaveBeenCalledWith('width', 'plate_width');
    expect(
      screen.getByRole('button', { name: 'Rename parameter width' })
    ).toHaveFocus();
  });

  it('keeps the editor closed after Enter commits a rename', async () => {
    const user = userEvent.setup();
    render(
      <ParameterRow
        parameter={parameter('width', '80')}
        value={80}
        onSet={vi.fn()}
        onRename={vi.fn().mockResolvedValue(null)}
      />
    );
    await user.click(
      screen.getByRole('button', { name: 'Rename parameter width' })
    );
    const editor = screen.getByRole('textbox', {
      name: 'Rename parameter width'
    });
    await user.keyboard('{Control>}a{/Control}plate_width');
    // A browser goes on from an uncancelled Enter to press whatever has
    // focus by then: the name button, which reopened the editor.
    expect(fireEvent.keyDown(editor, { key: 'Enter' })).toBe(false);
    expect(
      await screen.findByRole('button', { name: 'Rename parameter width' })
    ).toHaveFocus();
    expect(
      screen.queryByRole('textbox', { name: 'Rename parameter width' })
    ).toBeNull();
  });

  it('puts the caret back in a rename the Enter key had refused', async () => {
    const user = userEvent.setup();
    render(
      <ParameterRow
        parameter={parameter('width', '80')}
        value={80}
        onSet={vi.fn()}
        onRename={vi.fn().mockReturnValue('That name already exists.')}
      />
    );
    await user.click(
      screen.getByRole('button', { name: 'Rename parameter width' })
    );
    await user.keyboard('{Control>}a{/Control}height{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That name already exists. No change applied.'
    );
    expect(
      screen.getByRole('textbox', { name: 'Rename parameter width' })
    ).toHaveFocus();
  });
});

describe('deleting a parameter from the keyboard', () => {
  function Table({ initial }: { initial: ParameterNode[] }) {
    const [parameters, setParameters] = useState(initial);
    return (
      <div className="param-list">
        {parameters.map((entry) => (
          <ParameterRow
            key={entry.parameterId}
            parameter={entry}
            value={entry.value}
            onSet={vi.fn()}
            onRename={vi.fn()}
            onDelete={(name) =>
              setParameters((current) =>
                current.filter((candidate) => candidate.name !== name)
              )
            }
          />
        ))}
        <AddParameterRow onSet={vi.fn()} />
      </div>
    );
  }

  /*
    Deleting removed the focused button with its row and left focus on
    <body>, so the next Tab started again from the top of the page.
  */
  it('moves focus to the next parameter, then to the add row after the last', async () => {
    vi.useFakeTimers();
    try {
      render(<Table initial={[parameter('w', '30'), parameter('h', '20')]} />);
      const deleteW = screen.getByRole('button', {
        name: 'Delete parameter w'
      });
      deleteW.focus();
      fireEvent.click(deleteW);
      act(() => {
        vi.runAllTimers();
      });
      expect(
        screen.getByRole('button', { name: 'Rename parameter h' })
      ).toHaveFocus();

      const deleteH = screen.getByRole('button', {
        name: 'Delete parameter h'
      });
      deleteH.focus();
      fireEvent.click(deleteH);
      act(() => {
        vi.runAllTimers();
      });
      expect(screen.getByLabelText('New parameter name')).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves focus on the button when the delete is refused', () => {
    vi.useFakeTimers();
    try {
      render(
        <div className="param-list">
          <ParameterRow
            parameter={parameter('w', '30')}
            value={30}
            onSet={vi.fn()}
            onDelete={vi.fn()}
          />
          <AddParameterRow onSet={vi.fn()} />
        </div>
      );
      const deleteW = screen.getByRole('button', {
        name: 'Delete parameter w'
      });
      deleteW.focus();
      fireEvent.click(deleteW);
      act(() => {
        vi.runAllTimers();
      });
      expect(deleteW).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });
});
