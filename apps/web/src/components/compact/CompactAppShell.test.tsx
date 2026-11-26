import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppShell } from '../AppShell';
import { NumericKeypad } from '../NumericKeypad';
import type { CompactChromeProps } from './compactSlots';
import { COMPACT_PANEL_ORDER } from './panelSheet';

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

  it('offers the top bar’s “Edit not applied” in the header, with its handler', async () => {
    const onReview = vi.fn();
    const { rerender } = render(shell(chrome()));
    await screen.findByRole('group', { name: 'Workspace mode' });
    expect(
      screen.queryByRole('button', { name: /Edit not applied/ })
    ).toBeNull();
    rerender(
      shell(
        chrome({
          editRefusal: {
            message: 'Extrude was not applied: the depth must be above zero.',
            onReview
          }
        })
      )
    );
    const chip = screen.getByRole('button', {
      name: 'Edit not applied: reopen it'
    });
    expect(chip).toHaveTextContent('Edit not applied');
    expect(chip.getAttribute('title')).toContain(
      'the depth must be above zero.'
    );
    fireEvent.click(chip);
    expect(onReview).toHaveBeenCalledTimes(1);
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

  it('opens the panel sheet from More, and shuts it with Back', async () => {
    const onOpen = vi.fn();
    const closed = chrome({
      panels: { ...chrome().panels, onOpen }
    });
    const { rerender } = render(shell(closed));
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Panels' }));
    expect(onOpen).toHaveBeenCalledWith('history');

    // The workspace holds the open panel; the sheet follows it.
    const open = chrome({
      panels: {
        ...chrome().panels,
        open: 'bodies',
        content: <p>Objects body</p>,
        onOpen
      }
    });
    rerender(shell(open));
    expect(
      await screen.findByRole('heading', { name: 'Objects' })
    ).toBeVisible();
    const tabs = screen.getByRole('tablist', { name: 'Panels' });
    const active = within(tabs).getByRole('tab', { name: 'Objects' });
    expect(active).toHaveAttribute('aria-selected', 'true');
    // One word, on the active segment only.
    expect(active).toHaveTextContent('Objects');
    expect(
      within(tabs).getByRole('tab', { name: 'History' })
    ).toHaveTextContent('');
    expect(screen.getByRole('tabpanel', { name: 'Objects' })).toHaveTextContent(
      'Objects body'
    );
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Revisions' }));
    expect(onOpen).toHaveBeenLastCalledWith('revisions');
    fireEvent.keyDown(active, { key: 'ArrowLeft' });
    expect(onOpen).toHaveBeenLastCalledWith('history');

    // Back leaves the panel sheet: the workspace hears it shut.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(onOpen).toHaveBeenLastCalledWith(null));

    // The workspace shuts it as asked, opens it again, then shuts it itself
    // (Ctrl+\, a tap that opens a step's edit).
    rerender(shell(chrome({ panels: { ...open.panels, open: null } })));
    rerender(shell(open));
    await screen.findByRole('tablist', { name: 'Panels' });
    rerender(shell(chrome({ panels: { ...open.panels, open: null } })));
    await waitFor(() =>
      expect(screen.queryByRole('tablist', { name: 'Panels' })).toBeNull()
    );
  });

  it('offers the panels only where the workspace has them', async () => {
    render(
      shell(
        chrome({
          panels: {
            ...chrome().panels,
            disabledReason: 'The panels are in Build mode.'
          }
        })
      )
    );
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    expect(screen.getByRole('button', { name: 'Panels' })).toBeDisabled();
  });

  it('opens Diagnostics from the header’s warning count', async () => {
    const onOpen = vi.fn();
    const { rerender } = render(shell(chrome()));
    await screen.findByRole('group', { name: 'Workspace mode' });
    expect(screen.queryByRole('button', { name: /warning/ })).toBeNull();
    rerender(
      shell(chrome({ panels: { ...chrome().panels, warningCount: 2, onOpen } }))
    );
    fireEvent.click(
      screen.getByRole('button', { name: '2 warnings: show Diagnostics' })
    );
    expect(onOpen).toHaveBeenCalledWith('diagnostics');
  });

  it('offers the pick’s verbs, its whole body, the filter and its properties', async () => {
    const onVerb = vi.fn();
    const selectBody = vi.fn();
    const onChange = vi.fn();
    render(
      shell(
        chrome({
          selectionLabel: 'Top face',
          selection: {
            verbs: [
              {
                id: 'action:offset-face',
                label: 'Offset',
                title: 'Push or pull the face',
                disabled: false,
                pressed: false
              },
              {
                id: 'tool:hole',
                label: 'Hole',
                title: 'Not on a curved face',
                disabled: true,
                pressed: false
              }
            ],
            onVerb,
            picks: [
              { id: 'select-body', label: 'Select body', run: selectBody }
            ],
            filter: {
              options: [
                { id: 'any', label: 'Any' },
                { id: 'face', label: 'Face' }
              ],
              current: 'any',
              onChange
            }
          }
        }),
        { inspector: <p>Face properties</p> }
      )
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Selection: Top face' })
    );
    expect(screen.getByRole('heading', { name: 'Top face' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hole' })).toBeDisabled();
    const filter = screen.getByRole('radiogroup', { name: 'Selection filter' });
    expect(within(filter).getByRole('radio', { name: 'Any' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    fireEvent.click(within(filter).getByRole('radio', { name: 'Face' }));
    expect(onChange).toHaveBeenCalledWith('face');
    fireEvent.click(screen.getByRole('button', { name: 'Offset' }));
    expect(onVerb).toHaveBeenCalledWith('action:offset-face');

    // Properties: the inspector, which is the sheet's own content.
    fireEvent.click(
      await screen.findByRole('button', { name: 'Selection: Top face' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Properties' }));
    expect(screen.getByText('Face properties')).toBeVisible();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Selection: Top face' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select body' }));
    expect(selectBody).toHaveBeenCalledTimes(1);
  });
});
