import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PanelLayoutOptions } from '../../lib/panelLayout';
import {
  LAYOUT_LOCKED_DETAIL,
  PANEL_LAYOUT_MENU_MARGIN,
  PanelsHiddenPill,
  ViewOptionsMenu,
  placePanelLayoutMenu,
  type ViewOptionsMenuProps
} from './ViewOptionsMenu';

const OPTIONS: PanelLayoutOptions = {
  hidden: false,
  locked: false,
  compact: false,
  hug: false,
  width: 'regular'
};

function renderMenu(overrides: Partial<ViewOptionsMenuProps> = {}) {
  const props: ViewOptionsMenuProps = {
    options: OPTIONS,
    preset: 'essentials',
    hideShortcut: 'Ctrl+\\',
    onPreset: vi.fn(),
    onToggle: vi.fn(),
    onWidth: vi.fn(),
    ...overrides
  };
  const view = render(<ViewOptionsMenu {...props} />);
  return { props, ...view };
}

describe('ViewOptionsMenu', () => {
  it('opens a menu of named groups with radio and checkbox items', async () => {
    const user = userEvent.setup();
    renderMenu();
    const button = screen.getByRole('button', { name: 'Panel layout' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = within(screen.getByRole('menu', { name: 'Panel layout' }));

    const layouts = within(menu.getByRole('group', { name: 'Layout' }));
    expect(
      layouts.getAllByRole('menuitemradio').map((item) => item.textContent)
    ).toEqual([
      expect.stringContaining('Essentials'),
      expect.stringContaining('Full workspace'),
      expect.stringContaining('Modeling'),
      expect.stringContaining('Review'),
      expect.stringContaining('Model only')
    ]);
    const essentials = layouts.getByRole('menuitemradio', {
      name: 'Essentials'
    });
    expect(essentials).toHaveAttribute('aria-checked', 'true');
    expect(essentials).toHaveAccessibleDescription(
      'Objects left, Parameters right'
    );
    expect(
      layouts.getByRole('menuitemradio', { name: 'Review' })
    ).toHaveAttribute('aria-checked', 'false');

    const settings = within(menu.getByRole('group', { name: 'Settings' }));
    const hide = settings.getByRole('menuitemcheckbox', {
      name: 'Hide all panels'
    });
    expect(hide).toHaveAttribute('aria-checked', 'false');
    expect(hide).toHaveTextContent('Ctrl+\\');
    for (const name of ['Lock layout', 'Compact rows']) {
      expect(settings.getByRole('menuitemcheckbox', { name })).toHaveAttribute(
        'aria-checked',
        'false'
      );
    }

    const widths = within(menu.getByRole('group', { name: 'Panel width' }));
    expect(
      widths
        .getAllByRole('menuitemradio')
        .map((item) => [
          item.getAttribute('aria-label'),
          item.getAttribute('aria-checked')
        ])
    ).toEqual([
      ['Small', 'false'],
      ['Medium', 'true'],
      ['Large', 'false']
    ]);
    expect(
      widths.getByRole('menuitemradio', { name: 'Large' })
    ).toHaveAccessibleDescription('360 px');
  });

  it('acts on each item and stays open, so a setting reads back at once', async () => {
    const user = userEvent.setup();
    const { props } = renderMenu({ preset: null });
    await user.click(screen.getByRole('button', { name: 'Panel layout' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Review' }));
    expect(props.onPreset).toHaveBeenCalledWith('review');
    await user.click(
      screen.getByRole('menuitemcheckbox', { name: 'Hide all panels' })
    );
    await user.click(
      screen.getByRole('menuitemcheckbox', { name: 'Compact rows' })
    );
    await user.click(screen.getByRole('menuitemradio', { name: 'Small' }));
    expect(props.onToggle).toHaveBeenNthCalledWith(1, 'hidden');
    expect(props.onToggle).toHaveBeenNthCalledWith(2, 'compact');
    expect(props.onWidth).toHaveBeenCalledWith('narrow');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // No preset matches a rearranged layout.
    for (const item of within(
      screen.getByRole('group', { name: 'Layout' })
    ).getAllByRole('menuitemradio')) {
      expect(item).toHaveAttribute('aria-checked', 'false');
    }
  });

  it('disables the presets and the width while locked, and says why', async () => {
    const user = userEvent.setup();
    const { props } = renderMenu({ options: { ...OPTIONS, locked: true } });
    await user.click(screen.getByRole('button', { name: 'Panel layout' }));
    const radios = screen.getAllByRole('menuitemradio');
    expect(radios).toHaveLength(8);
    for (const radio of radios) {
      expect(radio).toBeDisabled();
      expect(radio).toHaveAccessibleDescription(LAYOUT_LOCKED_DETAIL);
    }
    const lock = screen.getByRole('menuitemcheckbox', { name: 'Lock layout' });
    expect(lock).toHaveAttribute('aria-checked', 'true');
    for (const name of ['Hide all panels', 'Lock layout', 'Compact rows']) {
      expect(screen.getByRole('menuitemcheckbox', { name })).toBeEnabled();
    }
    await user.click(lock);
    expect(props.onToggle).toHaveBeenCalledWith('locked');
  });

  it('moves between enabled items by arrow key and closes on Escape and Tab', async () => {
    const user = userEvent.setup();
    renderMenu({ options: { ...OPTIONS, locked: true } });
    const button = screen.getByRole('button', { name: 'Panel layout' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toHaveFocus();
    // The disabled presets are skipped: the first stop is Hide all.
    await user.keyboard('{ArrowDown}');
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Hide all panels' })
    ).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Lock layout' })
    ).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on a press outside, and the button toggles it', async () => {
    const user = userEvent.setup();
    renderMenu();
    const button = screen.getByRole('button', { name: 'Panel layout' });
    await user.click(button);
    await user.click(button);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(button);
    await user.click(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('placePanelLayoutMenu', () => {
  const menu = { width: 266, height: 570 };
  const viewport = { width: 1440, height: 900 };

  it('hangs from the button where the window has the room', () => {
    expect(
      placePanelLayoutMenu(
        { left: 1096, top: 200, bottom: 232 },
        menu,
        viewport
      )
    ).toEqual({ x: 820, y: 196 });
  });

  it('rises from the button rather than pressing against the window foot', () => {
    // The rail's last buttons at 1440 × 900: hanging from the top the menu
    // ended at 892 of 900, lower than every island on the stage.
    const placed = placePanelLayoutMenu(
      { left: 1096, top: 684, bottom: 716 },
      menu,
      viewport
    );
    expect(placed).toEqual({ x: 820, y: 150 });
    expect(placed.y + menu.height).toBe(720);
    expect(viewport.height - (placed.y + menu.height)).toBeGreaterThanOrEqual(
      PANEL_LAYOUT_MENU_MARGIN
    );
  });

  it('keeps its margin at both ends of a window too short to hold it', () => {
    const short = { width: 1440, height: 420 };
    // CSS caps the height at the window less both margins; it scrolls inside.
    const capped = { width: 266, height: short.height - 32 };
    const placed = placePanelLayoutMenu(
      { left: 1096, top: 330, bottom: 362 },
      capped,
      short
    );
    expect(placed.y).toBe(PANEL_LAYOUT_MENU_MARGIN);
    expect(placed.y + capped.height).toBe(
      short.height - PANEL_LAYOUT_MENU_MARGIN
    );
  });

  it('stays in the window beside a rail with no room to its left', () => {
    expect(
      placePanelLayoutMenu({ left: 120, top: 100, bottom: 132 }, menu, {
        width: 390,
        height: 800
      }).x
    ).toBe(8);
  });
});

describe('PanelsHiddenPill', () => {
  it('says the panels are hidden and shows them', async () => {
    const user = userEvent.setup();
    const onShow = vi.fn();
    render(<PanelsHiddenPill onShow={onShow} />);
    expect(screen.getByRole('status')).toHaveTextContent('Panels hidden');
    await user.click(screen.getByRole('button', { name: 'Show panels' }));
    expect(onShow).toHaveBeenCalledTimes(1);
  });
});
