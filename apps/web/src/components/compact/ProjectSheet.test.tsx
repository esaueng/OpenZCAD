import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { COMPACT_ENTRIES } from '../../lib/actions/registry';
import { AppShell } from '../AppShell';
import type { PaletteCommand } from '../CommandBar';
import type { CompactChromeProps, CompactProjectSheet } from './compactSlots';
import { COMPACT_PANEL_ORDER } from './panelSheet';

function command(id: string, label: string): PaletteCommand {
  return { id, label, group: 'File', run: vi.fn() };
}

const FILE_COMMANDS: PaletteCommand[] = [
  command('file-save', 'Save revision'),
  command('file-save-named', 'Save revision as…'),
  command('file-export-step', 'Export STEP'),
  command('file-export-mesh', 'Export mesh…'),
  command('file-export-project', 'Export project'),
  command('file-import', 'Import CAD files…'),
  command('file-import-project', 'Import project…'),
  command('project-duplicate', 'Duplicate project'),
  command('file-display-units-cm', 'Show lengths in centimetres'),
  command('file-home', 'Back to projects'),
  // A File row the sheet has no place for still shows.
  command('file-export-something-new', 'Export something new')
];

function project(
  overrides: Partial<CompactProjectSheet> = {}
): CompactProjectSheet {
  return {
    renameDisabledReason: null,
    onRename: vi.fn(),
    onProperties: vi.fn(),
    share: { label: 'Share', run: vi.fn() },
    onComments: vi.fn(),
    displayUnits: {
      shown: 'mm',
      stored: 'mm',
      onChange: vi.fn(),
      disabledReason: null,
      onConvertStored: vi.fn(),
      convertDisabledReason: null
    },
    exportIges: { disabledReason: null, run: vi.fn() },
    archiveLocalSources: { count: 2, disabledReason: null, run: vi.fn() },
    storedFiles: [
      {
        id: 'artifact-1',
        name: 'bracket.step',
        detail: 'step · 12 KB',
        download: vi.fn()
      }
    ],
    onStorage: vi.fn(),
    ...overrides
  };
}

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
    onGuide: vi.fn(),
    fileCommands: FILE_COMMANDS,
    project: project(),
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

function shell(compact: ReturnType<typeof chrome>) {
  return (
    <AppShell
      topBar={<header className="topbar">top</header>}
      toolBar={null}
      sidebar={null}
      viewer={<div className="viewer-shell">viewer</div>}
      inspector={null}
      command={null}
      assistant={null}
      sidebarWidth={252}
      assistantWidth={360}
      readout={<output>readout</output>}
      compact={compact}
    />
  );
}

/** Opens the project sheet the way a phone does: a tap on the name. */
async function openProjectSheet() {
  fireEvent.click(await screen.findByRole('button', { name: 'Bracket' }));
  return document.querySelector<HTMLElement>(
    '.compact-sheet-body[data-page="project"]'
  )!;
}

describe('the compact project sheet', () => {
  it('opens from the header name and closes from it again', async () => {
    render(shell(chrome()));
    const name = await screen.findByRole('button', { name: 'Bracket' });
    // Still the page's heading, as the frame drew it.
    expect(screen.getByRole('heading', { name: 'Bracket' })).toContainElement(
      name
    );
    fireEvent.click(name);
    expect(name).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('heading', { name: 'Project' })).toBeVisible();
    fireEvent.click(name);
    expect(name).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('heading', { name: 'Project' })).toBeNull();
  });

  it('holds every File row, grouped, and the rows it adds', async () => {
    const props = chrome();
    render(shell(props));
    const page = within(await openProjectSheet());
    for (const label of [
      'Properties',
      'Share',
      'Comments',
      'Duplicate project',
      'Save revision',
      'Save revision as…',
      'Export STEP',
      'Export IGES',
      'Export mesh…',
      'Export project',
      'Import CAD files…',
      'Import project…',
      'Export something new',
      'Archive local sources',
      'Account storage',
      'bracket.step'
    ]) {
      expect(page.getByRole('button', { name: label }), label).toBeVisible();
    }
    // The header's own back button, and the units row, stand for these.
    expect(page.queryByRole('button', { name: 'Back to projects' })).toBeNull();
    expect(
      page.queryByRole('button', { name: 'Show lengths in centimetres' })
    ).toBeNull();
    for (const group of ['Revisions', 'Export', 'Import', 'Units', 'Other']) {
      expect(page.getByRole('heading', { name: group })).toBeVisible();
    }

    fireEvent.click(page.getByRole('button', { name: 'Export STEP' }));
    expect(
      FILE_COMMANDS.find((row) => row.id === 'file-export-step')!.run
    ).toHaveBeenCalledTimes(1);
    // A row runs with the pages closed, as More's rows do.
    expect(screen.queryByRole('heading', { name: 'Project' })).toBeNull();
  });

  it('renames in place, and stores nothing unchanged or blank', async () => {
    const props = chrome();
    render(shell(props));
    const page = within(await openProjectSheet());
    const field = page.getByRole('textbox', { name: 'Project name' });
    const rename = page.getByRole('button', { name: 'Rename' });
    expect(field).toHaveValue('Bracket');
    expect(rename).toBeDisabled();
    fireEvent.change(field, { target: { value: '   ' } });
    expect(rename).toBeDisabled();
    fireEvent.change(field, { target: { value: '  Bracket v2 ' } });
    fireEvent.click(rename);
    expect(props.project!.onRename).toHaveBeenCalledWith('Bracket v2');
  });

  it('says why a project cannot be renamed here', async () => {
    render(
      shell(
        chrome({
          project: project({
            renameDisabledReason: 'Only the project owner can rename'
          })
        })
      )
    );
    const page = within(await openProjectSheet());
    const field = page.getByRole('textbox', { name: 'Project name' });
    expect(field).toBeDisabled();
    expect(field).toHaveAttribute('title', 'Only the project owner can rename');
  });

  it('opens Properties, sharing, comments and storage, and saves a stored file', async () => {
    const props = chrome();
    const sheet = props.project!;
    for (const [label, handler] of [
      ['Properties', sheet.onProperties],
      ['Share', sheet.share!.run],
      ['Comments', sheet.onComments],
      ['Account storage', sheet.onStorage],
      ['Archive local sources', sheet.archiveLocalSources!.run],
      ['Export IGES', sheet.exportIges!.run],
      ['bracket.step', sheet.storedFiles[0]!.download]
    ] as const) {
      const { unmount } = render(shell(props));
      const page = within(await openProjectSheet());
      fireEvent.click(page.getByRole('button', { name: label }));
      expect(handler, label).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('leaves out what the project does not offer', async () => {
    render(
      shell(
        chrome({
          project: project({
            onProperties: null,
            share: null,
            onComments: null,
            exportIges: null,
            archiveLocalSources: {
              count: 0,
              disabledReason: null,
              run: vi.fn()
            },
            storedFiles: [],
            onStorage: null
          })
        })
      )
    );
    const page = within(await openProjectSheet());
    for (const label of [
      'Properties',
      'Share',
      'Comments',
      'Export IGES',
      'Archive local sources',
      'Account storage'
    ]) {
      expect(page.queryByRole('button', { name: label }), label).toBeNull();
    }
    expect(page.getByText('No stored files yet.')).toBeVisible();
  });

  it('reaches the project sheet from More, beside the File drill-in', async () => {
    render(shell(chrome()));
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(screen.getByRole('heading', { name: 'Project' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'File' })).toBeVisible();
  });

  it('reopens the modeling guide from More', async () => {
    const props = chrome();
    render(shell(props));
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Modeling guide' }));
    expect(props.onGuide).toHaveBeenCalledTimes(1);
  });

  it('turns the header search into its way out while the search is open', async () => {
    const props = chrome({ searchOpen: true, onCloseSearch: vi.fn() });
    render(shell(props));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Close the command bar' })
    );
    expect(props.onCloseSearch).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'Open the command bar' })
    ).toBeNull();
  });
});

