import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { recordingExecute, scissorsManager } from '../../test/assemblyFixture';
import { AssemblyFirstRunCard } from './AssemblyFirstRunCard';

describe('AssemblyFirstRunCard', () => {
  it('makes every checked body a component in one step, the first grounded', () => {
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
      screen.getByRole('heading', {
        name: 'Make an assembly from this document'
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Ground Blade A' })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: 'Insert from another project…' })
    ).toBeDisabled();

    fireEvent.click(
      screen.getByRole('button', { name: 'Use 2 bodies as components' })
    );

    expect(commands.map((c) => c.kind)).toEqual(['assembly.components.add']);
    const components = manager.document.assembly?.components ?? [];
    expect(components.map((c) => [c.name, c.bodyId, c.grounded])).toEqual([
      ['Blade A', a, true],
      ['Blade B', b, false]
    ]);
    expect(onAnnounce).toHaveBeenCalledWith(
      '2 components · 1 grounded. Next: press J to add a joint'
    );
    // One undo takes the whole assembly back out.
    manager.undo();
    expect(manager.document.assembly).toBeUndefined();
  });

  it('leaves unchecked bodies out and follows the ground pins', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Ground Blade B' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Use 1 body as components' })
    );
    expect(
      manager.document.assembly?.components.map((c) => [c.bodyId, c.grounded])
    ).toEqual([[b, true]]);
  });
});
