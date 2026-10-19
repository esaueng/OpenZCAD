import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@openzcad/shared';
import { CONSTRAINT_TOOL_SPECS } from '../lib/sketch/constraints';
import { SKETCH_EDIT_TOOL_SPECS } from '../lib/sketch/edits';
import { SketchRelationsRail, SketchToolRail } from './SketchToolRail';

function renderRail(
  overrides: Partial<ComponentProps<typeof SketchToolRail>> = {}
) {
  const props: ComponentProps<typeof SketchToolRail> = {
    tool: 'circle',
    circleMode: 'center-radius',
    construction: false,
    settings: structuredClone(DEFAULT_APP_SETTINGS.sketching),
    units: 'mm',
    paletteVisible: true,
    canConstrain: true,
    pendingEdit: null,
    constraints: [],
    solveStatus: null,
    solving: false,
    onTool: vi.fn(),
    onCircleMode: vi.fn(),
    onConstruction: vi.fn(),
    onSettings: vi.fn(),
    onEditTool: vi.fn(),
    onEditConstraint: vi.fn(),
    onDeleteConstraint: vi.fn(),
    onSelectConstraintObject: vi.fn(),
    onSolve: vi.fn(),
    onDiagnostics: vi.fn(),
    onExtrude: vi.fn(),
    ...overrides
  };
  return { ...render(<SketchToolRail {...props} />), props };
}

function renderRelations(
  overrides: Partial<ComponentProps<typeof SketchRelationsRail>> = {}
) {
  const props: ComponentProps<typeof SketchRelationsRail> = {
    canConstrain: true,
    pendingConstraint: null,
    selection: null,
    onConstraintTool: vi.fn(),
    onSelectionConstraintTool: vi.fn(),
    ...overrides
  };
  return { ...render(<SketchRelationsRail {...props} />), props };
}

