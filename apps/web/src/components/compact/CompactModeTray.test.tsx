import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  toEntityId,
  toParameterId,
  type ParameterNode
} from '@openzcad/shared';
import { act } from 'react';
import { analysisRuntime } from '../../lib/analysis/analysisRuntime';
import { AppShell } from '../AppShell';
import CompactModeTray, {
  type CompactTweakTrayProps,
  type CompactViewTrayProps
} from './CompactModeTray';
import { parameterStep, steppedParameter } from './CompactTweakTray';
import type { CompactChromeProps } from './compactSlots';
import { COMPACT_PANEL_ORDER } from './panelSheet';

function chrome(mode: 'view' | 'tweak'): CompactChromeProps & {
  sheetKey: string;
} {
  return {
    projectName: 'Bracket',
    saveState: 'synced',
    workspaceMode: mode,
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

function shell(mode: 'view' | 'tweak', tray: ReactNode) {
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
      compact={chrome(mode)}
      compactTray={tray}
    />
  );
}

const sheet = () => document.querySelector('.compact-sheet')!;
const detent = () => sheet().getAttribute('data-detent');

function viewProps(
  overrides: Partial<CompactViewTrayProps> = {}
): CompactViewTrayProps {
  return {
    measure: { on: false, toggle: vi.fn(), dock: null },
    section: {
      current: null,
      rangeFor: () => ({ min: 0, max: 100 }),
      outline: { kind: 'clipping' },
      units: 'mm',
      onToggle: vi.fn(),
      onPlane: vi.fn(),
      onOffset: vi.fn(),
      onCommit: vi.fn(),
      onFlip: vi.fn(),
      onExport: vi.fn()
    },
    display: {
      settings: { showGrid: true, displayMode: 'shaded-edges' },
      projection: 'perspective',
      onDisplayMode: vi.fn(),
      onToggleXray: vi.fn(),
      onToggleProjection: vi.fn(),
      onToggleOrbitMode: vi.fn(),
      onToggleGrid: vi.fn(),
      onFit: vi.fn()
    },
    views: { onView: vi.fn() },
    parts: {
      bodies: [
        { bodyId: 'plate', name: 'Plate', color: '#888' },
        { bodyId: 'lug', name: 'Lug', color: '#888' }
      ] as never,
      hiddenBodyIds: new Set<string>(),
      selectedBodyIds: [],
      onSelectBody: vi.fn(),
      onToggleVisibility: vi.fn(),
      onIsolate: vi.fn(),
      onShowAll: vi.fn()
    },
    onStageCovered: vi.fn(),
    ...overrides
  };
}

function parameter(
  name: string,
  expression: string,
  extra: Partial<ParameterNode> = {}
): ParameterNode {
  return {
    kind: 'parameter',
    id: toEntityId(`node-${name}`),
    parentId: null,
    revisionId: null,
    parameterId: toParameterId(`param-${name}`),
    name,
    expression,
    value: Number(expression),
    ...extra
  };
}

function tweakProps(
  overrides: Partial<CompactTweakTrayProps> = {}
): CompactTweakTrayProps {
  return {
    measure: { on: false, toggle: vi.fn(), dock: null },
    units: 'mm',
    parameters: [
      parameter('width', '20', { quantity: 'length' }),
      parameter('half', 'width / 2', { value: 10 }),
      parameter('lettering', '1', { toggle: { bodyIds: [] } })
    ],
    parameterValues: { width: 20, half: 10, lettering: 1 },
    parameterMinimums: { width: 20 },
    onSetParameter: vi.fn(async () => null),
    onPreviewParameter: vi.fn(),
    configuration: {
      rows: [
        { id: 'small', name: 'Small' },
        { id: 'large', name: 'Large' }
      ],
      activeRowId: 'small',
      onActivate: vi.fn()
    },
    canExport: true,
    exportScope: null,
    onExportStep: vi.fn(),
    onOpenMeshExport: vi.fn(),
    onViewActivityLog: vi.fn(),
    onStageCovered: vi.fn(),
    ...overrides
  };
}

async function trayButton(tray: string, name: string) {
  const toolbar = await screen.findByRole('toolbar', { name: tray });
  return within(toolbar).getByRole('button', { name });
}

describe('the compact tray', () => {
  it('rests at peek and opens each page over it, Back returning', async () => {
    render(shell('view', <CompactModeTray mode="view" {...viewProps()} />));
    const views = await trayButton('View tools', 'Standard views');
    await waitFor(() => expect(detent()).toBe('peek'));
    fireEvent.click(views);
    await waitFor(() => expect(detent()).toBe('half'));
    expect(screen.getByRole('heading', { name: 'Views' })).toBeVisible();
    expect(
      await screen.findByRole('button', { name: 'Top view' })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(detent()).toBe('peek'));
    expect(screen.queryByRole('heading', { name: 'Views' })).toBeNull();
  });

  it('takes a raised tray back to peek when its page goes', async () => {
    // A page opened over a raised sheet used to leave the tray standing at
    // that height over blank space when it went (the space review).
    render(shell('view', <CompactModeTray mode="view" {...viewProps()} />));
    const views = await trayButton('View tools', 'Standard views');
    await waitFor(() => expect(detent()).toBe('peek'));
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Sheet height' }), {
      key: 'End'
    });
    await waitFor(() => expect(detent()).toBe('full'));
    fireEvent.click(views);
    expect(screen.getByRole('heading', { name: 'Views' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(detent()).toBe('peek'));
  });

  it('takes an open page away with its tray when the mode changes', async () => {
    const { rerender } = render(
      shell('view', <CompactModeTray mode="view" {...viewProps()} />)
    );
    fireEvent.click(await trayButton('View tools', 'Section view'));
    expect(
      await screen.findByRole('heading', { name: 'Section' })
    ).toBeVisible();
    rerender(
      shell('tweak', <CompactModeTray mode="tweak" {...tweakProps()} />)
    );
    expect(await trayButton('Tweak tools', 'Parameters')).toBeVisible();
    await waitFor(() => expect(detent()).toBe('peek'));
    expect(screen.queryByRole('heading', { name: 'Section' })).toBeNull();
    // A mode with no tray closes a sheet that holds nothing else.
    fireEvent.click(await trayButton('Tweak tools', 'Export'));
    expect(
      await screen.findByRole('heading', { name: 'Export' })
    ).toBeVisible();
    rerender(shell('tweak', null));
    await waitFor(() => expect(detent()).toBe('closed'));
  });

  it('opens Measure’s page with Measure on, and switches it off on leaving', async () => {
    const toggle = vi.fn();
    function Harness() {
      const [on, setOn] = useState(false);
      return shell(
        'view',
        <CompactModeTray
          mode="view"
          {...viewProps({
            measure: {
              on,
              toggle: (next) => {
                toggle(next);
                setOn(next);
              },
              dock: on ? <aside aria-label="Measurement workbench" /> : null
            }
          })}
        />
      );
    }
    render(<Harness />);
    const measure = await trayButton('View tools', 'Measure');
    expect(measure).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(measure);
    expect(toggle).toHaveBeenLastCalledWith(true);
    expect(
      await screen.findByRole('complementary', {
        name: 'Measurement workbench'
      })
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Measure' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(toggle).toHaveBeenLastCalledWith(false));
    await waitFor(() => expect(detent()).toBe('peek'));
    expect(await trayButton('View tools', 'Measure')).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('runs View’s handlers from the Display, Views, Section and Parts pages', async () => {
    const props = viewProps({
      section: {
        ...viewProps().section,
        current: { plane: 'XZ', offset: 50 }
      }
    });
    render(shell('view', <CompactModeTray mode="view" {...props} />));
    fireEvent.click(await trayButton('View tools', 'Display mode'));
    fireEvent.click(await screen.findByRole('button', { name: 'Wireframe' }));
    expect(props.display.onDisplayMode).toHaveBeenCalledWith('wireframe');
    fireEvent.click(screen.getByRole('button', { name: 'Fit view' }));
    expect(props.display.onFit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Grid' }));
    expect(props.display.onToggleGrid).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Grid' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    // A standard view, and the sheet steps back to the tray.
    fireEvent.click(await trayButton('View tools', 'Standard views'));
    fireEvent.click(await screen.findByRole('button', { name: 'Top view' }));
    expect(props.views.onView).toHaveBeenCalledWith('top');
    await waitFor(() => expect(detent()).toBe('peek'));

    // The cut, moved a twentieth of the model a tap.
    fireEvent.click(await trayButton('View tools', 'Section view'));
    expect(
      await screen.findByRole('switch', { name: 'Section cut' })
    ).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(
      screen.getByRole('button', { name: 'Move the cut forward' })
    );
    expect(props.section.onOffset).toHaveBeenCalledWith(55);
    expect(props.section.onCommit).toHaveBeenCalledWith(55);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    fireEvent.click(await trayButton('View tools', 'Parts'));
    fireEvent.click(await screen.findByRole('button', { name: 'Hide Lug' }));
    expect(props.parts.onToggleVisibility).toHaveBeenCalledWith('lug');
    fireEvent.click(screen.getByRole('button', { name: 'Show only Plate' }));
    expect(props.parts.onIsolate).toHaveBeenCalledWith('plate');
  });

  it('says there is nothing to cut rather than drawing empty controls', async () => {
    render(
      shell(
        'view',
        <CompactModeTray
          mode="view"
          {...viewProps({
            section: { ...viewProps().section, rangeFor: () => null }
          })}
        />
      )
    );
    fireEvent.click(await trayButton('View tools', 'Section view'));
    expect(await screen.findByText(/Nothing to cut yet/)).toBeVisible();
    expect(screen.queryByRole('switch', { name: 'Section cut' })).toBeNull();
  });

  it('keeps an analysis left on in reach, with Off, away from Display', async () => {
    try {
      const { rerender } = render(
        shell('view', <CompactModeTray mode="view" {...viewProps()} />)
      );
      fireEvent.click(await trayButton('View tools', 'Display mode'));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Thickness analysis' })
      );
      expect(analysisRuntime.get().request?.kind).toBe('thickness');
      // Display holds the panel and its Off: no chip on the stage.
      const chip = () =>
        screen.queryByRole('button', { name: 'Turn off thickness analysis' });
      expect(chip()).toBeNull();
      // Leaving Display, the model stays coloured; the chip says so.
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      await waitFor(() => expect(chip()).not.toBeNull());
      // And in another mode, where no page draws the panel.
      rerender(
        shell('tweak', <CompactModeTray mode="tweak" {...tweakProps()} />)
      );
      expect(await trayButton('Tweak tools', 'Parameters')).toBeVisible();
      expect(chip()).not.toBeNull();
      fireEvent.click(chip()!);
      expect(analysisRuntime.get().request).toBeNull();
      await waitFor(() => expect(chip()).toBeNull());
    } finally {
      act(() => analysisRuntime.reset());
    }
  });

  it('asks for the model above the sheet once a page has risen', async () => {
    const props = viewProps();
    render(shell('view', <CompactModeTray mode="view" {...props} />));
    fireEvent.click(await trayButton('View tools', 'Parts'));
    // Not at once: the sheet is still rising.
    expect(props.onStageCovered).not.toHaveBeenCalled();
    await waitFor(() => expect(props.onStageCovered).toHaveBeenCalledTimes(1));
  });
});

describe('the compact Tweak tray', () => {
  it('steps a plain value and leaves an expression to the keypad', async () => {
    const props = tweakProps();
    render(shell('tweak', <CompactModeTray mode="tweak" {...props} />));
    fireEvent.click(await trayButton('Tweak tools', 'Parameters'));
    const increase = await screen.findByRole('button', {
      name: 'Increase Width'
    });
    fireEvent.click(increase);
    await waitFor(() =>
      expect(props.onSetParameter).toHaveBeenCalledWith('width', '21')
    );
    // At its minimum, it does not go lower.
    expect(
      screen.getByRole('button', { name: 'Decrease Width' })
    ).toBeDisabled();
    // An expression keeps its formula: no steppers.
    expect(
      screen.getByRole('button', { name: 'Increase Half' })
    ).toBeDisabled();
    // On/off is one switch.
    const lettering = screen.getByRole('switch', {
      name: 'Toggle Lettering'
    });
    expect(lettering).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(lettering);
    await waitFor(() =>
      expect(props.onSetParameter).toHaveBeenCalledWith('lettering', '0')
    );
  });

  it('names each control by the label the row shows, not the parameter id', async () => {
    const props = tweakProps({
      parameters: [
        parameter('plate_t', '4', { quantity: 'length' }),
        parameter('r1', '2', {
          quantity: 'length',
          description: 'Corner radius'
        }),
        parameter('show_logo', '1', { toggle: { bodyIds: [] } })
      ],
      parameterValues: { plate_t: 4, r1: 2, show_logo: 1 },
      parameterMinimums: {}
    });
    render(shell('tweak', <CompactModeTray mode="tweak" {...props} />));
    fireEvent.click(await trayButton('Tweak tools', 'Parameters'));
    const list = await screen.findByRole('list', { name: 'Parameters' });
    for (const label of ['Plate t', 'Corner radius']) {
      expect(within(list).getByText(label)).toBeInTheDocument();
      for (const verb of ['Decrease', 'Edit', 'Increase']) {
        expect(
          within(list).getByRole('button', { name: `${verb} ${label}` })
        ).toBeInTheDocument();
      }
    }
    expect(
      within(list).getByRole('switch', { name: 'Toggle Show logo' })
    ).toBeInTheDocument();
    // No control is named by the expression id the row does not show.
    expect(
      within(list).queryByRole('button', { name: /plate_t|r1\b/ })
    ).toBeNull();
    // The value is still set by its id.
    fireEvent.click(within(list).getByRole('button', { name: 'Increase Plate t' }));
    await waitFor(() =>
      expect(props.onSetParameter).toHaveBeenCalledWith('plate_t', '5')
    );
  });

  it('types a value on the keypad and applies it', async () => {
    const props = tweakProps();
    render(shell('tweak', <CompactModeTray mode="tweak" {...props} />));
    fireEvent.click(await trayButton('Tweak tools', 'Parameters'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Width' }));
    const keypad = await screen.findByRole('dialog', { name: /value$/ });
    // Drawn over the sheet, in the compact frame's overlay host.
    expect(keypad.closest('.compact-overlay-host')).not.toBeNull();
    const field = within(keypad).getByRole('textbox');
    fireEvent.change(field, { target: { value: '32' } });
    expect(props.onPreviewParameter).toHaveBeenLastCalledWith('width', '32');
    fireEvent.click(within(keypad).getByRole('button', { name: /^Apply/ }));
    await waitFor(() =>
      expect(props.onSetParameter).toHaveBeenCalledWith('width', '32')
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /value$/ })).toBeNull()
    );
  });

  it.each(['Back', 'Close sheet'] as const)(
    'cancels a keypad draft left by the sheet’s %s',
    async (control) => {
      const props = tweakProps();
      render(shell('tweak', <CompactModeTray mode="tweak" {...props} />));
      fireEvent.click(await trayButton('Tweak tools', 'Parameters'));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Edit Width' })
      );
      const keypad = await screen.findByRole('dialog', { name: /value$/ });
      fireEvent.change(within(keypad).getByRole('textbox'), {
        target: { value: '32' }
      });
      expect(props.onPreviewParameter).toHaveBeenLastCalledWith('width', '32');
      fireEvent.click(screen.getByRole('button', { name: control }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: /value$/ })).toBeNull()
      );
      // The model drops the uncommitted value, and nothing was applied.
      expect(props.onPreviewParameter).toHaveBeenLastCalledWith('width', null);
      expect(props.onSetParameter).not.toHaveBeenCalled();
      // Back to the tray's row either way.
      await waitFor(() => expect(detent()).toBe('peek'));
    }
  );

  it('cancels a keypad draft when another mode takes the sheet', async () => {
    const props = tweakProps();
    const { rerender } = render(
      shell('tweak', <CompactModeTray mode="tweak" {...props} />)
    );
    fireEvent.click(await trayButton('Tweak tools', 'Parameters'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Width' }));
    const keypad = await screen.findByRole('dialog', { name: /value$/ });
    fireEvent.change(within(keypad).getByRole('textbox'), {
      target: { value: '32' }
    });
    rerender(shell('view', <CompactModeTray mode="view" {...viewProps()} />));
    await waitFor(() =>
      expect(props.onPreviewParameter).toHaveBeenLastCalledWith('width', null)
    );
  });

  it('applies a keypad value without cancelling its own edit', async () => {
    const props = tweakProps();
    render(shell('tweak', <CompactModeTray mode="tweak" {...props} />));
    fireEvent.click(await trayButton('Tweak tools', 'Parameters'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Width' }));
    const keypad = await screen.findByRole('dialog', { name: /value$/ });
    fireEvent.change(within(keypad).getByRole('textbox'), {
      target: { value: '32' }
    });
    fireEvent.click(within(keypad).getByRole('button', { name: /^Apply/ }));
    await waitFor(() =>
      expect(props.onSetParameter).toHaveBeenCalledWith('width', '32')
    );
    // Leaving after applying must not reach for the draft the edit took.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(detent()).toBe('peek'));
    expect(props.onPreviewParameter).not.toHaveBeenCalledWith('width', null);
  });

  it('leaves another field’s apply alone when a stale draft’s keypad closes', async () => {
    // As in App: the model holds one preview, and any preview call, a cancel
    // included, stops the parameter edit still being checked.
    let check = 0;
    const applied: Record<string, string> = {};
    let release: () => void = () => {};
    const props = tweakProps({
      parameters: [
        parameter('width', '20', { quantity: 'length' }),
        parameter('depth', '10', { quantity: 'length' })
      ],
      parameterValues: { width: 20, depth: 10 },
      parameterMinimums: {},
      onPreviewParameter: vi.fn(() => {
        check += 1;
      }),
      onSetParameter: vi.fn((name: string, expression: string) => {
        const request = ++check;
        return new Promise<string | null>((resolve) => {
          release = () => {
            if (check !== request) {
              resolve('The project or parameter changed. Try again.');
              return;
            }
            applied[name] = expression;
            resolve(null);
          };
        });
      })
    });
    render(shell('tweak', <CompactModeTray mode="tweak" {...props} />));
    fireEvent.click(await trayButton('Tweak tools', 'Parameters'));
    // A Width draft, left open.
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Width' }));
    const widthPad = await screen.findByRole('dialog', {
      name: /^width value$/i
    });
    fireEvent.change(within(widthPad).getByRole('textbox'), {
      target: { value: '32' }
    });
    // Depth, reached by keyboard, takes 22 and applies it.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Depth' }));
    const depthPad = await screen.findByRole('dialog', {
      name: /^depth value$/i
    });
    fireEvent.change(within(depthPad).getByRole('textbox'), {
      target: { value: '22' }
    });
    fireEvent.click(within(depthPad).getByRole('button', { name: /^Apply/ }));
    await waitFor(() =>
      expect(props.onSetParameter).toHaveBeenCalledWith('depth', '22')
    );
    // Back at once, while Depth is still being checked: Width's keypad
    // leaves, and its replaced draft must not cancel Depth's edit.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(detent()).toBe('peek'));
    await act(async () => release());
    expect(applied).toEqual({ depth: '22' });
    expect(props.onPreviewParameter).not.toHaveBeenCalledWith('width', null);
    expect(props.onPreviewParameter).not.toHaveBeenCalledWith('depth', null);
  });

  it('cancels only the draft the model shows when two keypads close', async () => {
    const props = tweakProps({
      parameters: [
        parameter('width', '20', { quantity: 'length' }),
        parameter('depth', '10', { quantity: 'length' })
      ],
      parameterValues: { width: 20, depth: 10 },
      parameterMinimums: {}
    });
    render(shell('tweak', <CompactModeTray mode="tweak" {...props} />));
    fireEvent.click(await trayButton('Tweak tools', 'Parameters'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Width' }));
    fireEvent.change(
      within(
        await screen.findByRole('dialog', { name: /^width value$/i })
      ).getByRole('textbox'),
      { target: { value: '32' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Depth' }));
    fireEvent.change(
      within(
        await screen.findByRole('dialog', { name: /^depth value$/i })
      ).getByRole('textbox'),
      { target: { value: '22' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(detent()).toBe('peek'));
    // Depth's draft replaced Width's in the model: one cancel, Depth's.
    const cancels = vi
      .mocked(props.onPreviewParameter!)
      .mock.calls.filter(([, expression]) => expression === null);
    expect(cancels).toEqual([['depth', null]]);
    expect(props.onSetParameter).not.toHaveBeenCalled();
  });

  it('switches configurations and exports from their pages', async () => {
    const props = tweakProps();
    render(shell('tweak', <CompactModeTray mode="tweak" {...props} />));
    fireEvent.click(await trayButton('Tweak tools', 'Configuration'));
    const large = await screen.findByRole('button', { name: 'Large' });
    expect(large).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(large);
    expect(props.configuration!.onActivate).toHaveBeenCalledWith('large');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    fireEvent.click(await trayButton('Tweak tools', 'Export'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Export STEP — all bodies' })
    );
    expect(props.onExportStep).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /^Export mesh…/ }));
    expect(props.onOpenMeshExport).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Activity log' }));
    expect(props.onViewActivityLog).toHaveBeenCalledTimes(1);
    // Make a copy is the header's More page's, for every mode (CompactAppShell).
    expect(screen.queryByRole('button', { name: 'Make a copy' })).toBeNull();
  });

  it('holds exports back with the reason, and has no Configuration without rows', async () => {
    render(
      shell(
        'tweak',
        <CompactModeTray
          mode="tweak"
          {...tweakProps({
            canExport: false,
            configuration: null,
            exportUnavailableReason: 'Show a body to export it.'
          })}
        />
      )
    );
    const toolbar = await screen.findByRole('toolbar', { name: 'Tweak tools' });
    expect(
      within(toolbar).queryByRole('button', { name: 'Configuration' })
    ).toBeNull();
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Export' }));
    expect(
      await screen.findByRole('button', { name: 'Export STEP — all bodies' })
    ).toBeDisabled();
    expect(screen.getByText('Show a body to export it.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Make a copy' })).toBeNull();
  });
});

describe('parameter steps', () => {
  it('steps by a tenth of the order from ten up, by the order below', () => {
    expect(parameterStep(20)).toBe(1);
    expect(parameterStep(5)).toBe(1);
    expect(parameterStep(150)).toBe(10);
    expect(parameterStep(0.5)).toBe(0.1);
    expect(parameterStep(0)).toBe(1);
    expect(steppedParameter(0.3, 1)).toBe(0.4);
    expect(steppedParameter(20, -1)).toBe(19);
  });
});
