import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_PROMPT_KEY_EVENT } from '../lib/assistant/promptKeys';
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
  initialOpen = false,
  draft = null,
  context = null
}: {
  commands: PaletteCommand[];
  onAsk?(question: string): void;
  onOpenChange?(open: boolean): void;
  initialOpen?: boolean;
  draft?: { id: number; text: string } | null;
  context?: string | null;
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
      draft={draft}
      context={context}
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CommandBar', () => {
  it('lists commands only after a slash, ranking label matches above group matches', async () => {
    const commands = [
      command('save', 'Save revision', 'File'),
      command('import', 'Import STEP', 'File'),
      command('fillet', 'Fillet', 'Modify')
    ];
    render(<Bar commands={commands} />);
    const search = searchField();

    await userEvent.type(search, 'fil');
    // Plain words are a question, not a search: nothing lists.
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(search).toHaveAttribute('aria-expanded', 'false');

    await userEvent.clear(search);
    await userEvent.type(search, '/fil');
    expect(visibleLabels()).toEqual(['Fillet']);
    expect(search).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps equally ranked label matches in source order', async () => {
    const commands = [
      command('export-step', 'Export STEP', 'File'),
      command('export-mesh', 'Export mesh', 'File'),
      command('settings', 'Open settings', 'General')
    ];
    render(<Bar commands={commands} />);

    await userEvent.type(searchField(), '/exp');

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

    await userEvent.type(search, '/laser');
    expect(visibleLabels()).toEqual(['Export face outline as DXF']);

    await userEvent.clear(search);
    await userEvent.type(search, '/step');
    expect(visibleLabels()).toEqual(['Export STEP', 'Import CAD files…']);
  });

  it('completes the highlighted command in ghost text and accepts it on Tab', async () => {
    const run = vi.fn();
    const commands = [
      command('cylinder', 'Cylinder', 'Create', { run }),
      command('cone', 'Cone', 'Create')
    ];
    render(<Bar commands={commands} />);
    const search = searchField();

    await userEvent.type(search, '/cy');
    const ghost = document.querySelector('.command-bar-ghost');
    expect(ghost).toHaveTextContent('/cylinder');
    // Only the rest of the name shows; the typed part is invisible under
    // the field's own text.
    expect(ghost?.querySelector('.command-bar-ghost-typed')).toHaveTextContent(
      '/cy'
    );

    await userEvent.tab();
    expect(search).toHaveFocus();
    expect(search).toHaveValue('/Cylinder');
    await userEvent.type(search, '{Enter}');
    expect(run).toHaveBeenCalledTimes(1);
    expect(search).toHaveValue('');
  });

  it('offers no ghost when the typed text is not the start of a name', async () => {
    render(
      <Bar
        commands={[command('export-dxf', 'Export face outline as DXF', 'File')]}
      />
    );
    await userEvent.type(searchField(), '/dxf');
    expect(visibleLabels()).toEqual(['Export face outline as DXF']);
    expect(document.querySelector('.command-bar-ghost')).toBeNull();
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
    await userEvent.type(search, '/exp');
    const result = screen.getByRole('option');
    expect(within(result).getByText('Create a body first')).toBeTruthy();

    await userEvent.click(result);
    await userEvent.type(search, '{Enter}');

    expect(run).not.toHaveBeenCalled();
    expect(search).toHaveAttribute('aria-expanded', 'true');
    expect(search).toHaveFocus();
  });

  it('sends plain words to the assistant on Enter', async () => {
    const onAsk = vi.fn();
    render(
      <Bar commands={[command('fillet', 'Fillet', 'Modify')]} onAsk={onAsk} />
    );

    const search = searchField();
    expect(search).toHaveAttribute(
      'placeholder',
      'Ask about the model, or / for a command'
    );
    // Words that name a command are still a question: the slash decides.
    await userEvent.type(search, '  fillet the top edges 2 mm  ');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    await userEvent.type(search, '{Enter}');
    expect(onAsk).toHaveBeenCalledWith('fillet the top edges 2 mm');
    expect(search).toHaveValue('');
    expect(search).not.toHaveFocus();
  });

  it('names the selection in its placeholder', () => {
    render(<Bar commands={[]} onAsk={vi.fn()} context="12 selected edges" />);
    expect(searchField()).toHaveAttribute(
      'placeholder',
      'Ask about 12 selected edges…'
    );
  });

  it('keeps plain words in place without an assistant', async () => {
    render(<Bar commands={[command('fillet', 'Fillet', 'Modify')]} />);
    const search = searchField();
    expect(search).toHaveAttribute('placeholder', 'Type / for a command');

    await userEvent.type(search, 'round{Enter}');
    expect(search).toHaveValue('round');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('hands the empty prompt keys to the conversation, and keeps them when nothing takes them', async () => {
    render(<Bar commands={[]} onAsk={vi.fn()} />);
    const search = searchField();
    const keys: string[] = [];
    const take = (event: Event) => {
      keys.push((event as CustomEvent<{ key: string }>).detail.key);
      event.preventDefault();
    };
    window.addEventListener(ASSISTANT_PROMPT_KEY_EVENT, take);

    await userEvent.click(search);
    await userEvent.keyboard('{Enter}p{Escape}');
    expect(keys).toEqual(['apply', 'preview', 'reject']);
    // Taken: the letter was not typed and Escape did not drop focus.
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    await userEvent.keyboard('{Control>}{ArrowUp}{/Control}');
    expect(keys).toEqual(['apply', 'preview', 'reject', 'history']);

    window.removeEventListener(ASSISTANT_PROMPT_KEY_EVENT, take);
    // Nothing listening: `p` is a letter and Escape leaves the field.
    await userEvent.keyboard('p');
    expect(search).toHaveValue('p');
    await userEvent.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    await userEvent.keyboard('{Escape}');
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
    await userEvent.type(search, '/');
    await userEvent.click(screen.getByRole('option', { name: /Fillet/ }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    canvas.focus();
    await userEvent.type(search, '/fil');
    // Escape clears first, then leaves.
    await userEvent.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(canvas).toHaveFocus();
    expect(search).toHaveAttribute('aria-expanded', 'false');
  });

  it('takes focus when its host opens it, as ⌘K does', () => {
    render(
      <Bar commands={[command('fillet', 'Fillet', 'Modify')]} initialOpen />
    );
    const search = searchField();
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute('aria-keyshortcuts', 'Meta+K');
  });

  it('takes a draft from its host, once per draft id', async () => {
    const onAsk = vi.fn();
    const { rerender } = render(
      <Bar commands={[]} onAsk={onAsk} draft={{ id: 1, text: 'Grow it' }} />
    );
    const search = searchField();
    expect(search).toHaveValue('Grow it');
    expect(search).toHaveFocus();

    await userEvent.type(search, ' by 2 mm{Enter}');
    expect(onAsk).toHaveBeenCalledWith('Grow it by 2 mm');
    expect(search).toHaveValue('');

    rerender(
      <Bar commands={[]} onAsk={onAsk} draft={{ id: 1, text: 'Grow it' }} />
    );
    expect(search).toHaveValue('');
    rerender(<Bar commands={[]} onAsk={onAsk} draft={{ id: 2, text: '/' }} />);
    expect(search).toHaveValue('/');
    expect(search).toHaveAttribute('aria-expanded', 'true');
  });
});
