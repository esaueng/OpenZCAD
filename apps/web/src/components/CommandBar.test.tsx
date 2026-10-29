import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_PROMPT_FILES_EVENT,
  ASSISTANT_PROMPT_KEY_EVENT
} from '../lib/assistant/promptKeys';
import { commandContextFor, toolApplies } from '../lib/commandContext';
import { TOOL_META } from '../lib/tools';
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
  context = null,
  askUnavailable = false,
  attachmentsFull = false,
  pick = null
}: {
  commands: PaletteCommand[];
  onAsk?(question: string): void;
  onOpenChange?(open: boolean): void;
  initialOpen?: boolean;
  draft?: { id: number; text: string } | null;
  context?: string | null;
  askUnavailable?: boolean;
  attachmentsFull?: boolean;
  pick?: string | null;
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
      askUnavailable={askUnavailable}
      attachmentsFull={attachmentsFull}
      pick={pick}
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
  // Recent commands are a device preference; each case starts without any.
  localStorage.clear();
});

describe('CommandBar', () => {
  it('lists the commands run from it first on an empty search, marked Recent (ZC-203)', async () => {
    const commands = [
      command('box', 'Box', 'Create'),
      command('fillet', 'Fillet', 'Modify'),
      command('front', 'Front view', 'View')
    ];
    const { unmount } = render(<Bar commands={commands} />);
    const search = searchField();
    await userEvent.type(search, '/fro');
    await userEvent.keyboard('{Enter}');
    expect(commands[2]!.run).toHaveBeenCalledTimes(1);
    await userEvent.type(search, '/fil');
    await userEvent.keyboard('{Enter}');

    await userEvent.type(search, '/');
    expect(visibleLabels()).toEqual(['Fillet', 'Front view', 'Box']);
    const rows = screen.getAllByRole('option');
    expect(rows[0]).toHaveTextContent('Recent');
    expect(rows[2]).toHaveTextContent('Create');
    unmount();

    // Kept on the device: a fresh bar remembers them.
    render(<Bar commands={commands} />);
    await userEvent.type(searchField(), '/');
    expect(visibleLabels()).toEqual(['Fillet', 'Front view', 'Box']);
  });

  it('matches a command by the initials of its name', async () => {
    const commands = [
      command('lin', 'Line', 'Sketch'),
      command('linear-pattern', 'Linear pattern', 'Pattern'),
      command('normal', 'Normal to selected face', 'View')
    ];
    render(<Bar commands={commands} />);
    await userEvent.type(searchField(), '/lp');
    expect(visibleLabels()).toEqual(['Linear pattern']);
    await userEvent.clear(searchField());
    await userEvent.type(searchField(), '/ntsf');
    expect(visibleLabels()).toEqual(['Normal to selected face']);
  });

  it('lists only the commands that act on the pick on an empty search, and ranks them first when typed', async () => {
    const commands = [
      command('box', 'Box', 'Create', { offPick: true }),
      command('chamfer', 'Chamfer', 'Modify'),
      command('cylinder', 'Cylinder', 'Create', { offPick: true }),
      command('extrude', 'Extrude', 'Create', {
        disabledReason: 'Select a region first'
      }),
      command('fillet', 'Fillet', 'Modify'),
      command('front', 'Front view', 'View')
    ];
    render(<Bar commands={commands} pick="2 edges" />);
    const search = searchField();
    await userEvent.type(search, '/');
    // Body tools and a command the mode cannot run drop out of the list.
    expect(visibleLabels()).toEqual(['Chamfer', 'Fillet', 'Front view']);
    expect(screen.getByText(/For 2 edges · type to search all/)).toBeTruthy();

    // A typed search still reaches everything, the pick's commands first.
    await userEvent.type(search, 'c');
    expect(visibleLabels()).toEqual(['Chamfer', 'Cylinder']);
    await userEvent.clear(search);
    await userEvent.type(search, '/ext');
    expect(visibleLabels()).toEqual(['Extrude']);
    expect(screen.getByRole('option')).toHaveTextContent(
      'Select a region first'
    );
  });

  it('lists Rotate about axis for a picked body, from the shared pick table', async () => {
    const body = commandContextFor({
      edgeCount: 0,
      faceSelected: false,
      bodyCount: 1,
      regionCount: 0
    });
    const commands = (['box', 'axis-rotate', 'mirror'] as const).map((tool) =>
      command(tool, TOOL_META[tool].label, 'Tool', {
        offPick: !toolApplies(body, tool)
      })
    );
    render(<Bar commands={commands} pick="1 body" />);
    await userEvent.type(searchField(), '/');
    expect(visibleLabels()).toEqual(['Rotate about axis', 'Mirror']);
  });

  it('says how to reach every command when nothing can run on the pick', async () => {
    render(
      <Bar
        commands={[command('box', 'Box', 'Create', { offPick: true })]}
        pick="1 face"
      />
    );
    await userEvent.type(searchField(), '/');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Type to search every command'
    );
  });

  it('lists commands for a slash, ranking label matches above group matches', async () => {
    const commands = [
      command('save', 'Save revision', 'File'),
      command('import', 'Import STEP', 'File'),
      command('fillet', 'Fillet', 'Modify')
    ];
    render(<Bar commands={commands} />);
    const search = searchField();

    await userEvent.type(search, '/fil');
    expect(visibleLabels()).toEqual(['Fillet']);
    expect(search).toHaveAttribute('aria-expanded', 'true');

    await userEvent.clear(search);
    await userEvent.type(search, '/file');
    expect(visibleLabels()).toEqual(['Save revision', 'Import STEP']);
  });

  it('searches commands for plain words when there is no assistant', async () => {
    // Signed out, "fil" and Enter did nothing: only "/fil" found Fillet.
    const run = vi.fn();
    const commands = [
      command('import', 'Import CAD files…', 'File'),
      command('fillet', 'Fillet', 'Edges & faces', { run })
    ];
    render(<Bar commands={commands} />);
    const search = searchField();
    expect(search).toHaveAttribute('placeholder', 'Search commands');

    await userEvent.type(search, 'fil');
    expect(visibleLabels()).toEqual(['Fillet', 'Import CAD files…']);
    expect(search).toHaveAttribute('aria-expanded', 'true');
    expect(search).toHaveAttribute(
      'aria-activedescendant',
      'command-palette-option-0'
    );
    // It reads as the slash does: the glyph turns and the stream steps
    // aside for the list.
    expect(document.querySelector('.command-bar')).toHaveClass(
      'command',
      'listing'
    );
    expect(
      screen.getByText('↑↓ move · Tab completes · Enter runs · Esc clears')
    ).toBeTruthy();
    expect(screen.queryByText(/asks the assistant|Type \//)).toBeNull();
    expect(screen.queryByRole('option', { name: /^Ask/ })).toBeNull();
    // The ghost completes the plain word, and Tab keeps it slash-free.
    expect(document.querySelector('.command-bar-ghost')).toHaveTextContent(
      'fillet'
    );
    await userEvent.tab();
    expect(search).toHaveValue('Fillet');

    await userEvent.keyboard('{Enter}');
    expect(run).toHaveBeenCalledTimes(1);
    expect(search).toHaveValue('');
  });

  it('runs the highlighted plain-word match after the arrows move it', async () => {
    const save = vi.fn();
    const saveAs = vi.fn();
    render(
      <Bar
        commands={[
          command('save', 'Save revision', 'File', { run: save }),
          command('save-as', 'Save revision as…', 'File', { run: saveAs })
        ]}
      />
    );
    const search = searchField();
    await userEvent.type(search, 'save{ArrowDown}{ArrowDown}');
    // Held at the last row.
    expect(search).toHaveAttribute(
      'aria-activedescendant',
      'command-palette-option-1'
    );
    await userEvent.keyboard('{ArrowUp}{ArrowDown}{Enter}');
    expect(saveAs).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
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

  it('runs the chosen command after Tab completes a plain-word search with an assistant', async () => {
    const onAsk = vi.fn();
    const run = vi.fn();
    render(
      <Bar
        commands={[command('fillet', 'Fillet', 'Modify', { run })]}
        onAsk={onAsk}
      />
    );
    const search = searchField();
    await userEvent.type(search, 'fil');
    await userEvent.keyboard('{ArrowUp}{Tab}{Enter}');
    expect(run).toHaveBeenCalledOnce();
    expect(onAsk).not.toHaveBeenCalled();
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
      'Search commands or ask about the model'
    );
    // A sentence names no one command, so nothing lists over the stream.
    await userEvent.type(search, '  fillet the top edges 2 mm  ');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    await userEvent.type(search, '{Enter}');
    expect(onAsk).toHaveBeenCalledWith('fillet the top edges 2 mm');
    expect(search).toHaveValue('');
    expect(search).not.toHaveFocus();
  });

  it('says what Enter does with plain words, and where commands are', async () => {
    render(
      <Bar commands={[command('fillet', 'Fillet', 'Modify')]} onAsk={vi.fn()} />
    );
    const search = searchField();
    const hint = 'Enter asks the assistant · type / for commands';

    await userEvent.click(search);
    expect(screen.queryByText(hint)).toBeNull();

    // "grow" names no command; the hint says what Enter does instead of an
    // empty silence.
    await userEvent.type(search, 'grow');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(search).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(hint)).toHaveClass('command-bar-keys');
    expect(screen.getByText(hint).closest('.command-bar-float')).toHaveClass(
      'command-bar-ask'
    );
    expect(search).toHaveAccessibleDescription(hint);

    // The slash swaps it for the command list and its own key row.
    await userEvent.clear(search);
    await userEvent.type(search, '/fil');
    expect(screen.queryByText(hint)).toBeNull();
    expect(visibleLabels()).toEqual(['Fillet']);
    expect(
      screen.getByText('↑↓ move · Tab completes · Enter runs · Esc clears')
    ).toBeTruthy();
    expect(search).not.toHaveAttribute('aria-describedby');
  });

  it('lists the commands plain words name above a highlighted ask row', async () => {
    const onAsk = vi.fn();
    const run = vi.fn();
    render(
      <Bar
        commands={[
          command('fillet', 'Fillet', 'Edges & faces', { run }),
          command('chamfer', 'Chamfer', 'Edges & faces')
        ]}
        onAsk={onAsk}
      />
    );
    const search = searchField();

    await userEvent.type(search, 'fil');
    const ask = screen.getByRole('option', { name: /Ask “fil”/ });
    expect(screen.getAllByRole('option')).toEqual([
      screen.getByRole('option', { name: /Fillet/ }),
      ask
    ]);
    // Enter still asks: the ask row is highlighted, and no ghost offers a
    // command it would not run.
    expect(ask).toHaveAttribute('aria-selected', 'true');
    expect(ask).toHaveClass('palette-row', 'palette-ask', 'active');
    expect(search).toHaveAttribute('aria-activedescendant', ask.id);
    expect(document.querySelector('.command-bar-ghost')).toBeNull();
    // The glyph stays the ask chevron, but the list takes the stream's place.
    const bar = document.querySelector('.command-bar');
    expect(bar).toHaveClass('listing');
    expect(bar).not.toHaveClass('command');
    expect(
      screen.getByText(
        '↑ picks a command · Enter asks the assistant · Esc clears'
      )
    ).toBeTruthy();
    expect(
      screen.queryByText('Enter asks the assistant · type / for commands')
    ).toBeNull();

    // An arrow picks the command; its ghost and Tab work as for the slash.
    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByRole('option', { name: /Fillet/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(
      screen.getByText('↑↓ move · Tab completes · Enter runs · Esc clears')
    ).toBeTruthy();
    expect(document.querySelector('.command-bar-ghost')).toHaveTextContent(
      'fillet'
    );
    // Back down to the ask row, and Enter sends the words.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(ask).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    expect(onAsk).toHaveBeenCalledWith('fil');
    expect(run).not.toHaveBeenCalled();
    expect(search).toHaveValue('');

    // Picking the command runs it rather than asking.
    await userEvent.click(search);
    await userEvent.type(search, 'fil{ArrowUp}{Enter}');
    expect(run).toHaveBeenCalledTimes(1);
    expect(onAsk).toHaveBeenCalledTimes(1);

    // A press on the ask row asks too.
    await userEvent.click(search);
    await userEvent.type(search, 'cham');
    await userEvent.click(screen.getByRole('option', { name: /Ask “cham”/ }));
    expect(onAsk).toHaveBeenLastCalledWith('cham');
  });

  it('leaves an input method its Enter and Escape', async () => {
    const run = vi.fn();
    render(<Bar commands={[command('fillet', 'Fillet', 'Modify', { run })]} />);
    const search = searchField();
    await userEvent.type(search, 'fil');

    fireEvent.keyDown(search, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(search, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(search, { key: 'Escape', isComposing: true });
    expect(run).not.toHaveBeenCalled();
    expect(search).toHaveValue('fil');
    expect(search).toHaveFocus();

    fireEvent.keyDown(search, { key: 'Enter' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('names the selection in its placeholder', () => {
    render(<Bar commands={[]} onAsk={vi.fn()} context="12 selected edges" />);
    expect(searchField()).toHaveAttribute(
      'placeholder',
      'Ask about 12 selected edges…'
    );
  });

  it('stops inviting questions while no provider answers', () => {
    render(
      <Bar
        commands={[]}
        onAsk={vi.fn()}
        context="12 selected edges"
        askUnavailable
      />
    );
    expect(searchField()).toHaveAttribute('placeholder', 'Search commands');
  });

  it('keeps unmatched plain words in place without an assistant', async () => {
    render(<Bar commands={[command('fillet', 'Fillet', 'Modify')]} />);
    const search = searchField();

    await userEvent.type(search, 'round{Enter}');
    expect(search).toHaveValue('round');
    expect(search).toHaveFocus();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent(
      'No matching command.'
    );
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
    // Nothing listening: `p` is a letter, and one Escape clears it and
    // leaves the field, so the next key is the workspace's.
    await userEvent.keyboard('p');
    expect(search).toHaveValue('p');
    await userEvent.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(search).not.toHaveFocus();
    // A typed field never offers its Escape to the stream.
    window.addEventListener(ASSISTANT_PROMPT_KEY_EVENT, take);
    await userEvent.click(search);
    await userEvent.keyboard('q{Escape}');
    expect(search).toHaveValue('');
    expect(search).not.toHaveFocus();
    expect(keys).toEqual(['apply', 'preview', 'reject', 'history']);
    window.removeEventListener(ASSISTANT_PROMPT_KEY_EVENT, take);
  });

  it('hands pasted files to the conversation and keeps pasted text', () => {
    render(<Bar commands={[]} onAsk={vi.fn()} />);
    const search = searchField();
    const files: File[][] = [];
    const take = (event: Event) => {
      files.push((event as CustomEvent<{ files: File[] }>).detail.files);
      event.preventDefault();
    };
    window.addEventListener(ASSISTANT_PROMPT_FILES_EVENT, take);

    const drawing = new File(['png'], 'drawing.png', { type: 'image/png' });
    const taken = !fireEvent.paste(search, {
      clipboardData: { files: [drawing], getData: () => '' }
    });
    expect(taken).toBe(true);
    expect(files).toEqual([[drawing]]);

    // Plain text is not the stream's: the paste goes through as typing.
    const textOnly = !fireEvent.paste(search, {
      clipboardData: { files: [], getData: () => 'round it' }
    });
    expect(textOnly).toBe(false);
    expect(files).toHaveLength(1);
    window.removeEventListener(ASSISTANT_PROMPT_FILES_EVENT, take);
  });

  it('hands picked drawings to the conversation from its attach button', async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(
      <Bar commands={[]} onAsk={vi.fn()} />
    );
    const files: File[][] = [];
    const take = (event: Event) => {
      files.push((event as CustomEvent<{ files: File[] }>).detail.files);
      event.preventDefault();
    };
    window.addEventListener(ASSISTANT_PROMPT_FILES_EVENT, take);
    try {
      const attach = screen.getByRole('button', { name: 'Attach a drawing' });
      expect(attach).toBeEnabled();
      // A press keeps the field's focus: the bar stays open behind the
      // picker.
      expect(fireEvent.mouseDown(attach)).toBe(false);

      const picker =
        container.querySelector<HTMLInputElement>('input[type="file"]')!;
      expect(picker.accept).toBe(
        'image/png,image/jpeg,image/webp,application/pdf'
      );
      const drawing = new File(['png'], 'drawing.png', { type: 'image/png' });
      await user.upload(picker, drawing);
      expect(files).toEqual([[drawing]]);
      // Cleared, so the same drawing picked again still arrives.
      expect(picker.value).toBe('');
    } finally {
      window.removeEventListener(ASSISTANT_PROMPT_FILES_EVENT, take);
      unmount();
    }
  });

  it('offers no drawing pick it could never send', () => {
    const { unmount } = render(
      <Bar commands={[]} onAsk={vi.fn()} askUnavailable />
    );
    expect(
      screen.getByRole('button', { name: 'Attach a drawing' })
    ).toBeDisabled();
    unmount();
    // A full tray would turn the drawing away.
    const full = render(<Bar commands={[]} onAsk={vi.fn()} attachmentsFull />);
    expect(
      screen.getByRole('button', { name: 'Attach a drawing' })
    ).toBeDisabled();
    full.unmount();
    // No assistant at all: the bar is search alone.
    render(<Bar commands={[]} />);
    expect(
      screen.queryByRole('button', { name: 'Attach a drawing' })
    ).toBeNull();
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
    // One Escape clears the field, closes the list and hands focus back: a
    // second press used to be needed, and "?" typed into the field between.
    await userEvent.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(canvas).toHaveFocus();
    expect(search).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();
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
    // One command, so the slash draft below opens a list with a row in it.
    const commands = [command('fillet', 'Fillet', 'Modify')];
    const { rerender } = render(
      <Bar
        commands={commands}
        onAsk={onAsk}
        draft={{ id: 1, text: 'Grow it' }}
      />
    );
    const search = searchField();
    expect(search).toHaveValue('Grow it');
    expect(search).toHaveFocus();

    await userEvent.type(search, ' by 2 mm{Enter}');
    expect(onAsk).toHaveBeenCalledWith('Grow it by 2 mm');
    expect(search).toHaveValue('');

    rerender(
      <Bar
        commands={commands}
        onAsk={onAsk}
        draft={{ id: 1, text: 'Grow it' }}
      />
    );
    expect(search).toHaveValue('');
    rerender(
      <Bar commands={commands} onAsk={onAsk} draft={{ id: 2, text: '/' }} />
    );
    expect(search).toHaveValue('/');
    expect(search).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('CommandBar pointer and empty states', () => {
  it('moves the highlight only when the pointer moves, not when a row appears under it', async () => {
    // The list opens over the viewport, where the pointer rests: the row
    // that appeared under it took the highlight, so Tab and Enter acted on
    // it rather than the best match, and the arrows kept snapping back.
    const commands = [
      command('sketch', 'Sketch', 'Create'),
      command('box', 'Box', 'Create'),
      command('sphere', 'Sphere', 'Create')
    ];
    render(<Bar commands={commands} />);
    const search = searchField();
    await userEvent.type(search, '/');
    const rows = screen.getAllByRole('option');

    fireEvent.mouseEnter(rows[2]!);
    fireEvent.mouseOver(rows[2]!);
    expect(rows[0]).toHaveAttribute('aria-selected', 'true');
    expect(search).toHaveAttribute(
      'aria-activedescendant',
      'command-palette-option-0'
    );
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(rows[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.mouseMove(rows[2]!);
    expect(rows[2]).toHaveAttribute('aria-selected', 'true');
    expect(rows[1]).toHaveAttribute('aria-selected', 'false');
  });

  it('says nothing matched outside the listbox, and drops the key row', async () => {
    render(<Bar commands={[command('fillet', 'Fillet', 'Modify')]} />);
    const search = searchField();
    await userEvent.type(search, '/zzz');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      'No matching command.'
    );
    // Not the ask hint's float, which a docked assistant stream hides.
    expect(
      screen.getByRole('status').closest('.command-bar-float')
    ).not.toHaveClass('command-bar-ask');
    expect(search).toHaveAttribute('aria-expanded', 'false');
    expect(search).not.toHaveAttribute('aria-controls');
    expect(
      screen.queryByText('↑↓ move · Tab completes · Enter runs · Esc clears')
    ).toBeNull();
  });

  it('names Control, not Ctrl, in its key shortcut', () => {
    render(
      <CommandBar
        commands={[]}
        open={false}
        onOpenChange={vi.fn()}
        searchKey={{ glyph: 'Ctrl+K', accessible: 'Ctrl+K' }}
      />
    );
    expect(searchField()).toHaveAttribute('aria-keyshortcuts', 'Control+K');
  });

  it('runs the matching command on Enter while no provider answers', async () => {
    const onAsk = vi.fn();
    const run = vi.fn();
    render(
      <Bar
        commands={[command('fillet', 'Fillet', 'Modify', { run })]}
        onAsk={onAsk}
        askUnavailable
      />
    );
    const search = searchField();
    await userEvent.type(search, 'fil');
    expect(visibleLabels()).toEqual(['Fillet']);
    expect(screen.queryByText(/asks the assistant/)).toBeNull();
    await userEvent.keyboard('{Enter}');
    expect(run).toHaveBeenCalledTimes(1);
    expect(onAsk).not.toHaveBeenCalled();

    // Words that match no command still reach the assistant, whose
    // built-in recipes need no provider.
    await userEvent.click(search);
    await userEvent.type(search, 'add a cube{Enter}');
    expect(onAsk).toHaveBeenCalledWith('add a cube');
  });
});
