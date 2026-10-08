import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@openzcad/shared';
import { CONSTRAINT_TOOL_SPECS } from '../lib/sketch/constraints';
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
    for (const kind of ['fillet', 'chamfer', 'offset'] as const) {
      const { unmount } = renderRail({
        // Arming a modify tool parks the machine on Select for its picks.
        tool: 'select',
        pendingEdit: { kind, picks: [] }
      });
      const rail = screen.getByRole('toolbar', { name: 'Sketch tools' });
      const lit = Array.from(
        rail.querySelectorAll('button[aria-pressed="true"]')
      ).map((button) => button.getAttribute('aria-label'));
      const label = kind[0]!.toUpperCase() + kind.slice(1);
      expect(lit).toEqual([label]);
      expect(rail.querySelectorAll('button.active')).toHaveLength(1);
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

    for (const label of ['Chamfer', 'Offset']) {
      expect(
        screen.getByRole('button', { name: new RegExp(`^${label}$`) })
      ).toBeEnabled();
    }
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
    expect(names).toEqual(CONSTRAINT_TOOL_SPECS.map(({ label }) => label));
    for (const name of names) {
      expect(screen.getByRole('button', { name: name! })).toBeEnabled();
    }
    expect(container.querySelector('.sketch-relation-name')).toBeNull();
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
