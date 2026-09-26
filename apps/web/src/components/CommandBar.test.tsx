import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CommandBar, type PaletteCommand } from './CommandBar';

function command(
  id: string,
  label: string,
  group: string,
  options: Partial<PaletteCommand> = {}
): PaletteCommand {
  return {
    id,
    label,
    group,
    run: vi.fn(),
    ...options
  };
}

/** The bar with its host's open state, as App holds it. */
function Bar({
  commands,
  onAsk,
  onOpenChange,
  initialOpen = false
}: {
  commands: PaletteCommand[];
  onAsk?(question: string): void;
  onOpenChange?(open: boolean): void;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <CommandBar
      commands={commands}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
      {...(onAsk ? { onAsk } : {})}
      searchKey={{ glyph: '⌘K', accessible: 'Cmd+K' }}
    />
  );
}

function searchField(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Search commands' });
}

function visibleLabels(): string[] {
  return screen.getAllByRole('option').map((option) => {
    const label = option.querySelector('.palette-label');
    expect(label).not.toBeNull();
    return label?.textContent ?? '';
  });
}

describe('CommandBar', () => {
  it('ranks label matches above group matches for fil', async () => {
    const commands = [
      command('save', 'Save revision', 'File'),
      command('import', 'Import STEP', 'File'),
      command('fillet', 'Fillet', 'Modify')
    ];
    render(<Bar commands={commands} />);

    await userEvent.type(searchField(), 'fil');

    expect(visibleLabels()).toEqual(['Fillet']);
  });

  it('keeps equally ranked exp label matches in source order', async () => {
    const commands = [
      command('export-step', 'Export STEP', 'File'),
      command('export-mesh', 'Export mesh', 'File'),
      command('settings', 'Open settings', 'General')
    ];
    render(<Bar commands={commands} />);

    await userEvent.type(searchField(), 'exp');

    expect(visibleLabels()).toEqual(['Export STEP', 'Export mesh']);
  });

  it('matches a command by its keywords as well as its label', async () => {
    const commands = [
      command('export-dxf', 'Export face outline as DXF', 'File', {
        keywords: ['laser', 'outline']
      }),
      command('import', 'Import CAD files…', 'File', {
        keywords: ['step', 'stl']
      }),
      command('export-step', 'Export STEP', 'File')
    ];
    render(<Bar commands={commands} />);
    const search = searchField();

    await userEvent.type(search, 'laser');
    expect(visibleLabels()).toEqual(['Export face outline as DXF']);

    await userEvent.clear(search);
    await userEvent.type(search, 'step');
    expect(visibleLabels()).toEqual(['Export STEP', 'Import CAD files…']);
  });

  it('does not run a disabled result by click or Enter', async () => {
    const run = vi.fn();
    render(
      <Bar
        commands={[
          command('export-step', 'Export STEP', 'File', {
            disabledReason: 'Create a body first',
            run
          })
        ]}
      />
    );

    const search = searchField();
    await userEvent.type(search, 'exp');
    const result = screen.getByRole('option');
    expect(within(result).getByText('Create a body first')).toBeTruthy();

    await userEvent.click(result);
    await userEvent.type(search, '{Enter}');

    expect(run).not.toHaveBeenCalled();
    expect(search).toHaveAttribute('aria-expanded', 'true');
    expect(search).toHaveFocus();
  });

  it('ends the list with an Ask row that sends the typed words to the assistant', async () => {
    const onAsk = vi.fn();
    const commands = [
      command('fillet', 'Fillet', 'Modify'),
      command('front', 'Front view', 'View')
    ];
    render(<Bar commands={commands} onAsk={onAsk} />);

    const search = searchField();
    expect(search).toHaveAttribute(
      'placeholder',
      'Search commands or ask the assistant'
    );
    await userEvent.click(search);
    expect(search).toHaveAttribute(
      'placeholder',
      expect.stringContaining('or a question')
    );
    // Nothing typed, nothing to ask: the Ask row waits for words.
    expect(visibleLabels()).not.toContain(
      expect.stringContaining('Ask the assistant')
    );

    await userEvent.type(search, 'fil');
    // A command match still comes first, so Enter runs it, not the question.
    expect(visibleLabels()).toEqual(['Fillet', 'Ask the assistant: “fil”']);
    await userEvent.click(
      screen.getByRole('option', { name: /Ask the assistant/ })
    );
    expect(onAsk).toHaveBeenCalledWith('fil');
    expect(search).toHaveAttribute('aria-expanded', 'false');
    expect(search).toHaveValue('');
  });

  it('asks on Enter when no command matches', async () => {
    const onAsk = vi.fn();
    render(
      <Bar commands={[command('fillet', 'Fillet', 'Modify')]} onAsk={onAsk} />
    );

    const search = searchField();
    await userEvent.type(search, '  round the top edges 2 mm  ');
    expect(
      screen.getByText('No matching command. Enter asks the assistant.')
    ).toBeTruthy();
    await userEvent.type(search, '{Enter}');
    expect(onAsk).toHaveBeenCalledWith('round the top edges 2 mm');
  });

  it('offers no Ask row without an assistant', async () => {
    render(<Bar commands={[command('fillet', 'Fillet', 'Modify')]} />);

    await userEvent.type(searchField(), 'round');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matching command.')).toBeTruthy();
  });

  it('turns the whole bar into a question on Tab, and Shift+Tab still leaves it', async () => {
    const onAsk = vi.fn();
    render(
      <>
        <Bar commands={[command('fillet', 'Fillet', 'Modify')]} onAsk={onAsk} />
        <button type="button">Next</button>
      </>
    );
    const search = searchField();

    await userEvent.type(search, 'fillet');
    // A command matches, so Enter would run it; Tab makes it a question.
    expect(visibleLabels()[0]).toBe('Fillet');
    await userEvent.tab();
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute('placeholder', 'Ask the assistant…');
    expect(search).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(search).toHaveAccessibleDescription(
      'Enter sends this to the assistant · Tab goes back to commands'
    );

    await userEvent.tab();
    expect(visibleLabels()).toContain('Fillet');
    await userEvent.tab();
    await userEvent.type(search, '{Enter}');
    expect(onAsk).toHaveBeenCalledWith('fillet');
    expect(search).not.toHaveFocus();

    await userEvent.click(search);
    await userEvent.tab({ shift: true });
    expect(search).not.toHaveFocus();
  });

  it('runs a command from the list and hands focus back to where it was', async () => {
    const run = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <>
        <button type="button">Canvas</button>
        <Bar
          commands={[command('fillet', 'Fillet', 'Modify', { run })]}
          onOpenChange={onOpenChange}
        />
      </>
    );
    const canvas = screen.getByRole('button', { name: 'Canvas' });
    canvas.focus();
    const search = searchField();

    await userEvent.click(search);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    await userEvent.click(screen.getByRole('option', { name: /Fillet/ }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    canvas.focus();
    await userEvent.type(search, 'fil');
    await userEvent.keyboard('{Escape}');
    expect(canvas).toHaveFocus();
    expect(search).toHaveValue('');
    expect(search).toHaveAttribute('aria-expanded', 'false');
  });

  it('takes focus when its host opens it, as ⌘K does', () => {
    render(
      <Bar commands={[command('fillet', 'Fillet', 'Modify')]} initialOpen />
    );
    const search = searchField();
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute('aria-expanded', 'true');
    expect(search).toHaveAttribute(
      'aria-activedescendant',
      'command-palette-option-0'
    );
  });

  it('hands the assistant a slot inside the bar, before the key glyph', () => {
    const onAssistantSlot = vi.fn();
    render(
      <CommandBar
        commands={[]}
        open={false}
        onOpenChange={vi.fn()}
        searchKey={{ glyph: '⌘K', accessible: 'Cmd+K' }}
        onAssistantSlot={onAssistantSlot}
      />
    );
    const slot = onAssistantSlot.mock.calls[0]?.[0] as HTMLElement;
    expect(slot).toHaveClass('command-bar-slot');
    expect(slot.parentElement).toHaveClass('command-bar');
    expect(slot.nextElementSibling).toHaveTextContent('⌘K');
    expect(searchField()).toHaveAttribute('aria-keyshortcuts', 'Meta+K');
  });
});
