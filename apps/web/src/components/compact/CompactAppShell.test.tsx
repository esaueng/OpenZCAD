import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../AppShell';
import { createPortal } from 'react-dom';
import { commandContextFor } from '../../lib/commandContext';
import { InPlaceCommandBar } from '../InPlaceCommandBar';
import { NumericKeypad } from '../NumericKeypad';
import { TRAY_REASON_MS } from './ContextTray';
import {
  CompactCommandTrayContext,
  useCompactCommandRowHost,
  type CompactChromeProps
} from './compactSlots';

function chrome(
  overrides: Partial<CompactChromeProps & { sheetKey: string }> = {}
) {
  return {
    projectName: 'Bracket',
    saveState: 'synced' as const,
    workspaceMode: 'build' as const,
    modeLockedReason: () => null,
    shareLink: false,
    onWorkspaceMode: vi.fn(),
    canUndo: true,
    canRedo: false,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onHome: vi.fn(),
    onSearch: vi.fn(),
    onSettings: vi.fn(),
    onHelp: vi.fn(),
    fileCommands: [
      {
        id: 'file-export-step',
        label: 'Export STEP',
        group: 'File',
        run: vi.fn()
      }
    ],
    selectionLabel: null,
    reducedMotion: false,
    sheetKey: '',
    ...overrides
  };
}

function shell(
  compact: ReturnType<typeof chrome> | null,
  slots: {
    inspector?: React.ReactNode;
    command?: React.ReactNode;
    viewer?: React.ReactNode;
  } = {}
) {
  return (
    <AppShell
      topBar={<header className="topbar">top</header>}
      toolBar={null}
      sidebar={null}
      viewer={slots.viewer ?? <div className="viewer-shell">viewer</div>}
      inspector={slots.inspector ?? null}
      command={slots.command ?? null}
      assistant={null}
      sidebarWidth={252}
      assistantWidth={360}
      readout={<output>readout</output>}
      compact={compact}
    />
  );
}

