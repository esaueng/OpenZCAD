import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BodyRepresentation } from '@openzcad/shared';
import { ViewModeRail } from './ViewModeRail';

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
});
