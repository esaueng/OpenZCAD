import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DrawingPaperSize,
  DrawingSheet,
  DrawingSheetId
} from '@openzcad/shared';
import { DrawingSheetTabs } from './DrawingSheetTabs';

function sheet(index: number, size: DrawingPaperSize = 'A3'): DrawingSheet {
  return {
    sheetId: `dsh_${index}` as DrawingSheetId,
    name: `Sheet ${index}`,
    paper: { size, orientation: 'landscape' },
    scale: { numerator: 2, denominator: 1 },
    views: [],
    annotations: []
  } as unknown as DrawingSheet;
}

function Tabs({ sheets }: { sheets: DrawingSheet[] }) {
  const [active, setActive] = useState(sheets[0]!.sheetId);
  return (
    <DrawingSheetTabs
      sheets={sheets}
      activeId={active}
      onSelect={setActive}
      onCreate={vi.fn()}
      createDisabled={false}
      createTitle="New sheet"
    />
  );
}

/** happy-dom lays nothing out; pretend every strip is 300 px of 2000. */
function overflowStrips() {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(2000);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
}

afterEach(() => vi.restoreAllMocks());

describe('DrawingSheetTabs', () => {
  it('tags the paper only when the sheets differ in it', () => {
    const same = render(<Tabs sheets={[sheet(1), sheet(2)]} />);
    expect(same.container.querySelector('.drawing-sheet-tab-paper')).toBeNull();
    same.unmount();

    const mixed = render(<Tabs sheets={[sheet(1), sheet(2, 'A2')]} />);
    expect(
      Array.from(
        mixed.container.querySelectorAll('.drawing-sheet-tab-paper'),
        (tag) => tag.textContent
      )
    ).toEqual(['A3', 'A2']);
  });

  it('moves between sheets with the arrow keys, wrapping at the ends', async () => {
    render(<Tabs sheets={[sheet(1), sheet(2), sheet(3)]} />);
    const tabs = screen.getByRole('tablist', { name: 'Drawing sheets' });
    within(tabs).getByRole('tab', { name: 'Sheet 1' }).focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(within(tabs).getByRole('tab', { name: 'Sheet 3' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await userEvent.keyboard('{Home}');
    expect(within(tabs).getByRole('tab', { name: 'Sheet 1' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    // Only the active tab is a Tab stop.
    expect(
      within(tabs)
        .getAllByRole('tab')
        .filter((tab) => tab.tabIndex === 0)
    ).toHaveLength(1);
  });

  it('offers the full list only once the row overflows', async () => {
    const few = render(<Tabs sheets={[sheet(1), sheet(2)]} />);
    expect(screen.queryByRole('button', { name: /All sheets/ })).toBeNull();
    few.unmount();

    overflowStrips();
    const many = Array.from({ length: 17 }, (_, index) => sheet(index + 1));
    render(<Tabs sheets={many} />);
    await userEvent.click(
      screen.getByRole('button', { name: 'All sheets (17)' })
    );
    const list = screen.getByRole('menu', { name: '17 sheets' });
    expect(
      within(list).getByRole('menuitemradio', { name: /Sheet 1\b/ })
    ).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(
      within(list).getByRole('menuitemradio', { name: /Sheet 12/ })
    );
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Sheet 12' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('renames, duplicates, moves and deletes a sheet from its tab menu (I62)', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onDuplicate = vi.fn();
    const onMove = vi.fn();
    const onDelete = vi.fn();
    const sheets = [sheet(1), sheet(2), sheet(3)];
    render(
      <DrawingSheetTabs
        sheets={sheets}
        activeId={sheets[1]!.sheetId}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        createDisabled={false}
        createTitle="New sheet"
        onRename={onRename}
        onDuplicate={onDuplicate}
        onMove={onMove}
        onDelete={onDelete}
      />
    );
    const tabs = screen.getByRole('tablist', { name: 'Drawing sheets' });
    const second = within(tabs).getByRole('tab', { name: 'Sheet 2' });

    // Right-click opens the menu, headed with the sheet it acts on.
    await user.pointer({ keys: '[MouseRight]', target: second });
    const menu = screen.getByRole('menu');
    expect(menu).toHaveTextContent('Sheet 2');
    await user.click(within(menu).getByRole('menuitem', { name: /Move left/ }));
    expect(onMove).toHaveBeenCalledWith('dsh_2', 0);

    // The visible Sheet actions button opens the same menu for touch.
    await user.click(screen.getByRole('button', { name: 'Sheet actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Duplicate/ }));
    expect(onDuplicate).toHaveBeenCalledWith('dsh_2');

    // Shift+F10 from the tab, then Delete sheet.
    second.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    await user.click(screen.getByRole('menuitem', { name: /Delete sheet/ }));
    expect(onDelete).toHaveBeenCalledWith('dsh_2');

    // F2 (or double-click) renames in place; Escape keeps the old name.
    second.focus();
    await user.keyboard('{F2}');
    const field = screen.getByRole('textbox', { name: 'Rename Sheet 2' });
    await user.clear(field);
    await user.type(field, 'Details{Enter}');
    expect(onRename).toHaveBeenCalledWith('dsh_2', 'Details');
    await user.dblClick(within(tabs).getByRole('tab', { name: 'Sheet 3' }));
    await user.keyboard('{Escape}');
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('greys the first sheet’s Move left and the last one’s Move right', async () => {
    const user = userEvent.setup();
    const sheets = [sheet(1), sheet(2)];
    render(
      <DrawingSheetTabs
        sheets={sheets}
        activeId={sheets[0]!.sheetId}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        createDisabled={false}
        createTitle="New sheet"
        onMove={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Sheet actions' }));
    expect(screen.getByRole('menuitem', { name: /Move left/ })).toBeDisabled();
    expect(
      screen.getByRole('menuitem', { name: /Move right/ })
    ).not.toBeDisabled();
  });
});
