import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu';

const ITEMS: ContextMenuItem[] = [
  { id: 'edit', label: 'Edit Properties' },
  { id: 'hide', label: 'Hide Body' },
  { id: 'repair', label: 'Repair Face', disabled: true },
  { id: 'delete', label: 'Delete', danger: true }
];

/**
 * A trigger that opens a menu, so focus has somewhere it was before and
 * somewhere to go back to. Closing the menu unmounts it, which is the moment
 * the focused item stops existing.
 */
function Host({ onSelect = vi.fn() }: { onSelect?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Feature row
      </button>
      {open && (
        <ContextMenu
          menu={{ x: 40, y: 40, items: ITEMS }}
          onSelect={onSelect}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

async function openMenu(onSelect: (id: string) => void = vi.fn()) {
  const user = userEvent.setup();
  render(<Host onSelect={onSelect} />);
  const trigger = screen.getByRole('button', { name: 'Feature row' });
  await user.click(trigger);
  return { user, trigger, onSelect };
}

const enabledNames = ['Edit Properties', 'Hide Body', 'Delete'];

describe('the context menu keyboard contract', () => {
  it('takes focus itself when it opens, arming nothing', async () => {
    await openMenu();
    expect(document.activeElement).toBe(screen.getByRole('menu'));
  });

  it('walks the items with the arrow keys and wraps at both ends', async () => {
    const { user } = await openMenu();

    for (const name of enabledNames) {
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(
        screen.getByRole('menuitem', { name })
      );
    }
    // Past the last item, round to the first.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: enabledNames[0] })
    );
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: enabledNames.at(-1) })
    );
  });

  it('skips a disabled item rather than stalling on it', async () => {
    const { user } = await openMenu();
    // 'Repair Face' sits between 'Hide Body' and 'Delete'. Focusing it is a
    // no-op in a browser, so an implementation that included it would stop
    // the arrow keys dead at 'Hide Body'.
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'Delete' })
    );
    expect(
      screen.getByRole('menuitem', { name: 'Repair Face' })
    ).toBeDisabled();
  });

  it('reaches the last item with End and the first with Home', async () => {
    const { user } = await openMenu();
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'Delete' })
    );
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'Edit Properties' })
    );
  });

  it('runs the focused item on Enter', async () => {
    const onSelect = vi.fn();
    const { user } = await openMenu(onSelect);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith('edit');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('gives focus back to the trigger when it closes', async () => {
    const { user, trigger } = await openMenu();
    await user.keyboard('{ArrowDown}');
    // Establish that focus really left the trigger, or the assertion below
    // is satisfied by a menu that never took focus in the first place.
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'Edit Properties' })
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    // Without this the focused item is simply unmounted and focus falls to
    // the document body, losing the user's place in the tree entirely.
    expect(document.activeElement).toBe(trigger);
  });

  it('leaves focus alone when the chosen action claims it', async () => {
    // Several of these items open a dialog on the same commit that unmounts
    // the menu. Restoring focus unconditionally would pull it straight back
    // out of that dialog.
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    const { user, trigger } = await openMenu(() => elsewhere.focus());
    await user.keyboard('{ArrowDown}{Enter}');
    expect(document.activeElement).toBe(elsewhere);
    expect(document.activeElement).not.toBe(trigger);
    elsewhere.remove();
  });
});