describe('SketchToolRail', () => {
  it('opens and focuses constraint recovery from a warning without guessing a culprit', async () => {
    const user = userEvent.setup();
    renderRail({
      constraints: [
        {
          constraintId: 'scon_1',
          label: 'Horizontal · Line 1',
          editable: false
        }
      ],
      solveStatus: {
        label: 'Over-constrained',
        tone: 'warn',
        definedState: 'over-constrained',
        conflictingConstraintIds: []
      }
    });
    expect(
      screen.getByRole('region', { name: 'Constraint feedback' })
    ).toHaveTextContent('Over-constrained');
    await user.click(
      screen.getByRole('button', { name: 'Review constraints' })
    );
    const group = screen.getByRole('group', { name: 'Constraints' });
    expect(group).toHaveFocus();
    expect(group).toHaveTextContent(
      'The solver did not identify a conflicting constraint.'
    );
    expect(
      screen.getByText('Horizontal · Line 1').closest('li')
    ).not.toHaveAttribute('data-conflicted');
  });

  it('reveals the exact referenced entities and keeps edit and deletion separate', async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderRail({
      paletteOpen: true,
      selectedObjectId: 'ent_1',
      constraints: [
        {
          constraintId: 'scon_1',
          label: 'Distance · Line 1 ↔ Line 2',
          editable: true,
          conflicted: true,
          targets: [
            { objectId: 'ent_1', label: 'Line 1' },
            { objectId: 'ent_2', label: 'Line 2' }
          ]
        }
      ],
      solveStatus: { label: 'Constraints conflict', tone: 'warn' }
    });
    const show = screen.getByRole('button', {
      name: 'Show geometry for constraint: Distance · Line 1 ↔ Line 2'
    });
    show.focus();
    await user.keyboard('{Enter}');
    expect(show).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByRole('button', { name: 'Select geometry: Line 1' })
    ).toHaveAttribute('aria-pressed', 'true');
    await user.click(
      screen.getByRole('button', { name: 'Select geometry: Line 2' })
    );
    expect(props.onSelectConstraintObject).toHaveBeenCalledWith(
      'scon_1',
      'ent_2'
    );
    expect(props.onEditConstraint).not.toHaveBeenCalled();
    expect(props.onDeleteConstraint).not.toHaveBeenCalled();
    rerender(<SketchToolRail {...props} solving />);
    expect(
      screen.getByRole('button', { name: 'Select geometry: Line 2' })
    ).toBeDisabled();
    expect(
      screen.getByRole('button', {
        name: 'Delete constraint: Distance · Line 1 ↔ Line 2'
      })
    ).toBeDisabled();
    rerender(<SketchToolRail {...props} constraints={[]} solveStatus={null} />);
    expect(
      screen.queryByRole('button', { name: 'Select geometry: Line 2' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Constraint feedback' })
    ).not.toBeInTheDocument();
  });

  it('explains unavailable geometry instead of offering a stale target', async () => {
    const user = userEvent.setup();
    renderRail({
      paletteOpen: true,
      constraints: [
        {
          constraintId: 'scon_gone',
          label: 'Radius · Deleted circle',
          editable: true,
          targets: []
        }
      ]
    });
    await user.click(
      screen.getByRole('button', {
        name: 'Show geometry for constraint: Radius · Deleted circle'
      })
    );
    expect(
      screen.getByText('The referenced geometry is no longer available.')
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /^Select geometry:/ })
    ).not.toBeInTheDocument();
  });

  it('preserves extrusion readiness and solving guards with tooltips', async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderRail({ canExtrude: false });
    const extrude = screen.getByRole('button', { name: /Extrude/ });
    expect(extrude).toBeDisabled();
    await user.click(extrude);
    expect(props.onExtrude).not.toHaveBeenCalled();
    rerender(<SketchToolRail {...props} canExtrude solving />);
    expect(extrude).toBeDisabled();
    rerender(<SketchToolRail {...props} canExtrude solving={false} />);
    expect(extrude).toBeEnabled();
    expect(extrude).not.toHaveAttribute('title');
    await user.click(extrude);
    expect(props.onExtrude).toHaveBeenCalledOnce();
  });

  it('shows the circle types as a strip beside the rail while the tool is live', async () => {
    const user = userEvent.setup();
    const onCircleMode = vi.fn();
    const { props, rerender } = renderRail({ onCircleMode });

    // The tool's own glyph and name are the live type.
    expect(
      screen.getByRole('button', { name: 'Circle: Center circle' })
    ).toHaveAttribute('aria-pressed', 'true');
    const strip = screen.getByRole('radiogroup', { name: 'Circle type' });
    expect(within(strip).getByRole('radio', { name: 'Center' })).toBeChecked();
    expect(
      within(strip).getByRole('radio', { name: '3 points' })
    ).not.toBeChecked();

    await user.click(within(strip).getByRole('radio', { name: '3 points' }));
    expect(onCircleMode).toHaveBeenLastCalledWith('three-point');
    rerender(<SketchToolRail {...props} circleMode="three-point" />);
    expect(
      screen.getByRole('button', { name: 'Circle: Three-point circle' })
    ).toBeInTheDocument();
    expect(
      within(strip).getByRole('radio', { name: '3 points' })
    ).toBeChecked();

    // The chip on the strip's end steps to the next type, wrapping round.
    await user.click(screen.getByRole('button', { name: 'Next circle type' }));
    expect(onCircleMode).toHaveBeenLastCalledWith('center-radius');

    // The strip belongs to the circle tool and leaves with it.
    rerender(<SketchToolRail {...props} tool="line" />);
    expect(
      screen.queryByRole('radiogroup', { name: 'Circle type' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Circle: Center circle' })
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('shares one curve slot between the ellipse and spline tools (I01)', async () => {
    const user = userEvent.setup();
    const onCurveMode = vi.fn();
    const { props, rerender } = renderRail({ tool: 'line', onCurveMode });
    // Idle, the slot shows the ellipse and opens no strip.
    const slot = screen.getByRole('button', { name: 'Curve: Ellipse' });
    expect(slot).toHaveAttribute('aria-pressed', 'false');
    expect(
      screen.queryByRole('radiogroup', { name: 'Curve type' })
    ).not.toBeInTheDocument();
    await user.click(slot);
    expect(onCurveMode).toHaveBeenLastCalledWith('ellipse');

    rerender(
      <SketchToolRail {...props} tool="spline" curveMode="control-spline" />
    );
    expect(
      screen.getByRole('button', { name: 'Curve: Control-point spline' })
    ).toHaveAttribute('aria-pressed', 'true');
    const strip = screen.getByRole('radiogroup', { name: 'Curve type' });
    expect(within(strip).getByRole('radio', { name: 'Control' })).toBeChecked();
    await user.click(within(strip).getByRole('radio', { name: 'Arc' }));
    expect(onCurveMode).toHaveBeenLastCalledWith('elliptical-arc');
    // The chip steps to the tool's other type.
    await user.click(screen.getByRole('button', { name: 'Next curve type' }));
    expect(onCurveMode).toHaveBeenLastCalledWith('fit-spline');
  });

  it('shows the rectangle types and the polygon as one shape strip, with the polygon’s sides', async () => {
    const user = userEvent.setup();
    const onRectangleMode = vi.fn();
    const onPolygonSides = vi.fn();
    const onTool = vi.fn();
    const { props, rerender } = renderRail({
      tool: 'rectangle',
      onRectangleMode,
      onPolygonSides,
      onTool
    });
    expect(screen.getByRole('button', { name: 'Rectangle' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const strip = screen.getByRole('radiogroup', { name: 'Shape type' });
    expect(
      within(strip)
        .getAllByRole('radio')
        .map((radio) => radio.textContent)
    ).toEqual(['Corner', 'Center', '3 points', 'Polygon']);
    expect(within(strip).getByRole('radio', { name: 'Corner' })).toBeChecked();

    await user.click(within(strip).getByRole('radio', { name: '3 points' }));
    expect(onRectangleMode).toHaveBeenLastCalledWith('three-point');
    await user.click(
      screen.getByRole('button', { name: 'Next rectangle type' })
    );
    expect(onRectangleMode).toHaveBeenLastCalledWith('center');
    // The polygon is its own tool sharing the slot.
    await user.click(within(strip).getByRole('radio', { name: 'Polygon' }));
    expect(onTool).toHaveBeenLastCalledWith('polygon');

    rerender(<SketchToolRail {...props} tool="polygon" polygonSides={6} />);
    expect(screen.getByRole('button', { name: 'Polygon' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(strip).getByRole('radio', { name: 'Polygon' })).toBeChecked();
    const sides = screen.getByRole('spinbutton', { name: 'Polygon sides' });
    expect(sides).toHaveValue(6);
    await user.clear(sides);
    await user.type(sides, '2');
    // A count the document refuses is never committed.
    expect(onPolygonSides).not.toHaveBeenCalled();
    await user.type(sides, '4');
    expect(onPolygonSides).toHaveBeenLastCalledWith(24);
    await user.clear(sides);
    await user.type(sides, '65');
    expect(onPolygonSides).toHaveBeenLastCalledWith(6);

    // The strip leaves with the shape tools.
    rerender(<SketchToolRail {...props} tool="line" />);
    expect(
      screen.queryByRole('radiogroup', { name: 'Shape type' })
    ).not.toBeInTheDocument();
  });

  it('keeps geometry and grid snapping independent', async () => {
    const user = userEvent.setup();
    const onSettings = vi.fn();
    renderRail({ onSettings });
    // The settings open beside the rail, closed to begin with.
    await user.click(screen.getByRole('button', { name: /Sketch palette/ }));

    // Grid snapping starts on, so the first click turns it off and leaves
    // geometry snapping alone.
    await user.click(screen.getByLabelText('Snap to grid'));
    expect(onSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapEnabled: false, geometrySnapEnabled: true })
    );

    // The rail is uncontrolled here, so the second toggle patches the
    // original settings: geometry off, grid still at its default.
    await user.click(screen.getByLabelText('Geometry snaps'));
    expect(onSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        snapEnabled: true,
        geometrySnapEnabled: false
      })
    );
  });

  it('takes a snap spacing typed over the old one, keystroke by keystroke', async () => {
    const user = userEvent.setup();
    const commits: number[] = [];
    // The palette as App drives it: every committed patch comes back in.
    function Controlled() {
      const [settings, setSettings] = useState<AppSettings['sketching']>({
        ...structuredClone(DEFAULT_APP_SETTINGS.sketching),
        linearSnap: 1
      });
      return (
        <SketchToolRail
          tool="line"
          circleMode="center-radius"
          construction={false}
          settings={settings}
          units="mm"
          paletteVisible
          canConstrain
          pendingEdit={null}
          constraints={[]}
          solveStatus={null}
          solving={false}
          onTool={vi.fn()}
          onCircleMode={vi.fn()}
          onConstruction={vi.fn()}
          onSettings={(next) => {
            commits.push(next.linearSnap);
            setSettings(next);
          }}
          onEditTool={vi.fn()}
          onEditConstraint={vi.fn()}
          onDeleteConstraint={vi.fn()}
          onSelectConstraintObject={vi.fn()}
          onSolve={vi.fn()}
          onDiagnostics={vi.fn()}
          onExtrude={vi.fn()}
        />
      );
    }
    render(<Controlled />);
    await user.click(screen.getByRole('button', { name: /Sketch palette/ }));
    const field = screen.getByLabelText('Sketch snap spacing');
    expect(field).toHaveValue(1);

    // Emptied while focused, the field stays empty and nothing is committed:
    // the old value used to be written straight back over the deletion.
    await user.clear(field);
    expect(field).toHaveDisplayValue('');
    expect(commits).toEqual([]);

    // "0.5" typed in: the "0" on the way there is out of range and is not
    // committed, and it is not replaced by the old 1 either (which made the
    // finished entry read 1.5).
    await user.type(field, '0.5');
    expect(field).toHaveValue(0.5);
    expect(commits.at(-1)).toBe(0.5);
    expect(commits).not.toContain(0);

    // An out-of-range entry stays a draft; leaving the field shows the
    // spacing still in force.
    await user.clear(field);
    await user.type(field, '0');
    expect(commits.at(-1)).toBe(0.5);
    await user.tab();
    expect(field).toHaveValue(0.5);
  });

  it('lights only the armed modify tool, not Select under it', () => {
    for (const kind of [
      'fillet',
      'chamfer',
      'offset',
      'trim',
      'mirror',
      'linear-pattern',
      'circular-pattern'
    ] as const) {
      const { unmount } = renderRail({
        // Arming a modify tool parks the machine on Select for its picks.
        tool: 'select',
        pendingEdit: { kind, picks: [] }
      });
      const rail = screen.getByRole('toolbar', { name: 'Sketch tools' });
      // A tool's own settings strip (Offset's join and Chain) is not a tool.
      const tools = (selector: string) =>
        Array.from(rail.querySelectorAll(selector)).filter(
          (button) => !button.closest('[data-rail-flyout]')
        );
      const lit = tools('button[aria-pressed="true"]').map((button) =>
        button.getAttribute('aria-label')
      );
      const label = SKETCH_EDIT_TOOL_SPECS.find(
        (spec) => spec.kind === kind
      )!.label;
      // A folded tool lights the fold's toggle while the list is closed.
      const folded = kind !== 'fillet' && kind !== 'chamfer';
      expect(lit).toEqual(folded ? [] : [label]);
      const active = tools('button.active');
      expect(active).toHaveLength(1);
      expect(active[0]!.getAttribute('aria-label')).toBe(
        folded ? 'More modify tools' : label
      );
      unmount();
    }
    // Without one, Select reads as the live tool again.
    renderRail({ tool: 'select', pendingEdit: null });
    expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('steps the circle type with the arrow keys, one tab stop for the strip', async () => {
    const user = userEvent.setup();
    const onCircleMode = vi.fn();
    const { props, rerender } = renderRail({ onCircleMode });
    const strip = screen.getByRole('radiogroup', { name: 'Circle type' });
    const radios = within(strip).getAllByRole('radio');
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);

    radios[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(onCircleMode).toHaveBeenLastCalledWith('two-point-diameter');
    expect(radios[1]).toHaveFocus();
    rerender(<SketchToolRail {...props} circleMode="two-point-diameter" />);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);

    // Back past the first wraps round to the last.
    radios[0]!.focus();
    await user.keyboard('{ArrowUp}');
    expect(onCircleMode).toHaveBeenLastCalledWith('three-point');
    expect(radios[2]).toHaveFocus();
  });

  it('names the Extrude key, which works inside a sketch too', async () => {
    const user = userEvent.setup();
    renderRail();
    await user.hover(screen.getByRole('button', { name: 'Extrude' }));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.querySelector('kbd')).toHaveTextContent(/^E$/);
  });

  it('keeps the relations off the card: they have their own rail', () => {
    renderRail();
    expect(
      screen.queryByRole('button', { name: 'Parallel' })
    ).not.toBeInTheDocument();
  });

  it('disables solving until the sketch node exists', () => {
    renderRail({ canConstrain: false });
    expect(screen.getByRole('button', { name: 'Solve' })).toBeDisabled();
  });

  it('solves on demand and shows the status pill', async () => {
    const user = userEvent.setup();
    const onSolve = vi.fn();
    renderRail({
      onSolve,
      constraints: [
        {
          constraintId: 'scon_1',
          label: 'Horizontal · Line',
          editable: false
        }
      ],
      solveStatus: { label: '2 DOF remaining', tone: 'info' }
    });

    expect(screen.getByRole('status')).toHaveTextContent('2 DOF remaining');
    await user.click(screen.getByRole('button', { name: 'Solve' }));
    expect(onSolve).toHaveBeenCalledOnce();
  });

  it('lists constraints in the palette with per-row delete', async () => {
    const user = userEvent.setup();
    const onDeleteConstraint = vi.fn();
    renderRail({
      onDeleteConstraint,
      constraints: [
        {
          constraintId: 'scon_1',
          label: 'Horizontal · Line 1',
          editable: false
        },
        {
          constraintId: 'scon_2',
          label: 'Parallel · Line 1 ∥ Line 2',
          editable: false
        }
      ]
    });
    await user.click(screen.getByRole('button', { name: /Sketch palette/ }));

    await user.click(
      screen.getByRole('button', {
        name: 'Delete constraint: Parallel · Line 1 ∥ Line 2'
      })
    );
    expect(onDeleteConstraint).toHaveBeenCalledWith('scon_2');
  });

  it('reopens a driving dimension from the constraint list', async () => {
    const user = userEvent.setup();
    const onEditConstraint =
      vi.fn<(constraintId: string, anchor: { x: number; y: number }) => void>();
    renderRail({
      onEditConstraint,
      constraints: [
        {
          constraintId: 'scon_angle',
          label: 'Angle 45° · Line 1 ∠ Line 2',
          editable: true
        }
      ]
    });
    await user.click(screen.getByRole('button', { name: /Sketch palette/ }));

    await user.click(
      screen.getByRole('button', {
        name: 'Edit constraint: Angle 45° · Line 1 ∠ Line 2'
      })
    );
    expect(onEditConstraint).toHaveBeenCalledOnce();
    const [constraintId, anchor] = onEditConstraint.mock.calls[0]!;
    expect(constraintId).toBe('scon_angle');
    expect(Number.isFinite(anchor.x)).toBe(true);
    expect(Number.isFinite(anchor.y)).toBe(true);
  });

  it('is one icon column with the palette closed beside it', async () => {
    const user = userEvent.setup();
    const { container } = renderRail({ sketchName: 'Boss profile' });
    const rail = screen.getByRole('toolbar', { name: 'Sketch tools' });
    expect(rail.querySelector('.sketch-rail-group.draw')).not.toBeNull();
    expect(rail.querySelector('.sketch-rail-group.modify')).not.toBeNull();
    // Every tool is still there, by name; the rail draws icons alone and
    // the names ride the tooltips.
    const line = screen.getByRole('button', { name: /^Line/ });
    expect(line).toHaveTextContent('');
    expect(line.querySelector('svg')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Circle: Center circle' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Solve' })).toBeInTheDocument();
    // No group headings, no words: dividers separate the groups.
    expect(rail.querySelector('.sketch-rail-group-label')).toBeNull();
    expect(rail.querySelectorAll('.sketch-rail-divider')).toHaveLength(3);
    // Finish belongs to the column's foot, not the rail.
    expect(
      screen.queryByRole('button', { name: 'Finish Sketch' })
    ).not.toBeInTheDocument();
    // The palette starts closed and opens beside the rail, headed by the
    // sketch's name, with the settings inside.
    expect(container.querySelector('.sketch-palette')).toBeNull();
    expect(screen.queryByLabelText('Snap to grid')).not.toBeInTheDocument();
    const palette = screen.getByRole('button', { name: 'Sketch palette' });
    expect(palette).toHaveAttribute('aria-expanded', 'false');
    await user.click(palette);
    expect(
      container.querySelector('.sketch-flyouts .sketch-palette')
    ).not.toBeNull();
    expect(screen.getByLabelText('Snap to grid')).toBeInTheDocument();
    expect(container.querySelector('.sketch-palette-header')).toHaveTextContent(
      'Boss profile'
    );
    await user.click(palette);
    expect(container.querySelector('.sketch-palette')).toBeNull();
  });

  it('shows the solve status as the Solve button’s tone', () => {
    renderRail({
      constraints: [
        { constraintId: 'scon_1', label: 'Horizontal · Line', editable: false }
      ],
      solveStatus: { label: 'Fully constrained', tone: 'ok' }
    });
    expect(screen.getByRole('button', { name: 'Solve' })).toHaveAttribute(
      'data-tone',
      'ok'
    );
    expect(screen.getByRole('status')).toHaveTextContent('Fully constrained');
  });

  it('arms and disarms a modify tool, and disables the group until there is geometry', async () => {
    const user = userEvent.setup();
    const onEditTool = vi.fn();
    const { props, rerender } = renderRail({ onEditTool, canConstrain: false });
    const fillet = screen.getByRole('button', { name: /^Fillet$/ });
    expect(fillet).toBeDisabled();

    rerender(<SketchToolRail {...props} canConstrain />);
    await user.click(screen.getByRole('button', { name: /^Fillet$/ }));
    // The hint travels with the tool so App does not have to look it up.
    expect(onEditTool).toHaveBeenCalledWith(
      'fillet',
      'Click two lines that meet, then enter the radius.'
    );

    rerender(
      <SketchToolRail
        {...props}
        canConstrain
        pendingEdit={{ kind: 'fillet', picks: [] }}
      />
    );
    const armed = screen.getByRole('button', { name: /^Fillet$/ });
    expect(armed).toHaveAttribute('aria-pressed', 'true');
    await user.click(armed);
    expect(onEditTool).toHaveBeenLastCalledWith(null);

    expect(screen.getByRole('button', { name: /^Chamfer$/ })).toBeEnabled();
  });

  it('folds offset, trim, mirror and the patterns into one rail slot', async () => {
    const user = userEvent.setup();
    const onEditTool = vi.fn();
    renderRail({ onEditTool, canConstrain: true });
    const rail = screen.getByRole('toolbar', { name: 'Sketch tools' });
    expect(within(rail).queryByRole('button', { name: 'Trim' })).toBeNull();
    const toggle = within(rail).getByRole('button', {
      name: 'More modify tools'
    });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const group = within(rail).getByRole('group', {
      name: 'More modify tools'
    });
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual([
      'Offset',
      'Trim',
      'Mirror',
      'Linear pattern',
      'Circular pattern'
    ]);
    await user.click(within(group).getByRole('button', { name: 'Mirror' }));
    expect(onEditTool).toHaveBeenLastCalledWith(
      'mirror',
      'Click a line, arc or circle, then the line to mirror it about.'
    );
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Escape closes the list from inside without reaching the canvas.
    await user.click(toggle);
    await user.keyboard('{Escape}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it("rides Offset's corner join and Chain beside its slot while it is armed", async () => {
    const user = userEvent.setup();
    const onOffsetOptions = vi.fn();
    const { props, rerender } = renderRail({
      canConstrain: true,
      pendingEdit: { kind: 'offset', picks: [] },
      onOffsetOptions
    });
    const strip = screen.getByRole('group', { name: 'Offset options' });
    const joins = within(strip).getByRole('radiogroup', {
      name: 'Offset corners'
    });
    // Miter and a chain are the default.
    expect(
      within(joins)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('aria-checked'))
    ).toEqual(['true', 'false']);
    await user.click(within(joins).getByRole('radio', { name: 'Round' }));
    expect(onOffsetOptions).toHaveBeenLastCalledWith({
      join: 'round',
      chain: true
    });
    rerender(
      <SketchToolRail
        {...props}
        offsetOptions={{ join: 'round', chain: true }}
      />
    );
    const chain = within(strip).getByRole('button', { name: 'Chain' });
    expect(chain).toHaveAttribute('aria-pressed', 'true');
    await user.click(chain);
    expect(onOffsetOptions).toHaveBeenLastCalledWith({
      join: 'round',
      chain: false
    });
    // The strip leaves with the tool.
    rerender(<SketchToolRail {...props} pendingEdit={null} />);
    expect(screen.queryByRole('group', { name: 'Offset options' })).toBeNull();
  });

  it('marks solver-named constraints as actionable conflicts', async () => {
    const user = userEvent.setup();
    renderRail({
      constraints: [
        {
          constraintId: 'scon_1',
          label: 'Distance · Line 1',
          editable: true,
          conflicted: true
        },
        { constraintId: 'scon_2', label: 'Vertical · Line 2', editable: false }
      ]
    });
    await user.click(screen.getByRole('button', { name: /Sketch palette/ }));
    const conflictingRow = screen
      .getByRole('button', { name: 'Edit constraint: Distance · Line 1' })
      .closest('li');
    expect(conflictingRow).toHaveAttribute('data-conflicted', 'true');
    expect(conflictingRow).toHaveAttribute(
      'aria-label',
      'Distance · Line 1 · solver residual; edit or delete this constraint'
    );
    expect(
      screen.getByRole('button', { name: 'Edit constraint: Distance · Line 1' })
    ).toHaveAttribute('data-conflicted', 'true');
    expect(
      screen.getByText('Vertical · Line 2').closest('li')
    ).not.toHaveAttribute('data-conflicted');
  });

  it('marks every row defined exactly when the pill says Fully constrained', async () => {
    const user = userEvent.setup();
    renderRail({
      constraints: [
        {
          constraintId: 'scon_1',
          label: 'Horizontal · Line 1',
          editable: false,
          defined: true
        },
        {
          constraintId: 'scon_2',
          label: 'Distance 10 · Line 1 ↔ Line 2',
          editable: true,
          defined: true
        }
      ],
      solveStatus: {
        label: 'Fully constrained',
        tone: 'ok',
        definedState: 'fully-defined',
        definedObjectIds: ['ent_1', 'ent_2'],
        conflictingConstraintIds: []
      }
    });
    // The pill text stays the authoritative signal; the rows only repeat it
    // in words as well as colour.
    expect(screen.getByRole('status')).toHaveTextContent('Fully constrained');
    await user.click(screen.getByRole('button', { name: /Sketch palette/ }));
    for (const label of [
      'Horizontal · Line 1',
      'Distance 10 · Line 1 ↔ Line 2'
    ]) {
      const row = screen.getByText(label).closest('li');
      expect(row).toHaveAttribute('data-defined', 'true');
      expect(row).toHaveAttribute('aria-label', `${label} · fully defined`);
      expect(row).not.toHaveAttribute('data-conflicted');
    }
  });

  it('leaves rows unmarked while the sketch still has freedom', async () => {
    const user = userEvent.setup();
    renderRail({
      constraints: [
        {
          constraintId: 'scon_1',
          label: 'Horizontal · Line 1',
          editable: false
        }
      ],
      solveStatus: {
        label: '2 DOF remaining',
        tone: 'info',
        definedState: 'under-defined',
        definedObjectIds: [],
        conflictingConstraintIds: []
      }
    });
    expect(screen.getByRole('status')).toHaveTextContent('2 DOF remaining');
    await user.click(screen.getByRole('button', { name: /Sketch palette/ }));
    const row = screen.getByText('Horizontal · Line 1').closest('li');
    expect(row).not.toHaveAttribute('data-defined');
    expect(row).toHaveAttribute('aria-label', 'Horizontal · Line 1');
  });
});

describe('SketchRelationsRail', () => {
  it('keeps every relation in spec order, icon-only while nothing is picked', () => {
    const { container } = renderRelations();
    const rail = screen.getByRole('toolbar', { name: 'Relations' });
    const names = Array.from(rail.querySelectorAll('button')).map((button) =>
      button.getAttribute('aria-label')
    );
    // The point relations fold into one slot, last in the column.
    const points = ['Symmetric', 'Point on curve', 'Lock', 'Disconnect'];
    expect(names).toEqual([
      ...CONSTRAINT_TOOL_SPECS.map(({ label }) => label).filter(
        (label) => !points.includes(label)
      ),
      'Point relations'
    ]);
    for (const name of names) {
      expect(screen.getByRole('button', { name: name! })).toBeEnabled();
    }
    expect(container.querySelector('.sketch-relation-name')).toBeNull();
  });

  it('opens the point relations in a flyout and arms one from it', async () => {
    const user = userEvent.setup();
    const onConstraintTool = vi.fn();
    const { rerender, props } = renderRelations({ onConstraintTool });
    const group = screen.getByRole('button', { name: 'Point relations' });
    expect(group).toHaveAttribute('aria-expanded', 'false');
    await user.click(group);
    const flyout = within(
      screen.getByRole('group', { name: 'Point relations' })
    );
    expect(
      flyout.getAllByRole('button').map((b) => b.getAttribute('aria-label'))
    ).toEqual(['Symmetric', 'Point on curve', 'Lock', 'Disconnect']);
    await user.click(flyout.getByRole('button', { name: 'Lock' }));
    expect(onConstraintTool).toHaveBeenLastCalledWith('lock');
    // Arming closes the flyout; the slot reads armed while a point
    // relation collects its picks.
    expect(group).toHaveAttribute('aria-expanded', 'false');
    rerender(
      <SketchRelationsRail
        {...props}
        pendingConstraint={{ kind: 'lock', picks: [] }}
      />
    );
    expect(screen.getByRole('button', { name: 'Point relations' })).toHaveClass(
      'active'
    );
    // Escape inside the flyout closes it.
    await user.click(screen.getByRole('button', { name: 'Point relations' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Point relations' })).toBeNull();
  });

  it('arms a relation and disarms it on a second click', async () => {
    const user = userEvent.setup();
    const onConstraintTool = vi.fn();
    const { rerender, props } = renderRelations({ onConstraintTool });

    await user.click(screen.getByRole('button', { name: 'Parallel' }));
    expect(onConstraintTool).toHaveBeenLastCalledWith('parallel');

    rerender(
      <SketchRelationsRail
        {...props}
        pendingConstraint={{ kind: 'parallel', picks: [] }}
      />
    );
    const armed = screen.getByRole('button', { name: 'Parallel' });
    expect(armed).toHaveAttribute('aria-pressed', 'true');
    // The armed relation is named beside its icon.
    expect(armed.querySelector('.sketch-relation-name')).toHaveTextContent(
      'Parallel'
    );
    await user.click(armed);
    expect(onConstraintTool).toHaveBeenLastCalledWith(null);
  });

  it('names what fits the selection, starts from it, and greys the rest with a reason', async () => {
    const user = userEvent.setup();
    const onSelectionConstraintTool = vi.fn();
    const onConstraintTool = vi.fn();
    renderRelations({
      selection: { kind: 'circle', fitting: ['equal', 'tangent', 'radius'] },
      onSelectionConstraintTool,
      onConstraintTool
    });

    const radius = screen.getByRole('button', { name: 'Radius' });
    expect(radius).toBeEnabled();
    expect(radius.querySelector('.sketch-relation-name')).toHaveTextContent(
      'Radius'
    );
    await user.click(radius);
    expect(onSelectionConstraintTool).toHaveBeenCalledWith('radius');
    expect(onConstraintTool).not.toHaveBeenCalled();

    const horizontal = screen.getByRole('button', { name: 'Horizontal' });
    expect(horizontal).toBeDisabled();
    expect(horizontal).toHaveAccessibleDescription(
      'Does not apply to a circle.'
    );
    expect(horizontal.querySelector('.sketch-relation-name')).toBeNull();
  });

  it('says "an arc", not "a arc", in the refusal', () => {
    renderRelations({ selection: { kind: 'arc', fitting: ['radius'] } });
    expect(
      screen.getByRole('button', { name: 'Horizontal' })
    ).toHaveAccessibleDescription('Does not apply to an arc.');
  });

  it('greys every relation until there is geometry, and says so', () => {
    renderRelations({ canConstrain: false });
    const horizontal = screen.getByRole('button', { name: 'Horizontal' });
    expect(horizontal).toBeDisabled();
    expect(horizontal).toHaveAccessibleDescription('Draw an entity first.');
  });
});
