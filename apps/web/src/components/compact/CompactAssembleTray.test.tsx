import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordingExecute, scissorsManager } from '../../test/assemblyFixture';
import {
  assemblyRuntime,
  getAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import { createDefaultStudy } from '../../lib/assembly/motionStudy';
import { commandFactories } from '@openzcad/command-system';
import { AppShell } from '../AppShell';
import CompactAssembleTray, {
  ASSEMBLE_PAGE_SECTIONS,
  type CompactAssembleTrayProps
} from './CompactAssembleTray';
import type { CompactChromeProps } from './compactSlots';
import { COMPACT_PANEL_ORDER } from './panelSheet';

afterEach(() => {
  act(() => {
    assemblyRuntime.reset();
    assemblyRuntime.setActive(false);
  });
});

function chrome(): CompactChromeProps & { sheetKey: string } {
  return {
    projectName: 'Scissors',
    saveState: 'synced',
    workspaceMode: 'assemble',
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
  };
}

/** Assemble's tray in the compact shell, on a live document. */
function mount(fixture = scissorsManager({ joint: true })) {
  const recorder = recordingExecute(fixture.manager);
  const onStatus = vi.fn();
  const props = (): CompactAssembleTrayProps => ({
    measure: { on: false, toggle: vi.fn(), dock: null },
    panel: {
      document: fixture.live(),
      execute: (command) => {
        const done = recorder.execute(command);
        view.rerender(element());
        return done;
      },
      onStatus,
      checkInterference: vi.fn(async () => ({ pairs: [] }) as never)
    },
    onStageCovered: vi.fn()
  });
  const element = () => (
    <AppShell
      topBar={<header className="topbar">top</header>}
      toolBar={null}
      sidebar={null}
      viewer={<div className="viewer-shell">viewer</div>}
      inspector={null}
      assistant={null}
      sidebarWidth={252}
      assistantWidth={360}
      compact={chrome()}
      compactTray={<CompactAssembleTray {...props()} />}
    />
  );
  const view = render(element());
  return {
    ...recorder,
    fixture,
    onStatus,
    rerender: () => view.rerender(element())
  };
}

const detent = () =>
  document.querySelector('.compact-sheet')!.getAttribute('data-detent');

async function trayButton(name: string) {
  const toolbar = await screen.findByRole('toolbar', {
    name: 'Assemble tools'
  });
  return within(toolbar).getByRole('button', { name });
}

const sheetTitle = (name: string) => screen.getByRole('heading', { name });

describe('Assemble’s compact tray', () => {
  it('rests at peek with its five verbs, each opening its page of the sidebar', async () => {
    mount();
    const names = within(
      await screen.findByRole('toolbar', { name: 'Assemble tools' })
    )
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual([
      'Joints',
      'Motion',
      'Exploded view',
      'Parts',
      'Player'
    ]);
    await waitFor(() => expect(detent()).toBe('peek'));

    // The page's own regions: the sheet is a region too.
    const regions = () =>
      [
        ...document.querySelectorAll(
          '.compact-tray-page [role="region"], .compact-tray-page section[aria-label]'
        )
      ].map((region) => region.getAttribute('aria-label'));
    fireEvent.click(await trayButton('Joints'));
    await waitFor(() => expect(detent()).toBe('half'));
    expect(sheetTitle('Joints')).toBeVisible();
    await waitFor(() => expect(regions()).toEqual(['Joints']));

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(await trayButton('Parts'));
    await waitFor(() =>
      expect(regions()).toEqual(['Parts', 'Interference', 'Bill of materials'])
    );

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(await trayButton('Exploded view'));
    await waitFor(() => expect(regions()).toEqual(['Exploded view']));

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(await trayButton('Motion'));
    await waitFor(() =>
      expect(regions()).toEqual(['Make it move', 'Positions', 'Animations'])
    );
    expect(ASSEMBLE_PAGE_SECTIONS.motion).toEqual([
      'motion',
      'positions',
      'studies'
    ]);
    // No desktop header: the sheet's title names the page.
    expect(screen.queryByRole('heading', { name: 'Assembly' })).toBeNull();
  });

  it('fixes a part in place from the Parts page', async () => {
    const { commands } = mount(scissorsManager({ components: true }));
    fireEvent.click(await trayButton('Parts'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Fix Blade B in place' })
    );
    expect(commands.at(-1)).toMatchObject({
      payload: { componentId: 'comp_b', grounded: true }
    });
  });

  it('draws the joint card on the Joints page, and Back closes the tool', async () => {
    mount(scissorsManager({ components: true }));
    fireEvent.click(await trayButton('Joints'));
    const joints = await screen.findByRole('region', { name: 'Joints' });
    fireEvent.click(within(joints).getByRole('button', { name: 'Add' }));
    expect(getAssemblyRuntime().jointTool).not.toBeNull();
    expect(
      await screen.findByRole('region', { name: 'Add joint' })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(detent()).toBe('peek'));
    expect(getAssemblyRuntime().jointTool).toBeNull();
  });

  it('brings the Joints page up for a joint tool opened from elsewhere', async () => {
    mount(scissorsManager({ components: true }));
    await trayButton('Joints');
    act(() => assemblyRuntime.openJointTool());
    expect(
      await screen.findByRole('region', { name: 'Add joint' })
    ).toBeInTheDocument();
    expect(sheetTitle('Joints')).toBeVisible();
  });

  it('draws the timeline under the animations, and leaving closes it', async () => {
    const fixture = scissorsManager({ joint: true });
    fixture.manager.execute(
      commandFactories.setAssemblyStudy({
        study: createDefaultStudy(fixture.manager.document.assembly, 'study_1')
      })
    );
    mount(fixture);
    fireEvent.click(await trayButton('Motion'));
    const animations = await screen.findByRole('region', {
      name: 'Animations'
    });
    fireEvent.click(
      within(animations).getByRole('button', { name: /^Animation 1/ })
    );
    const timeline = await screen.findByRole('region', {
      name: 'Animation Animation 1'
    });
    expect(
      within(timeline).getByRole('button', { name: 'Previous key' })
    ).toBeInTheDocument();
    expect(
      within(timeline).getByRole('button', { name: 'Next key' })
    ).toBeInTheDocument();
    expect(timeline).not.toHaveClass('motion-timeline-floating');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() =>
      expect(getAssemblyRuntime().selectedStudyId).toBeNull()
    );
  });

  it('says there is nothing to play with only a rigid joint', async () => {
    const fixture = scissorsManager({ components: true });
    fixture.manager.execute(
      commandFactories.addAssemblyJoint({
        joint: {
          id: 'joint_weld',
          name: 'Weld',
          kind: 'rigid',
          parent: {
            componentId: 'comp_a',
            frame: {
              origin: { x: 0, y: 0, z: 0 },
              zAxis: { x: 0, y: 0, z: 1 },
              xAxis: { x: 1, y: 0, z: 0 }
            }
          },
          child: {
            componentId: 'comp_b',
            frame: {
              origin: { x: 0, y: 0, z: 0 },
              zAxis: { x: 0, y: 0, z: 1 },
              xAxis: { x: 1, y: 0, z: 0 }
            }
          },
          values: [],
          limits: []
        }
      })
    );
    mount(fixture);
    fireEvent.click(await trayButton('Player'));
    expect(await screen.findByText('Nothing to play yet.')).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Motion player' })).toBeNull();
  });

  it('plays on the Player page, stopping a joint already playing', async () => {
    const fixture = scissorsManager({ joint: true });
    mount(fixture);
    await trayButton('Player');
    act(() => {
      assemblyRuntime.setActive(true);
      assemblyRuntime.startJointSweep('joint_pin', 0, 'ping-pong', 1.5);
    });
    expect(getAssemblyRuntime().playback).not.toBeNull();
    fireEvent.click(await trayButton('Player'));
    expect(
      await screen.findByRole('group', { name: 'Motion player' })
    ).toBeInTheDocument();
    await waitFor(() => expect(getAssemblyRuntime().playback).toBeNull());
  });
});
