import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../AppShell';
import CompactModeTray, {
  type CompactSketchTrayProps
} from './CompactModeTray';
import { controlOwnsEnter } from '../../lib/exactEntryShortcut';
import {
  contextualRelations,
  SKETCH_LONG_PRESS_MS,
  sketchSelectAllReason
} from './CompactSketchTray';
import type { CompactChromeProps, CompactSketchChrome } from './compactSlots';
import { COMPACT_PANEL_ORDER } from './panelSheet';

function chrome(
  sketch: CompactSketchChrome | null,
  selectionLabel: string | null = null
): CompactChromeProps & { sheetKey: string } {
  return {
    projectName: 'Bracket',
    saveState: 'synced',
    workspaceMode: 'build',
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
    fileCommands: [],
    selectionLabel,
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
    sketch,
    sheetKey: ''
  };
}

function shell(
  tray: ReactNode,
  sketch: CompactSketchChrome | null = {
    name: 'Sketch 01',
    solve: null,
    onFinish: vi.fn()
  },
  selectionLabel: string | null = null
) {
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
      compact={chrome(sketch, selectionLabel)}
      compactTray={tray}
    />
  );
}

function props(
  overrides: Partial<CompactSketchTrayProps> = {}
): CompactSketchTrayProps {
  return {
    tool: 'select',
    circleMode: 'center-radius',
    rectangleMode: 'corner',
    polygonSides: 6,
    projectMode: 'linked',
    construction: false,
    canConstrain: true,
    canExtrude: true,
    solving: false,
    pendingEdit: null,
    pendingConstraint: null,
    selectedObjectCount: 0,
    relationSelection: null,
    splineInProgress: false,
    workflow: <div className="sketch-workflow">Top plane</div>,
    palette: {
      settings: {
        gridVisible: true,
        relationGlyphs: 'always',
        hiddenRelationGlyphs: [],
        geometrySnapEnabled: true,
        inferenceEnabled: true,
        autoConstrain: true,
        snapHints: true,
        snapEnabled: false,
        linearSnap: 1
      } as never,
      units: 'mm',
      constraints: [],
      solveStatus: null,
      solving: false,
      onSettings: vi.fn(),
      onEditConstraint: vi.fn(),
      onDeleteConstraint: vi.fn(),
      onSelectConstraintObject: vi.fn()
    },
    entityEditor: null,
    textCard: null,
    onTool: vi.fn(),
    onCircleMode: vi.fn(),
    onRectangleMode: vi.fn(),
    onPolygonSides: vi.fn(),
    onCurveMode: vi.fn(),
    onProjectMode: vi.fn(),
    onFinishSpline: vi.fn(),
    onEditTool: vi.fn(),
    onModifyOptions: vi.fn(),
    onConstruction: vi.fn(),
    onDimension: vi.fn(),
    onSolve: vi.fn(),
    onDiagnostics: vi.fn(),
    onExtrude: vi.fn(),
    onConstraintTool: vi.fn(),
    onSelectionConstraintTool: vi.fn(),
    onSelectAll: vi.fn(),
    onCopy: vi.fn(),
    onPaste: vi.fn(),
    ...overrides
  };
}

const sheet = () => document.querySelector('.compact-sheet')!;
const detent = () => sheet().getAttribute('data-detent');

async function tools() {
  return screen.findByRole('toolbar', { name: 'Sketch tools' });
}

