import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { createPortal } from 'react-dom';
import { describe, expect, it, vi } from 'vitest';
import type { DrawingSheet, DrawingSheetId } from '@openzcad/shared';
import { AppShell } from '../AppShell';
import CompactDrawTray, {
  type CompactDrawRun,
  type CompactDrawSheet,
  type CompactDrawSheets
} from './CompactDrawTray';
import CompactModeTray from './CompactModeTray';
import { CompactTrayContext, useCompactTrayHost } from './compactSlots';
import { COMPACT_PANEL_ORDER } from './panelSheet';

function sheets(overrides: Partial<CompactDrawSheets> = {}): CompactDrawSheets {
  return {
    sheets: [
      { sheetId: 'a', name: 'Sheet 1' },
      { sheetId: 'b', name: 'Sheet 2' }
    ] as unknown as DrawingSheet[],
    activeId: 'a' as DrawingSheetId,
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onDuplicate: vi.fn(),
    onMove: vi.fn(),
    onDelete: vi.fn(),
    editDisabledReason: null,
    createDisabledReason: null,
    ...overrides
  };
}

function content(overrides: Partial<CompactDrawSheet> = {}): CompactDrawSheet {
  const tool = {
    active: false,
    usable: true,
    disabledReason: '',
    onToggle: vi.fn()
  };
  return {
    annotate: {
      active: null,
      canUse: () => true,
      disabledReason: () => '',
      onTool: vi.fn(),
      check: <p>Dimension check</p>,
      list: <p>Annotations</p>
    },
    viewTools: { section: tool, detail: tool, auxiliary: tool },
    views: <p>Views list</p>,
    selectedView: null,
    properties: <p>Sheet properties</p>,
    hasSelection: false,
    exports: {
      reason: null,
      title: (format) => `Export this sheet as ${format}`,
      outdatedWarning: null,
      update: null,
      onExport: vi.fn(),
      broken: 0,
      canDeleteBroken: false,
      onDeleteBroken: vi.fn()
    },
    propertiesRequested: false,
    onPropertiesShown: vi.fn(),
    ...overrides
  };
}

/** Stands in for the drawing workspace: portals the tray into the anchor. */
function Stage(props: {
  sheets: CompactDrawSheets;
  sheet: CompactDrawSheet | null;
  run: CompactDrawRun | null;
}) {
  const host = useCompactTrayHost()?.host;
  if (!host) return null;
  return createPortal(
    <CompactTrayContext.Provider value={host.tray}>
      <CompactDrawTray {...props} />
    </CompactTrayContext.Provider>,
    host.element
  );
}

function shell(props: Parameters<typeof Stage>[0]) {
  return (
    <AppShell
      topBar={<header className="topbar">top</header>}
      toolBar={null}
      sidebar={null}
      viewer={<div className="viewer-shell">viewer</div>}
      inspector={null}
      assistant={null}
      sidebarWidth={252}
      assistantWidth={360}
      compact={{
        projectName: 'Bracket',
        saveState: 'synced',
        workspaceMode: 'drawing',
        modeLockedReason: () => null,
        shareLink: false,
        onWorkspaceMode: vi.fn(),
        canUndo: false,
        canRedo: false,
        onUndo: vi.fn(),
        onRedo: vi.fn(),
        onHome: vi.fn(),
        onSearch: vi.fn(),
        onSettings: vi.fn(),
        onHelp: vi.fn(),
        fileCommands: [],
        selectionLabel: null,
        reducedMotion: true,
        panels: {
          open: null,
          available: COMPACT_PANEL_ORDER,
          disabledReason: null,
          content: null,
          onOpen: vi.fn(),
          warningCount: 0
        },
        selection: null,
        editRefusal: null,
        sheetKey: ''
      }}
      compactTray={<CompactModeTray mode="drawing" />}
      stage={<Stage {...props} />}
    />
  );
}

const panel = () => document.querySelector<HTMLElement>('.compact-sheet')!;
const detent = () => panel().getAttribute('data-detent');
const tray = () =>
  // The tray is lazy: a cold first load takes longer than findBy's 1 s.
  screen.findByRole('toolbar', { name: 'Draw tools' }, { timeout: 5000 });

