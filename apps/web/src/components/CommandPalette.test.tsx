import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette, type PaletteCommand } from './CommandPalette';

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

function visibleLabels(): string[] {
  return screen.getAllByRole('option').map((option) => {
    const label = option.querySelector('.palette-label');
    expect(label).not.toBeNull();
    return label?.textContent ?? '';
  });
}

describe('CommandPalette', () => {
  it('ranks label matches above group matches for fil', async () => {
    const commands = [
      command('save', 'Save revision', 'File'),
      command('import', 'Import STEP', 'File'),
      command('fillet', 'Fillet', 'Modify')
    ];
    render(<CommandPalette commands={commands} onClose={vi.fn()} />);

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Search commands' }),
      'fil'
    );

    expect(visibleLabels()).toEqual(['Fillet']);
  });

  it('keeps equally ranked exp label matches in source order', async () => {
    const commands = [
      command('export-step', 'Export STEP', 'File'),
      command('export-mesh', 'Export mesh', 'File'),
      command('settings', 'Open settings', 'General')
    ];
    render(<CommandPalette commands={commands} onClose={vi.fn()} />);

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Search commands' }),
      'exp'
    );

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
    render(<CommandPalette commands={commands} onClose={vi.fn()} />);
    const search = screen.getByRole('textbox', { name: 'Search commands' });

    await userEvent.type(search, 'laser');
    expect(visibleLabels()).toEqual(['Export face outline as DXF']);

    await userEvent.clear(search);
    await userEvent.type(search, 'step');
    expect(visibleLabels()).toEqual(['Export STEP', 'Import CAD files…']);
  });

  it('does not run a disabled result by click or Enter', async () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandPalette
        commands={[
          command('export-step', 'Export STEP', 'File', {
            disabledReason: 'Create a body first',
            run
          })
        ]}
        onClose={onClose}
      />
    );

    const search = screen.getByRole('textbox', { name: 'Search commands' });
    await userEvent.type(search, 'exp');
    const result = screen.getByRole('option');
    expect(within(result).getByText('Create a body first')).toBeTruthy();

    await userEvent.click(result);
    await userEvent.type(search, '{Enter}');

    expect(run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ends the list with an Ask row that sends the typed words to the assistant', async () => {
    const onAsk = vi.fn();
    const onClose = vi.fn();
    const commands = [
      command('fillet', 'Fillet', 'Modify'),
      command('front', 'Front view', 'View')
    ];
    render(
      <CommandPalette commands={commands} onClose={onClose} onAsk={onAsk} />
    );

    const search = screen.getByRole('textbox', { name: 'Search commands' });
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
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onAsk).toHaveBeenCalledWith('fil');
  });

  it('asks on Enter when no command matches', async () => {
    const onAsk = vi.fn();
    render(
      <CommandPalette
        commands={[command('fillet', 'Fillet', 'Modify')]}
        onClose={vi.fn()}
        onAsk={onAsk}
      />
    );

    const search = screen.getByRole('textbox', { name: 'Search commands' });
    await userEvent.type(search, '  round the top edges 2 mm  ');
    expect(
      screen.getByText('No matching command. Enter asks the assistant.')
    ).toBeTruthy();
    await userEvent.type(search, '{Enter}');
    expect(onAsk).toHaveBeenCalledWith('round the top edges 2 mm');
  });

  it('offers no Ask row without an assistant', async () => {
    render(
      <CommandPalette
        commands={[command('fillet', 'Fillet', 'Modify')]}
        onClose={vi.fn()}
      />
    );

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Search commands' }),
      'round'
    );
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matching command.')).toBeTruthy();
  });
});
