import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeymapOverrides } from '@openzcad/shared';
import { setActiveKeymapOverrides } from '../lib/keymap';
import { KeymapEditor } from './KeymapEditor';
import { ShortcutsOverlay } from './ShortcutsOverlay';

function Harness({ onChange }: { onChange(next: KeymapOverrides): void }) {
  const [overrides, setOverrides] = useState<KeymapOverrides>({});
  return (
    <KeymapEditor
      overrides={overrides}
      onChange={(next) => {
        onChange(next);
        setOverrides(next);
      }}
    />
  );
}

function row(commandId: string): HTMLElement {
  return document.querySelector(
    `[data-keymap-command="${commandId}"]`
  ) as HTMLElement;
}

afterEach(() => setActiveKeymapOverrides({}));

describe('KeymapEditor', () => {
  it('adds a key, removes the default and resets', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const add = screen.getByRole('button', {
      name: 'Add a shortcut for Toggle the grid'
    });
    fireEvent.click(add);
    expect(add).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(add, { key: 'h', code: 'KeyH' });
    expect(onChange).toHaveBeenLastCalledWith({ 'view-grid': ['G', 'H'] });

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove G from Toggle the grid' })
    );
    expect(onChange).toHaveBeenLastCalledWith({ 'view-grid': ['H'] });
    expect(within(row('view-grid')).getByText('H')).toBeInTheDocument();
    expect(
      screen.getByText('1 command has a custom shortcut.')
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Reset Toggle the grid' })
    );
    expect(onChange).toHaveBeenLastCalledWith({});
    expect(within(row('view-grid')).getByText('G')).toBeInTheDocument();
  });

  it('refuses a taken key and names the command holding it', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const add = screen.getByRole('button', {
      name: 'Add a shortcut for Toggle the grid'
    });
    fireEvent.click(add);
    fireEvent.keyDown(add, { key: 'f', code: 'KeyF' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'F is already Fit view. Remove it there first.'
    );
    expect(onChange).not.toHaveBeenCalled();
    // Still listening: the refusal is not the end of the capture.
    expect(add).toHaveAttribute('aria-pressed', 'true');
  });

  it('refuses a key the command already has', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const add = screen.getByRole('button', {
      name: 'Add a shortcut for Toggle the grid'
    });
    fireEvent.click(add);
    fireEvent.keyDown(add, { key: 'g', code: 'KeyG' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'G is already a shortcut for Toggle the grid.'
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(within(row('view-grid')).getAllByText('G')).toHaveLength(1);
  });

  it('keeps Escape for cancelling and lets Settings stay open', () => {
    const onChange = vi.fn();
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    render(<Harness onChange={onChange} />);
    const add = screen.getByRole('button', {
      name: 'Add a shortcut for Fit view'
    });
    fireEvent.click(add);
    fireEvent.keyDown(add, { key: 'Escape', code: 'Escape' });
    window.removeEventListener('keydown', outside);
    expect(add).toHaveAttribute('aria-pressed', 'false');
    expect(onChange).not.toHaveBeenCalled();
    // Settings closes on a window Escape; the capture keeps it.
    expect(outside).not.toHaveBeenCalled();
  });

  it('resets every shortcut at once', () => {
    const onChange = vi.fn();
    render(
      <KeymapEditor
        overrides={{ 'view-grid': ['H'], 'tool-fillet': ['J'] }}
        onChange={onChange}
      />
    );
    expect(
      screen.getByText('2 commands have a custom shortcut.')
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Reset all shortcuts' })
    );
    expect(onChange).toHaveBeenCalledWith({});
  });

  it('shows saved shortcuts as assigned and newly conflicting defaults as unassigned', () => {
    render(
      <KeymapEditor
        overrides={{ 'view-grid': ['5'], 'tool-extrude': ['6'] }}
        onChange={vi.fn()}
      />
    );
    expect(within(row('view-grid')).getByText('5')).toBeInTheDocument();
    expect(within(row('tool-extrude')).getByText('6')).toBeInTheDocument();
    expect(
      within(row('view-back')).getByText('Unassigned')
    ).toBeInTheDocument();
    expect(
      within(row('view-bottom')).getByText('Unassigned')
    ).toBeInTheDocument();
    expect(within(row('view-back')).queryByText('5')).not.toBeInTheDocument();
  });

  it('shows a remap in the shortcut overlay', () => {
    act(() => setActiveKeymapOverrides({ 'view-grid': ['H'] }));
    render(<ShortcutsOverlay onClose={vi.fn()} />);
    const grid = screen.getByText('Toggle the grid').closest('.shortcut-row');
    expect(grid).not.toBeNull();
    expect(within(grid as HTMLElement).getByText('H')).toBeInTheDocument();
  });
});