describe('CompactDrawTray (U12 slice 9)', () => {
  it('rests at peek and opens each page over the tray', async () => {
    render(shell({ sheets: sheets(), sheet: content(), run: null }));
    await tray();
    expect(detent()).toBe('peek');
    for (const [name, text] of [
      ['Annotate', 'Dimension check'],
      ['Views', 'Views list'],
      ['Properties', 'Sheet properties']
    ] as const) {
      fireEvent.click(within(await tray()).getByRole('button', { name }));
      expect(await within(panel()).findByText(text)).toBeTruthy();
      expect(detent()).toBe('half');
      fireEvent.click(within(panel()).getByRole('button', { name: 'Back' }));
      await waitFor(() => expect(detent()).toBe('peek'));
    }
  });

  it('opens Properties without focusing its text field', async () => {
    // The space review: the sheet name took focus, and the keyboard left
    // the drawing a sliver beside it.
    render(
      shell({
        sheets: sheets(),
        sheet: content({
          properties: (
            <label>
              Sheet name
              <input defaultValue="Sheet 1" />
            </label>
          )
        }),
        run: null
      })
    );
    fireEvent.click(
      within(await tray()).getByRole('button', { name: 'Properties' })
    );
    const field = await within(panel()).findByLabelText('Sheet name');
    await waitFor(() => expect(detent()).toBe('half'));
    expect(field).not.toHaveFocus();
  });

  it('closes its page when a tool starts, and gives the tool its row', async () => {
    const sheet = content();
    const { rerender } = render(shell({ sheets: sheets(), sheet, run: null }));
    fireEvent.click(
      within(await tray()).getByRole('button', { name: 'Annotate' })
    );
    fireEvent.click(
      await within(panel()).findByRole('button', {
        name: 'Vertical'
      })
    );
    expect(sheet.annotate.onTool).toHaveBeenCalledWith('vertical');
    const onCancel = vi.fn();
    const onDone = vi.fn();
    rerender(
      shell({
        sheets: sheets(),
        sheet,
        run: {
          label: 'Vertical',
          icon: null,
          step: 'Point 1',
          hint: 'Vertical dimension: pick a straight edge.',
          onCancel,
          onDone
        }
      })
    );
    const row = await screen.findByRole('group', {
      name: 'Vertical placement'
    });
    await waitFor(() => expect(detent()).toBe('peek'));
    expect(within(row).getByRole('status').textContent).toBe(
      'Vertical dimension: pick a straight edge.'
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Done' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);

    // A finger's tap after a drag on the sheet (a section line, a pan): on
    // Linux and ChromeOS the browser makes no click of it, as the drag
    // flung. Cancel and Done run on the lift, and a click that does come
    // after it runs nothing twice (review case: the tool kept running).
    for (const [name, handler] of [
      ['Cancel', onCancel],
      ['Done', onDone]
    ] as const) {
      const button = within(row).getByRole('button', { name });
      const finger = {
        pointerId: 7,
        pointerType: 'touch',
        clientX: 10,
        clientY: 10
      };
      fireEvent.pointerDown(button, finger);
      fireEvent.pointerUp(button, finger);
      expect(handler).toHaveBeenCalledTimes(2);
      fireEvent.click(button);
      expect(handler).toHaveBeenCalledTimes(2);
    }
    // A finger that slid off its press runs nothing.
    const cancel = within(row).getByRole('button', { name: 'Cancel' });
    fireEvent.pointerDown(cancel, {
      pointerId: 8,
      pointerType: 'touch',
      clientX: 10,
      clientY: 10
    });
    fireEvent.pointerUp(cancel, {
      pointerId: 8,
      pointerType: 'touch',
      clientX: 60,
      clientY: 10
    });
    expect(onCancel).toHaveBeenCalledTimes(2);

    // Done on a lift ends the tool, and its row: the click the browser may
    // still make of that tap lands on the tray drawn in Done's place, and
    // opens nothing there.
    const done = within(row).getByRole('button', { name: 'Done' });
    const lift = { pointerId: 9, pointerType: 'touch', clientX: 10, clientY: 10 };
    fireEvent.pointerDown(done, lift);
    fireEvent.pointerUp(done, lift);
    expect(onDone).toHaveBeenCalledTimes(3);
    rerender(shell({ sheets: sheets(), sheet, run: null }));
    const shown = within(await tray()).getByRole('button', {
      name: 'Export'
    });
    fireEvent.click(shown);
    expect(within(panel()).queryByRole('heading', { name: 'Export' })).toBeNull();
    // The next tap is a tap again.
    fireEvent.pointerDown(shown, { ...lift, pointerId: 10 });
    fireEvent.click(shown);
    expect(
      await within(panel()).findByRole('heading', { name: 'Export' })
    ).toBeTruthy();
  });

  it('brings the settings of a newly added view into sight on Views', async () => {
    const seen: string[] = [];
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(function (this: Element) {
        seen.push(this.textContent ?? '');
      });
    try {
      const { rerender } = render(
        shell({ sheets: sheets(), sheet: content(), run: null })
      );
      fireEvent.click(
        within(await tray()).getByRole('button', { name: 'Views' })
      );
      expect(await within(panel()).findByText('Views list')).toBeTruthy();
      expect(seen).toEqual([]);
      // Add view selects the new view: its settings stand above the list,
      // out of sight of the Add view under it, until brought into view.
      rerender(
        shell({
          sheets: sheets(),
          sheet: content({
            selectedView: <p>Right view settings</p>,
            selectedViewId: 'dview_right'
          }),
          run: null
        })
      );
      expect(
        await within(panel()).findByText('Right view settings')
      ).toBeTruthy();
      expect(seen).toEqual(['Right view settings']);
      // Another view, another scroll; the same one again, none.
      rerender(
        shell({
          sheets: sheets(),
          sheet: content({
            selectedView: <p>Top view settings</p>,
            selectedViewId: 'dview_top'
          }),
          run: null
        })
      );
      await waitFor(() =>
        expect(seen).toEqual(['Right view settings', 'Top view settings'])
      );
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it('opens Properties when the workspace asks for them', async () => {
    const onPropertiesShown = vi.fn();
    const { rerender } = render(
      shell({ sheets: sheets(), sheet: content(), run: null })
    );
    await tray();
    rerender(
      shell({
        sheets: sheets(),
        sheet: content({ propertiesRequested: true, onPropertiesShown }),
        run: null
      })
    );
    expect(await within(panel()).findByText('Sheet properties')).toBeTruthy();
    expect(onPropertiesShown).toHaveBeenCalled();
  });

  it('exports, and deletes broken annotations, from Export', async () => {
    const sheet = content({
      exports: {
        reason: 'An annotation has lost what it measures.',
        title: () => 'An annotation has lost what it measures.',
        outdatedWarning: null,
        update: null,
        onExport: vi.fn(),
        broken: 1,
        canDeleteBroken: true,
        onDeleteBroken: vi.fn()
      }
    });
    render(shell({ sheets: sheets(), sheet, run: null }));
    fireEvent.click(
      within(await tray()).getByRole('button', { name: 'Export' })
    );
    const page = within(panel());
    for (const name of ['Export PDF', 'Export SVG', 'Export DXF']) {
      expect(await page.findByRole('button', { name })).toBeDisabled();
    }
    expect(
      page.getByText('An annotation has lost what it measures.')
    ).toBeTruthy();
    fireEvent.click(page.getByRole('button', { name: 'Delete all broken' }));
    expect(sheet.exports.onDeleteBroken).toHaveBeenCalledTimes(1);
  });

  it('warns that an outdated sheet exports as drawn, and offers its Update', async () => {
    const onUpdate = vi.fn();
    const onExport = vi.fn();
    const warning =
      'The model changed since this sheet was drawn. Update it to redraw the views. Export now writes this sheet as drawn, before the latest model change.';
    const sheet = content({
      exports: {
        reason: null,
        title: (format) => `${format} as drawn before the model change`,
        outdatedWarning: warning,
        update: { disabledReason: null, onUpdate },
        onExport,
        broken: 0,
        canDeleteBroken: false,
        onDeleteBroken: vi.fn()
      }
    });
    render(shell({ sheets: sheets(), sheet, run: null }));
    fireEvent.click(
      within(await tray()).getByRole('button', { name: 'Export' })
    );
    const page = within(panel());
    expect(await page.findByText(warning)).toBeTruthy();
    const pdf = page.getByRole('button', { name: 'Export PDF' });
    expect(pdf).toHaveAttribute(
      'title',
      'pdf as drawn before the model change'
    );
    fireEvent.click(page.getByRole('button', { name: 'Update' }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    fireEvent.click(pdf);
    expect(onExport).toHaveBeenCalledWith('pdf');
  });

  it('keeps a rename to itself until it is saved', async () => {
    const control = sheets();
    render(shell({ sheets: control, sheet: content(), run: null }));
    fireEvent.click(
      within(await tray()).getByRole('button', { name: 'Sheets' })
    );
    const page = within(panel());
    fireEvent.click(
      await page.findByRole('button', { name: 'Rename Sheet 1' })
    );
    const field = page.getByRole('textbox', { name: 'Sheet name' });
    await waitFor(() => expect(document.activeElement).toBe(field));
    fireEvent.change(field, { target: { value: '  ' } });
    expect(page.getByRole('button', { name: 'Save name' })).toBeDisabled();
    fireEvent.click(page.getByRole('button', { name: 'Cancel rename' }));
    expect(control.onRename).not.toHaveBeenCalled();
    fireEvent.click(page.getByRole('button', { name: 'Sheet 2' }));
    expect(control.onSelect).toHaveBeenCalledWith('b');
  });
});
