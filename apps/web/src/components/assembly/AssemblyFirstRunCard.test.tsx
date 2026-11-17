import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { recordingExecute, scissorsManager } from '../../test/assemblyFixture';
import { AssemblyFirstRunCard } from './AssemblyFirstRunCard';

describe('AssemblyFirstRunCard', () => {
  it('makes every checked body a part in one step, the first fixed', () => {
    const { manager, a, b, live } = scissorsManager();
    const { commands, execute } = recordingExecute(manager);
    const onAnnounce = vi.fn();
    render(
      <AssemblyFirstRunCard
        document={live()}
        execute={execute}
        onAnnounce={onAnnounce}
      />
    );
    expect(
      screen.getByRole('heading', { name: 'Start an assembly' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Fix Blade A in place' })
    ).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Add 2 parts' }));

    expect(commands.map((c) => c.kind)).toEqual(['assembly.components.add']);
    const components = manager.document.assembly?.components ?? [];
    expect(components.map((c) => [c.name, c.bodyId, c.grounded])).toEqual([
      ['Blade A', a, true],
      ['Blade B', b, false]
    ]);
    expect(onAnnounce).toHaveBeenCalledWith(
      '2 parts · 1 fixed. Next: Set up motion to make one move'
    );
    // One undo takes the whole assembly back out.
    manager.undo();
    expect(manager.document.assembly).toBeUndefined();
  });

  it('hands "fixed" to a ticked body when the fixed one is unticked', () => {
    const { manager, b, live } = scissorsManager();
    const { execute } = recordingExecute(manager);
    render(
      <AssemblyFirstRunCard
        document={live()}
        execute={execute}
        onAnnounce={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Blade A' }));
    // The unticked row no longer claims to be fixed; Blade B now is.
    const pinA = screen.getByRole('button', { name: 'Fix Blade A in place' });
    expect(pinA).toHaveAttribute('aria-pressed', 'false');
    expect(pinA).toBeDisabled();
    expect(pinA).toHaveTextContent('Fix');
    expect(
      screen.getByRole('button', { name: 'Fix Blade B in place' })
    ).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 part' }));
    expect(
      manager.document.assembly?.components.map((c) => [c.bodyId, c.grounded])
    ).toEqual([[b, true]]);
  });

  it('follows the fix pins', () => {
    const { manager, a, b, live } = scissorsManager();
    const { execute } = recordingExecute(manager);
    render(
      <AssemblyFirstRunCard
        document={live()}
        execute={execute}
        onAnnounce={vi.fn()}
      />
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Fix Blade B in place' })
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Fix Blade A in place' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 parts' }));
    expect(
      manager.document.assembly?.components.map((c) => [c.bodyId, c.grounded])
    ).toEqual([
      [a, false],
      [b, true]
    ]);
  });
});