describe('AppShell in the compact workspace', () => {
  it('leaves the regular frame alone without the compact props', () => {
    const { container } = render(shell(null));
    const root = container.querySelector('.app-shell')!;
    expect(root).not.toHaveAttribute('data-shell');
    expect(container.querySelector('.stage-right')).not.toBeNull();
    expect(container.querySelector('.compact-chrome')).toBeNull();
  });

  it('draws the header, tabs, floating controls and one sheet', async () => {
    const props = chrome();
    const { container } = render(shell(props));
    expect(container.querySelector('.app-shell')).toHaveAttribute(
      'data-shell',
      'compact'
    );
    await screen.findByRole('group', { name: 'Workspace mode' });
    expect(container.querySelector('.stage-right')).toBeNull();
    expect(container.querySelectorAll('.compact-sheet')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Bracket' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'Saved' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Tweak' }));
    expect(props.onWorkspaceMode).toHaveBeenCalledWith('tweak');
    expect(screen.getByRole('button', { name: 'Build' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(props.onUndo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Open the command bar' })
    );
    expect(props.onSearch).toHaveBeenCalledTimes(1);
  });

  it('keeps locked modes locked and a shared link to its own modes', async () => {
    const locked = chrome({
      modeLockedReason: (mode) =>
        mode === 'build' ? 'This shared project is read-only' : null
    });
    const { unmount } = render(shell(locked));
    const build = await screen.findByRole('button', { name: 'Build' });
    expect(build).toBeDisabled();
    expect(build).toHaveAttribute('title', 'This shared project is read-only');
    unmount();

    render(
      shell(
        chrome({
          shareLink: true,
          workspaceMode: 'tweak',
          modeLockedReason: (mode) =>
            mode === 'view' || mode === 'tweak' ? null : 'Not on a link'
        })
      )
    );
    await screen.findByRole('button', { name: 'Tweak' });
    expect(screen.queryByRole('button', { name: 'Build' })).toBeNull();
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
  });

  it('puts the command card and the inspector in the sheet', async () => {
    const { container } = render(
      shell(chrome({ sheetKey: 'card:box' }), {
        command: <div>Box card</div>,
        inspector: <div>Inspector form</div>
      })
    );
    await waitFor(() =>
      expect(
        container.querySelector('.compact-sheet')?.getAttribute('data-detent')
      ).toBe('half')
    );
    const sheet = container.querySelector('.compact-sheet')!;
    expect(sheet).toContainElement(screen.getByText('Box card'));
    expect(sheet).toContainElement(screen.getByText('Inspector form'));
  });

  it('opens the overflow menu as a sheet page with a File drill-in', async () => {
    const props = chrome();
    render(shell(props));
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export STEP' }));
    expect(props.fileCommands[0]!.run).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(props.onSettings).toHaveBeenCalledTimes(1);
  });

  it('offers a shared link’s visitor Make a copy from More, in any mode', async () => {
    const plain = render(shell(chrome()));
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    expect(
      await screen.findByRole('button', { name: 'Open settings' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make a copy' })).toBeNull();
    plain.unmount();

    for (const workspaceMode of ['view', 'tweak'] as const) {
      const props = chrome({
        shareLink: true,
        workspaceMode,
        onMakeCopy: vi.fn()
      });
      const { unmount } = render(shell(props));
      fireEvent.click(await screen.findByRole('button', { name: 'More' }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Make a copy' })
      );
      expect(props.onMakeCopy).toHaveBeenCalledTimes(1);
      // The page closes on the way to the copy's own dialog.
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Make a copy' })).toBeNull()
      );
      unmount();
    }
  });

  it('marks the document compact while it is up, for portalled dialogs', async () => {
    const root = document.documentElement;
    const { rerender, unmount } = render(shell(chrome()));
    await screen.findByRole('group', { name: 'Workspace mode' });
    expect(root).toHaveAttribute('data-shell', 'compact');
    // Back to Full: the regular frame leaves the document unmarked.
    rerender(shell(null));
    expect(root).not.toHaveAttribute('data-shell');
    rerender(shell(chrome()));
    expect(root).toHaveAttribute('data-shell', 'compact');
    unmount();
    expect(root).not.toHaveAttribute('data-shell');
  });

  it('keeps the document marked while any compact frame is up', async () => {
    const root = document.documentElement;
    const first = render(shell(chrome()));
    const second = render(shell(chrome()));
    await waitFor(() =>
      expect(
        document.querySelectorAll('.compact-chrome').length
      ).toBeGreaterThanOrEqual(2)
    );
    expect(root).toHaveAttribute('data-shell', 'compact');
    // One frame leaves; the other is still up, and the mark stays.
    first.unmount();
    expect(root).toHaveAttribute('data-shell', 'compact');
    second.unmount();
    expect(root).not.toHaveAttribute('data-shell');
  });

  it('draws an open keypad as the sheet when the layout turns compact', async () => {
    const keypad = (
      <div className="viewer-shell">
        <NumericKeypad
          request={{
            kind: 'command',
            label: 'Width',
            initial: '20',
            unitKind: 'length',
            commandValueId: 'width'
          }}
          units="mm"
          scope={{}}
          anchorRef={{ current: null }}
          onPreview={() => undefined}
          onCommit={() => undefined}
          onCancel={() => undefined}
        />
      </div>
    );
    const { container, rerender } = render(shell(null, { viewer: keypad }));
    const regular = screen.getByRole('dialog', { name: 'Width value' });
    expect(container.querySelector('.viewer-area')).toContainElement(regular);

    // Phone chosen in Settings with the keypad still open.
    rerender(shell(chrome(), { viewer: keypad }));
    // Never drawn on the stage first: the keypad waits for the overlay host.
    expect(container.querySelector('.viewer-area .numeric-keypad')).toBeNull();
    const host = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(
        '.compact-overlay-host'
      );
      expect(element).not.toBeNull();
      return element!;
    });
    const control = await waitFor(() =>
      within(host).getByRole('dialog', { name: 'Width value' })
    );
    expect(document.querySelectorAll('.numeric-keypad')).toHaveLength(1);
    // Placed as the phone's sheet by effects bound to the nodes on screen,
    // and its field holds focus.
    expect(control.style.visibility).toBe('visible');
    expect(control).toHaveAttribute('data-placement', 'sheet');
    expect(
      within(control).getByRole('textbox', { name: 'Width' })
    ).toHaveFocus();
  });

  it("stands Build's tray at peek and opens All tools as a page", async () => {
    const onLaunchTool = vi.fn();
    const { container } = render(
      shell(
        chrome({
          build: {
            context: commandContextFor({
              edgeCount: 0,
              faceSelected: false,
              bodyCount: 0,
              regionCount: 0
            }),
            pick: null,
            availability: {
              sketchCount: 0,
              liveBodyCount: 0,
              exactGeometryReady: true,
              hasEdgeSelected: false
            },
            activeTool: null,
            recentTools: [],
            pinnedTools: ['box'],
            onLaunchTool
          }
        })
      )
    );
    const sheet = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('.compact-sheet');
      expect(element).toHaveAttribute('data-detent', 'peek');
      return element!;
    });
    const tray = within(sheet).getByRole('group', { name: 'Build tray' });
    fireEvent.click(within(tray).getByRole('button', { name: 'All tools' }));
    expect(sheet).toHaveAttribute('data-detent', 'full');
    expect(within(sheet).getByRole('heading', { name: 'All tools' }));
    // Opened to look: focus is on the page, not in its search field, which
    // would raise the on-screen keyboard.
    expect(
      within(sheet).getByRole('searchbox', { name: 'Search tools' })
    ).not.toHaveFocus();
    const pinned = within(sheet).getByRole('region', { name: 'Pinned' });
    fireEvent.click(within(pinned).getByRole('button', { name: 'Box' }));
    expect(onLaunchTool).toHaveBeenCalledWith('box');
    // The page closes on launch, back to the tray.
    expect(within(sheet).queryByRole('heading', { name: 'All tools' })).toBe(
      null
    );
    expect(sheet).toHaveAttribute('data-detent', 'peek');
  });

  /** Build's tray holding a pick whose one verb, Shell, cannot run. */
  async function refusedShell() {
    const { container } = render(
      shell(
        chrome({
          build: {
            context: commandContextFor({
              edgeCount: 0,
              faceSelected: true,
              bodyCount: 1,
              regionCount: 0
            }),
            pick: {
              verbs: [
                {
                  id: 'tool:shell',
                  label: 'Shell',
                  title: 'Open in another tab',
                  disabled: true,
                  pressed: false
                }
              ],
              enabled: () => false,
              onVerb: vi.fn()
            },
            availability: {
              sketchCount: 0,
              liveBodyCount: 1,
              exactGeometryReady: true,
              hasEdgeSelected: false
            },
            activeTool: null,
            recentTools: [],
            pinnedTools: [],
            onLaunchTool: vi.fn()
          }
        })
      )
    );
    const sheet = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('.compact-sheet');
      expect(element).toHaveAttribute('data-detent', 'peek');
      return element!;
    });
    vi.useFakeTimers();
    const tray = within(sheet).getByRole('group', { name: 'Build tray' });
    const verb = within(tray).getByRole('button', { name: 'Selection: Shell' });
    return { sheet, tray, verb };
  }

  describe("a disabled verb's reason", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('raises the sheet again on a repeat tap after it was lowered', async () => {
      const { sheet, tray, verb } = await refusedShell();
      fireEvent.click(verb);
      expect(sheet).toHaveAttribute('data-detent', 'half');
      // Lowered by hand while the reason shows: it would stand clipped
      // under the peek's fold.
      fireEvent.keyDown(
        within(sheet).getByRole('slider', { name: 'Sheet height' }),
        { key: 'Home' }
      );
      expect(sheet).toHaveAttribute('data-detent', 'peek');
      act(() => {
        vi.advanceTimersByTime(TRAY_REASON_MS / 2);
      });
      // Tapped again before it goes: the sheet comes back up to show it.
      fireEvent.click(verb);
      expect(within(tray).getByRole('status')).toHaveTextContent(
        'Open in another tab'
      );
      expect(sheet).toHaveAttribute('data-detent', 'half');
      // And it goes back to the person's peek with the reason.
      act(() => {
        vi.advanceTimersByTime(TRAY_REASON_MS + 10);
      });
      expect(within(tray).queryByRole('status')).toBeNull();
      expect(sheet).toHaveAttribute('data-detent', 'peek');
    });

    it('leaves the tray at peek after All tools opened over it', async () => {
      const { sheet, tray, verb } = await refusedShell();
      fireEvent.click(verb);
      expect(sheet).toHaveAttribute('data-detent', 'half');
      // All tools opened while the reason raised the sheet.
      fireEvent.click(within(tray).getByRole('button', { name: 'All tools' }));
      expect(
        within(sheet).getByRole('heading', { name: 'All tools' })
      ).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(TRAY_REASON_MS + 10);
      });
      // Back: the tray at the peek the person had, not the raised half.
      fireEvent.click(within(sheet).getByRole('button', { name: 'Back' }));
      expect(
        within(sheet).queryByRole('heading', { name: 'All tools' })
      ).toBeNull();
      expect(sheet).toHaveAttribute('data-detent', 'peek');
    });
  });

  it('draws the keypad in the sheet under the tray while Build holds it', async () => {
    const keypad = (
      <div className="viewer-shell">
        <NumericKeypad
          request={{
            kind: 'command',
            label: 'Radius',
            initial: '1',
            unitKind: 'length',
            commandValueId: 'radius'
          }}
          units="mm"
          scope={{}}
          anchorRef={{ current: null }}
          onPreview={() => undefined}
          onCommit={() => undefined}
          onCancel={() => undefined}
        />
      </div>
    );
    const { container } = render(
      shell(
        chrome({
          build: {
            context: commandContextFor({
              edgeCount: 0,
              faceSelected: false,
              bodyCount: 0,
              regionCount: 0
            }),
            pick: null,
            availability: {
              sketchCount: 0,
              liveBodyCount: 1,
              exactGeometryReady: true,
              hasEdgeSelected: false
            },
            activeTool: null,
            recentTools: [],
            pinnedTools: [],
            onLaunchTool: vi.fn()
          }
        }),
        { viewer: keypad }
      )
    );
    const control = await waitFor(() =>
      screen.getByRole('dialog', { name: 'Radius value' })
    );
    const sheet = container.querySelector<HTMLElement>('.compact-sheet')!;
    expect(sheet.querySelector('.compact-keypad-host')).toContainElement(
      control
    );
    await waitFor(() => expect(sheet).toHaveAttribute('data-detent', 'half'));
    expect(
      within(control).getByRole('textbox', { name: 'Radius' })
    ).toHaveFocus();
  });

  it("draws the keypad under a running tool's pinned row, in its bar", async () => {
    // The bar as WorkspaceReadout draws it in the compact sheet.
    function Row() {
      const host = useCompactCommandRowHost(true);
      return host
        ? createPortal(
            <CompactCommandTrayContext.Provider value={true}>
              <InPlaceCommandBar
                title="Fillet"
                hint="1 edge · drag the radius"
                canFinish
                onDone={vi.fn()}
                onCancel={vi.fn()}
              />
            </CompactCommandTrayContext.Provider>,
            host
          )
        : null;
    }
    const keypad = (
      <div className="viewer-shell">
        <Row />
        <NumericKeypad
          request={{
            kind: 'command',
            label: 'Radius',
            initial: '1',
            unitKind: 'length',
            commandValueId: 'radius'
          }}
          units="mm"
          scope={{}}
          anchorRef={{ current: null }}
          onPreview={() => undefined}
          onCommit={() => undefined}
          onCancel={() => undefined}
        />
      </div>
    );
    render(
      shell(
        chrome({
          build: {
            context: commandContextFor({
              edgeCount: 0,
              faceSelected: false,
              bodyCount: 0,
              regionCount: 0
            }),
            pick: null,
            availability: {
              sketchCount: 0,
              liveBodyCount: 1,
              exactGeometryReady: true,
              hasEdgeSelected: false
            },
            activeTool: 'fillet',
            recentTools: [],
            pinnedTools: [],
            onLaunchTool: vi.fn()
          }
        }),
        { viewer: keypad }
      )
    );
    const bar = await waitFor(() =>
      screen.getByRole('group', { name: 'Fillet command' })
    );
    const control = await waitFor(() =>
      within(bar).getByRole('dialog', { name: 'Radius value' })
    );
    // After the pinned row, inside the bar: the row's sticky span covers it.
    const row = bar.querySelector('.compact-tray-row')!;
    expect(
      row.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(document.querySelectorAll('.numeric-keypad')).toHaveLength(1);
    // The bar's tray stands in for Build's.
    expect(screen.queryByRole('group', { name: 'Build tray' })).toBeNull();
  });

  it('draws an open File page from the commands as they are now', async () => {
    const pending = chrome({
      fileCommands: [
        {
          id: 'file-export-step',
          label: 'Export STEP',
          group: 'File',
          disabledReason: 'Waiting for the model to update',
          run: vi.fn()
        }
      ]
    });
    const { rerender } = render(shell(pending));
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    expect(screen.getByRole('button', { name: 'Export STEP' })).toBeDisabled();
    // The update finishes while File is open.
    const ready = chrome();
    rerender(shell(ready));
    const exportStep = screen.getByRole('button', { name: 'Export STEP' });
    expect(exportStep).toBeEnabled();
    fireEvent.click(exportStep);
    expect(ready.fileCommands[0]!.run).toHaveBeenCalledTimes(1);
  });

  it('names the pick on a chip that opens it in the sheet', async () => {
    const onClearSelection = vi.fn();
    render(shell(chrome({ selectionLabel: '2 faces', onClearSelection })));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Selection: 2 faces' })
    );
    expect(screen.getByRole('heading', { name: '2 faces' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });
});
