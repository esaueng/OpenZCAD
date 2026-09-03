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
});