/**
 * Slice 10's registry entries (`COMPACT_ENTRIES`), each opened with taps
 * alone: no key, no hover, no right button. Settings' two are covered by
 * `SettingsPage.compact.test.tsx`.
 */
describe('slice 10 compact entries open by taps', () => {
  const tapPaths: Record<
    string,
    (props: ReturnType<typeof chrome>) => Promise<() => void>
  > = {
    'project-rename': async (props) => {
      const page = within(await openProjectSheet());
      fireEvent.change(page.getByRole('textbox', { name: 'Project name' }), {
        target: { value: 'Renamed' }
      });
      fireEvent.click(page.getByRole('button', { name: 'Rename' }));
      return () =>
        expect(props.project!.onRename).toHaveBeenCalledWith('Renamed');
    },
    'project-duplicate': async () => {
      const page = within(await openProjectSheet());
      fireEvent.click(page.getByRole('button', { name: 'Duplicate project' }));
      return () =>
        expect(
          FILE_COMMANDS.find((row) => row.id === 'project-duplicate')!.run
        ).toHaveBeenCalled();
    },
    ...Object.fromEntries(
      (
        [
          ['mm', 'Millimeters (mm)'],
          ['cm', 'Centimeters (cm)'],
          ['m', 'Meters (m)'],
          ['inch', 'Inches (in)']
        ] as const
      ).map(([unit, name]) => [
        `file-display-units-${unit}`,
        async (props: ReturnType<typeof chrome>) => {
          const page = within(await openProjectSheet());
          fireEvent.click(page.getByRole('radio', { name }));
          return () =>
            unit === 'mm'
              ? // Already shown: the radio holds, nothing changes.
                expect(page.getByRole('radio', { name })).toHaveAttribute(
                  'aria-checked',
                  'true'
                )
              : expect(
                  props.project!.displayUnits!.onChange
                ).toHaveBeenCalledWith(unit);
        }
      ])
    ),
    'command-slash': async (props) => {
      fireEvent.click(
        await screen.findByRole('button', { name: 'Open the command bar' })
      );
      return () => expect(props.onSearch).toHaveBeenCalledTimes(1);
    },
    'assistant-toggle': async (props) => {
      fireEvent.click(
        await screen.findByRole('button', { name: 'Open the command bar' })
      );
      return () => expect(props.onSearch).toHaveBeenCalledTimes(1);
    }
  };

  it('names every slice 10 entry here or in Settings', () => {
    const slice10 = [
      ...Object.keys(tapPaths),
      'file-export-diagnostics',
      'file-export-interaction-log'
    ];
    for (const id of slice10) {
      expect(COMPACT_ENTRIES[id], id).toBeDefined();
    }
  });

  for (const [id, path] of Object.entries(tapPaths)) {
    it(`reaches ${id} (${COMPACT_ENTRIES[id]})`, async () => {
      const props = chrome();
      render(shell(props));
      const check = await path(props);
      check();
    });
  }
});
