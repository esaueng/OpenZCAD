import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PanelLayoutOptions } from '../../lib/panelLayout';
import {
  LAYOUT_LOCKED_DETAIL,
  PanelsHiddenPill,
  ViewOptionsMenu,
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
    const button = screen.getByRole('button', { name: 'View options' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = within(screen.getByRole('menu', { name: 'View options' }));

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
    await user.click(screen.getByRole('button', { name: 'View options' }));
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
    await user.click(screen.getByRole('button', { name: 'View options' }));
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
    const button = screen.getByRole('button', { name: 'View options' });
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
    const button = screen.getByRole('button', { name: 'View options' });
    await user.click(button);
    await user.click(button);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(button);
    await user.click(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
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
