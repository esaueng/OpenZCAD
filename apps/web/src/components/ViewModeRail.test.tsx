import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BodyRepresentation } from '@openzcad/shared';
import { PartsList, PartsListModeProvider, ViewModeRail } from './ViewModeRail';

const body = (bodyId: string, name: string): BodyRepresentation =>
  ({ bodyId, name, color: '#c9a55a' }) as unknown as BodyRepresentation;

function renderRail(open: boolean, hidden: string[] = []) {
  const onOpenChange = vi.fn();
  const onShowAll = vi.fn();
  const onToggleVisibility = vi.fn();
  const view = render(
    <ViewModeRail
      bodies={[body('b1', 'Plate'), body('b2', 'Boss')]}
      hiddenBodyIds={new Set(hidden)}
      selectedBodyIds={[]}
      open={open}
      onOpenChange={onOpenChange}
      onSelectBody={vi.fn()}
      onToggleVisibility={onToggleVisibility}
      onIsolate={vi.fn()}
      onShowAll={onShowAll}
    />
  );
  return { ...view, onOpenChange, onShowAll, onToggleVisibility };
}

describe('ViewModeRail', () => {
  it('is a rail whose Parts button wears the count and opens the list', () => {
    const { onOpenChange } = renderRail(false);
    const rail = screen.getByRole('toolbar', { name: 'Parts tools' });
    const parts = within(rail).getByRole('button', {
      name: 'Show the parts list'
    });
    expect(parts).toHaveAttribute('aria-expanded', 'false');
    expect(parts.querySelector('.rail-count')).toHaveTextContent('2');
    expect(screen.queryByRole('complementary', { name: 'Parts' })).toBeNull();
    fireEvent.click(parts);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('shows the list beside the rail, with every part and its controls', () => {
    const { onToggleVisibility } = renderRail(true);
    expect(
      screen.getByRole('button', { name: 'Hide the parts list' })
    ).toHaveClass('active');
    const list = screen.getByRole('complementary', { name: 'Parts' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(within(list).getByRole('button', { name: 'Hide Boss' }));
    expect(onToggleVisibility).toHaveBeenCalledWith('b2');
    // No collapse control in the list: the rail button is the toggle.
    expect(
      within(list).queryByRole('button', { name: /parts list/ })
    ).toBeNull();
  });

  it('offers Show all on the rail only while something is hidden', () => {
    const { onShowAll } = renderRail(false, ['b2']);
    const showAll = screen.getByRole('button', {
      name: 'Show all (1 hidden)'
    });
    expect(showAll.querySelector('.rail-count')).toHaveTextContent('1');
    fireEvent.click(showAll);
    expect(onShowAll).toHaveBeenCalledTimes(1);
    renderRail(false).unmount();
    expect(screen.getAllByRole('button', { name: /^Show all/ })).toHaveLength(
      1
    );
  });

  it("words the list's footnote for the mode it opens in", () => {
    renderRail(true);
    expect(
      screen.getByText('Visibility only — geometry is locked in View mode.')
    ).toBeTruthy();
  });

  it('does not call the geometry locked in Tweak, where values change', () => {
    render(
      <PartsListModeProvider mode="tweak">
        <PartsList
          bodies={[body('b1', 'Plate')]}
          hiddenBodyIds={new Set()}
          selectedBodyIds={[]}
          onSelectBody={vi.fn()}
          onToggleVisibility={vi.fn()}
          onIsolate={vi.fn()}
          onShowAll={vi.fn()}
        />
      </PartsListModeProvider>
    );
    const list = screen.getByRole('complementary', { name: 'Parts' });
    expect(list.querySelector('.view-mode-rail-foot')).toHaveTextContent(
      'Visibility only — the design stays locked.'
    );
    expect(list).not.toHaveTextContent(/View mode/);
  });

  /*
    The parts list is a flyout inside the rail, so a rule written for the
    rail's icon buttons as `.view-rail button` reached every button in the
    list too: the row's name button became a centred 30px grid, and the
    colour swatch stood on its own line above the part's name.
  */
  it("keeps the rail's icon-button rules off the parts list's buttons", () => {
    renderRail(true);
    const rail = screen.getByRole('toolbar', { name: 'Parts tools' });
    const list = screen.getByRole('complementary', { name: 'Parts' });
    const listButtons = within(list).getAllByRole('button');
    expect(listButtons.length).toBeGreaterThan(0);
    const railButton = within(rail).getByRole('button', {
      name: 'Hide the parts list'
    });

    const sheets = resolve(__dirname, '../styles/components');
    const railSelectors = readdirSync(sheets)
      .filter((name) => name.endsWith('.css'))
      .flatMap((name) => {
        const css = readFileSync(resolve(sheets, name), 'utf8').replace(
          /\/\*[\s\S]*?\*\//g,
          ''
        );
        return [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((match) =>
          match[1]!
            .split(',')
            .map((selector) => selector.trim())
            .filter((selector) => /^\.view-rail[\s>]/.test(selector))
            .map((selector) => ({ name, selector }))
        );
      });
    // The rail does have icon-button rules, and they reach its own button.
    const buttonRules = railSelectors.filter(({ selector }) =>
      /\bbutton\b/.test(selector)
    );
    expect(buttonRules.length).toBeGreaterThan(0);
    expect(
      buttonRules.some(({ selector }) =>
        railButton.matches(selector.replace(/:hover|:focus-visible/g, ''))
      )
    ).toBe(true);

    const leaks = railSelectors.flatMap(({ name, selector }) => {
      const plain = selector.replace(/:hover|:focus-visible/g, '');
      return listButtons
        .filter((button) => button.matches(plain))
        .map((button) => `${name}: ${selector} → ${button.className}`);
    });
    expect(leaks).toEqual([]);
  });
});