async function openAllSketchTools() {
  fireEvent.click(
    within(await tools()).getByRole('button', { name: 'All sketch tools' })
  );
  expect(await screen.findByRole('heading', { name: 'Sketch' })).toBeVisible();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the compact sketch', () => {
  it('takes over the shell: the sketch in the header, Finish, no mode tabs', async () => {
    const onFinish = vi.fn();
    render(
      shell(<CompactModeTray mode="sketch" {...props()} />, {
        name: 'Sketch 02',
        solve: { tone: 'info', label: '3 DOF remaining' },
        onFinish
      })
    );
    await tools();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Sketch 02' })
    ).toBeVisible();
    expect(
      screen.getByRole('img', { name: 'Sketch state: 3 DOF remaining' })
    ).toHaveClass('is-info');
    expect(screen.queryByRole('group', { name: 'Workspace mode' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Sketch' }));
    expect(onFinish).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(detent()).toBe('peek'));
  });

  it('keeps the mode tabs and the project outside a sketch', async () => {
    render(shell(null, null));
    expect(
      await screen.findByRole('group', { name: 'Workspace mode' })
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Finish Sketch' })).toBeNull();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Bracket' })
    ).toBeVisible();
  });

  it('draws with the tray’s tools, the live one pressed', async () => {
    const p = props({ tool: 'line' });
    render(shell(<CompactModeTray mode="sketch" {...p} />));
    const row = await tools();
    expect(within(row).getByRole('button', { name: 'Line' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    for (const name of ['Select', 'Arc', 'Text']) {
      fireEvent.click(within(row).getByRole('button', { name }));
    }
    expect(p.onTool).toHaveBeenNthCalledWith(1, 'select');
    expect(p.onTool).toHaveBeenNthCalledWith(2, 'arc');
    expect(p.onTool).toHaveBeenNthCalledWith(3, 'text');
    fireEvent.click(within(row).getByRole('button', { name: 'Rectangle' }));
    expect(p.onTool).toHaveBeenLastCalledWith('rectangle');
    fireEvent.click(
      within(row).getByRole('button', { name: 'Circle: Center circle' })
    );
    expect(p.onTool).toHaveBeenLastCalledWith('circle');
    fireEvent.click(
      within(row).getByRole('button', { name: 'Curve: Ellipse' })
    );
    expect(p.onCurveMode).toHaveBeenLastCalledWith('ellipse');
    fireEvent.click(within(row).getByRole('button', { name: 'Project edges' }));
    expect(p.onProjectMode).toHaveBeenLastCalledWith('linked');
  });

  it('chooses a type in the tray’s own row: a tap on the live tool, or a hold', async () => {
    function Harness() {
      const [tool, setTool] =
        useState<CompactSketchTrayProps['tool']>('rectangle');
      const [rectangleMode, setRectangleMode] =
        useState<CompactSketchTrayProps['rectangleMode']>('corner');
      return shell(
        <CompactModeTray
          mode="sketch"
          {...props({
            tool,
            rectangleMode,
            onTool: setTool,
            onRectangleMode: (mode) => {
              setTool('rectangle');
              setRectangleMode(mode);
            }
          })}
        />
      );
    }
    render(<Harness />);
    const row = await tools();
    fireEvent.click(within(row).getByRole('button', { name: 'Rectangle' }));
    const types = within(row).getByRole('radiogroup', { name: 'Shape type' });
    expect(
      within(types).getByRole('radio', { name: 'Rectangle' })
    ).toBeChecked();
    // The types stand in the tray, in the sheet: none on the stage.
    expect(sheet().contains(types)).toBe(true);
    fireEvent.click(
      within(types).getByRole('radio', { name: 'Center rectangle' })
    );
    expect(
      within(row).queryByRole('radiogroup', { name: 'Shape type' })
    ).toBeNull();
    // The polygon keeps the row for its side count.
    fireEvent.click(within(row).getByRole('button', { name: 'Rectangle' }));
    fireEvent.click(
      within(
        within(row).getByRole('radiogroup', { name: 'Shape type' })
      ).getByRole('radio', { name: 'Polygon' })
    );
    expect(
      await within(row).findByRole('spinbutton', { name: 'Polygon sides' })
    ).toBeVisible();
    fireEvent.click(
      within(row).getByRole('button', { name: 'Back to the sketch tools' })
    );
    expect(
      within(row).getByRole('button', { name: 'Polygon' })
    ).toHaveAttribute('aria-pressed', 'true');

    // A hold opens an idle tool's types without arming it first.
    vi.useFakeTimers();
    const circle = within(row).getByRole('button', {
      name: 'Circle: Center circle'
    });
    fireEvent.pointerDown(circle, { button: 0 });
    act(() => {
      vi.advanceTimersByTime(SKETCH_LONG_PRESS_MS + 10);
    });
    fireEvent.pointerUp(circle);
    fireEvent.click(circle);
    expect(
      within(row).getByRole('radiogroup', { name: 'Circle type' })
    ).toBeInTheDocument();
  });

  it('offers ✓ to finish a spline while one is placed', async () => {
    const p = props({ tool: 'spline', splineInProgress: true });
    render(shell(<CompactModeTray mode="sketch" {...p} />));
    fireEvent.click(
      within(await tools()).getByRole('button', { name: 'Finish spline' })
    );
    expect(p.onFinishSpline).toHaveBeenCalledTimes(1);
  });

  it('runs modify, construction, dimension, solve, diagnostics and extrude from the page', async () => {
    const p = props({
      palette: {
        ...props().palette,
        constraints: [
          { constraintId: 'c1', label: 'Horizontal · Line 1', editable: false }
        ]
      }
    });
    render(shell(<CompactModeTray mode="sketch" {...p} />));
    await openAllSketchTools();
    await waitFor(() => expect(detent()).toBe('half'));
    const modify = screen.getByRole('region', { name: 'Modify' });
    fireEvent.click(within(modify).getByRole('button', { name: 'Trim' }));
    expect(p.onEditTool).toHaveBeenLastCalledWith('trim', expect.any(String));
    // A tool without options goes straight to the canvas.
    await waitFor(() => expect(detent()).toBe('peek'));

    await openAllSketchTools();
    fireEvent.click(screen.getByRole('button', { name: 'Construction' }));
    expect(p.onConstruction).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Solve' }));
    expect(p.onSolve).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dimension' }));
    expect(p.onDimension).toHaveBeenCalledTimes(1);
    await openAllSketchTools();
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    expect(p.onDiagnostics).toHaveBeenCalledTimes(1);
    await openAllSketchTools();
    fireEvent.click(screen.getByRole('button', { name: 'Extrude' }));
    expect(p.onExtrude).toHaveBeenCalledTimes(1);
    await openAllSketchTools();
    // The palette's constraint list and display settings are on the page.
    const palette = screen.getByRole('region', { name: 'Sketch palette' });
    expect(within(palette).getByText('Top plane')).toBeVisible();
    expect(
      within(palette).getByRole('checkbox', { name: 'Show adaptive grid' })
    ).toBeChecked();
    expect(
      within(palette).getByRole('button', {
        name: 'Delete constraint: Horizontal · Line 1'
      })
    ).toBeVisible();
    // The keyboard's snapping keys are not offered to a finger.
    expect(within(palette).queryByText(/Tab cycles overlaps/)).toBeNull();
  });

  it('keeps an armed Offset’s page up for its options', async () => {
    const p = props({ pendingEdit: { kind: 'offset', picks: [] } });
    render(shell(<CompactModeTray mode="sketch" {...p} />));
    // The armed tool marks All sketch tools, where it was chosen.
    expect(
      within(await tools()).getByRole('button', { name: 'All sketch tools' })
    ).toHaveClass('is-on');
    await openAllSketchTools();
    const options = screen.getByRole('group', { name: 'Offset options' });
    fireEvent.click(within(options).getByRole('radio', { name: 'Round' }));
    expect(p.onModifyOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ join: 'round' })
    );
  });

  it('copies, pastes and selects all from the page and the selection chip', async () => {
    const p = props({
      selectedObjectCount: 1,
      entityEditor: <form aria-label="Line 1 editor" />
    });
    render(
      shell(<CompactModeTray mode="sketch" {...p} />, undefined, 'Line 1')
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Selection: Line 1' })
    );
    expect(
      await screen.findByRole('heading', { name: 'Line 1' })
    ).toBeVisible();
    expect(screen.getByRole('form', { name: 'Line 1 editor' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(p.onCopy).toHaveBeenCalledTimes(1);
    expect(p.onPaste).toHaveBeenCalledTimes(1);
    expect(p.onSelectAll).toHaveBeenCalledTimes(1);
  });

  it('shows only the relations that fit the pick, as chips on the stage', async () => {
    const p = props({
      relationSelection: {
        kind: 'line',
        fitting: ['horizontal', 'vertical', 'distance']
      }
    });
    const { rerender } = render(
      shell(<CompactModeTray mode="sketch" {...p} />)
    );
    const relations = await screen.findByRole('toolbar', { name: 'Relations' });
    expect(
      within(relations)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Horizontal', 'Vertical', 'Distance']);
    // On the stage, not in the sheet.
    expect(sheet().contains(relations)).toBe(false);
    fireEvent.click(
      within(relations).getByRole('button', { name: 'Horizontal' })
    );
    expect(p.onSelectionConstraintTool).toHaveBeenCalledWith('horizontal');
    // Nothing picked, nothing armed: no row at all.
    rerender(shell(<CompactModeTray mode="sketch" {...props()} />));
    await waitFor(() =>
      expect(screen.queryByRole('toolbar', { name: 'Relations' })).toBeNull()
    );
  });

  it('keeps an armed relation in the row so it can be put down', () => {
    expect(
      contextualRelations(null, { kind: 'parallel', picks: [] } as never, true)
    ).toEqual(['parallel']);
    expect(
      contextualRelations(
        { kind: 'circle', fitting: ['radius', 'equal'] },
        null,
        true
      )
    ).toEqual(['equal', 'radius']);
    expect(
      contextualRelations(
        { kind: 'line', fitting: ['horizontal'] },
        null,
        false
      )
    ).toEqual([]);
  });

  it('opens the Text tool’s card as the sheet’s page while text is composed', async () => {
    const { rerender } = render(
      shell(<CompactModeTray mode="sketch" {...props({ tool: 'text' })} />)
    );
    await tools();
    rerender(
      shell(
        <CompactModeTray
          mode="sketch"
          {...props({
            tool: 'text',
            textCard: <form aria-label="Sketch text" />
          })}
        />
      )
    );
    expect(
      await screen.findByRole('form', { name: 'Sketch text' })
    ).toBeVisible();
    await waitFor(() => expect(detent()).toBe('half'));
    rerender(
      shell(<CompactModeTray mode="sketch" {...props({ tool: 'select' })} />)
    );
    await waitFor(() => expect(detent()).toBe('peek'));
  });

  it('keeps Enter on its own controls while a spline is placed', async () => {
    const p = props({
      tool: 'spline',
      splineInProgress: true,
      relationSelection: { kind: 'line', fitting: ['horizontal'] }
    });
    render(shell(<CompactModeTray mode="sketch" {...p} />));
    const row = await tools();
    // The viewer finishes a spline on Enter unless the focused control owns
    // it: All sketch tools opened nothing and finished the spline instead.
    const all = within(row).getByRole('button', { name: 'All sketch tools' });
    expect(controlOwnsEnter(all)).toBe(true);
    expect(
      controlOwnsEnter(
        within(row).getByRole('button', { name: 'Finish spline' })
      )
    ).toBe(true);
    const relations = await screen.findByRole('toolbar', { name: 'Relations' });
    expect(
      controlOwnsEnter(
        within(relations).getByRole('button', { name: 'Horizontal' })
      )
    ).toBe(true);
    // A draw tool leaves Enter to the work in progress, as the rail does.
    expect(
      controlOwnsEnter(within(row).getByRole('button', { name: 'Line' }))
    ).toBe(false);
    // A type chooser's tiles leave Enter to the work in progress, as the
    // rail's type strips do: Enter on the Fit spline tile finishes the
    // spline, not re-arms the tool and drops its points. Back is the row's
    // own way out.
    fireEvent.click(within(row).getByRole('button', { name: /^Curve:/ }));
    const types = within(row).getByRole('radiogroup', { name: 'Curve type' });
    for (const radio of within(types).getAllByRole('radio')) {
      expect(controlOwnsEnter(radio)).toBe(false);
    }
    expect(
      controlOwnsEnter(
        within(row).getByRole('button', { name: 'Back to the sketch tools' })
      )
    ).toBe(true);
    fireEvent.click(
      within(row).getByRole('button', { name: 'Back to the sketch tools' })
    );
    await openAllSketchTools();
    const page = within(sheet() as HTMLElement);
    for (const name of ['Construction', 'Select all', 'Trim', 'Horizontal']) {
      expect(controlOwnsEnter(page.getByRole('button', { name })), name).toBe(
        true
      );
    }
  });

  it('brings a composed text’s card back when Text is tapped again', async () => {
    const p = props({
      tool: 'text',
      textCard: <form aria-label="Sketch text" />
    });
    render(shell(<CompactModeTray mode="sketch" {...p} />));
    expect(
      await screen.findByRole('form', { name: 'Sketch text' })
    ).toBeVisible();
    await waitFor(() => expect(detent()).toBe('half'));
    // Closed over the draft: the draft stays, and so must a way back to it.
    fireEvent.click(screen.getByRole('button', { name: 'Close sheet' }));
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Sketch text' })).toBeNull()
    );
    fireEvent.click(
      within(await tools()).getByRole('button', { name: 'Text' })
    );
    expect(
      await screen.findByRole('form', { name: 'Sketch text' })
    ).toBeVisible();
    await waitFor(() => expect(detent()).toBe('half'));
    // The tool is not re-armed: that keeps the draft, but says nothing.
    expect(p.onTool).not.toHaveBeenCalled();
    // Back, then Text: the same.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Sketch text' })).toBeNull()
    );
    fireEvent.click(
      within(await tools()).getByRole('button', { name: 'Text' })
    );
    expect(
      await screen.findByRole('form', { name: 'Sketch text' })
    ).toBeVisible();
  });

  it('holds Select all while a modify tool or relation collects its picks', async () => {
    const p = props({ pendingEdit: { kind: 'offset', picks: [] } });
    const { rerender } = render(
      shell(<CompactModeTray mode="sketch" {...p} />)
    );
    await openAllSketchTools();
    const selectAll = screen.getByRole('button', { name: 'Select all' });
    // Ctrl+A does nothing here; the row says why rather than doing nothing,
    // and on a tap, since a phone has no hover to show its title.
    expect(selectAll).toHaveAttribute('aria-disabled', 'true');
    expect(selectAll).toHaveAttribute(
      'title',
      'Finish or cancel Offset first.'
    );
    const row = within(selectAll.closest('li') as HTMLElement);
    expect(row.queryByRole('status')).toBeNull();
    fireEvent.click(selectAll);
    expect(p.onSelectAll).not.toHaveBeenCalled();
    expect(row.getByRole('status')).toHaveTextContent(
      'Finish or cancel Offset first.'
    );
    expect(row.getByRole('status')).toBeVisible();
    rerender(
      shell(
        <CompactModeTray
          mode="sketch"
          {...props({
            pendingConstraint: { kind: 'parallel', picks: [] } as never
          })}
        />
      )
    );
    expect(screen.getByRole('button', { name: 'Select all' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    const free = props();
    rerender(shell(<CompactModeTray mode="sketch" {...free} />));
    const enabled = screen.getByRole('button', { name: 'Select all' });
    expect(enabled).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(enabled);
    expect(free.onSelectAll).toHaveBeenCalledTimes(1);
    expect(
      sketchSelectAllReason({
        canConstrain: false,
        pendingEdit: null,
        pendingConstraint: null
      })
    ).toBe('Draw an entity first.');
  });

  it('keeps a constraint’s shown geometry when its page closes and opens', async () => {
    const p = props({
      palette: {
        ...props().palette,
        constraints: [
          {
            constraintId: 'c1',
            label: 'Horizontal · Line 1',
            editable: false,
            targets: [{ objectId: 'e1', label: 'Line 1' }]
          }
        ]
      }
    });
    render(shell(<CompactModeTray mode="sketch" {...p} />));
    await openAllSketchTools();
    const name = 'Show geometry for constraint: Horizontal · Line 1';
    fireEvent.click(screen.getByRole('button', { name }));
    expect(screen.getByRole('button', { name })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close sheet' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name })).toBeNull()
    );
    await openAllSketchTools();
    expect(screen.getByRole('button', { name })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });
});
