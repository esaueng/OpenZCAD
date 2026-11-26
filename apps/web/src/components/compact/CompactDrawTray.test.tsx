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
      fireEvent.click(
        within(panel()).getByRole('button', { name: 'Back' })
      );
      await waitFor(() => expect(detent()).toBe('peek'));
    }
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
    expect(pdf).toHaveAttribute('title', 'pdf as drawn before the model change');
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
