import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { expect, it, vi } from 'vitest';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import { SketchWorkflow } from './SketchWorkflow';

const SELECT_TOOL: ComponentProps<typeof SketchWorkflow>['tool'] = {
  tool: 'select',
  circleMode: 'center-radius',
  pendingConstraint: null,
  pendingEdit: null
};

function renderWorkflow(
  overrides: Partial<ComponentProps<typeof SketchWorkflow>> = {}
) {
  return render(
    <SketchWorkflow
      plane="XY plane"
      tool={SELECT_TOOL}
      objects={[]}
      selectedId={null}
      analysis={null}
      analysisError={null}
      geometrySnaps
      gridSnaps={false}
      busy={false}
      error={null}
      onSelect={vi.fn()}
      onGeometrySnaps={vi.fn()}
      onGridSnaps={vi.fn()}
      onDiagnose={vi.fn()}
      {...overrides}
    />
  );
}

it('keeps a usable closed profile visible alongside an open boundary and routes its issue to geometry', async () => {
  const objects = [
    {
      id: 'closed',
      data: { objectKind: 'circle' as const, centerX: 0, centerY: 0, radius: 5 }
    },
    {
      id: 'open',
      data: { objectKind: 'line' as const, x1: 20, y1: 0, x2: 25, y2: 0 }
    }
  ];
  const select = vi.fn();
  const diagnose = vi.fn();
  const geometrySnaps = vi.fn();
  render(
    <SketchWorkflow
      plane="XY plane"
      tool={SELECT_TOOL}
      objects={objects.map(({ id }) => ({ id, label: id }))}
      selectedId={null}
      analysis={computeSketchProfileAnalysis(objects, Number)}
      analysisError={null}
      geometrySnaps
      gridSnaps={false}
      busy={false}
      error={null}
      onSelect={select}
      onGeometrySnaps={geometrySnaps}
      onGridSnaps={vi.fn()}
      onDiagnose={diagnose}
    />
  );
  expect(screen.getByRole('status')).toHaveTextContent(
    '1 closed profile ready to extrude'
  );
  const user = userEvent.setup();
  await user.click(screen.getByText(/profile issues/));
  await user.click(screen.getByRole('button', { name: 'Highlight gaps' }));
  expect(diagnose).toHaveBeenCalledOnce();
  await user.selectOptions(screen.getByLabelText('Selected geometry'), 'open');
  expect(select).toHaveBeenCalledWith('open');
  const snap = screen.getByRole('button', { name: 'Geometry snaps' });
  expect(snap).toHaveAttribute('aria-pressed', 'true');
  await user.click(snap);
  expect(geometrySnaps).toHaveBeenCalledOnce();
  // "Highlight gaps" is a button that looks like one.
  expect(screen.getByRole('button', { name: 'Highlight gaps' })).toHaveClass(
    'secondary'
  );
});

it('keeps each snap toggle’s name and says on or off by pressing it', () => {
  const { rerender } = renderWorkflow({
    geometrySnaps: false,
    gridSnaps: true
  });
  expect(
    screen.getByRole('button', { name: 'Geometry snaps' })
  ).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'Grid snaps' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  rerender(
    <SketchWorkflow
      plane="XY plane"
      tool={SELECT_TOOL}
      objects={[]}
      selectedId={null}
      analysis={null}
      analysisError={null}
      geometrySnaps
      gridSnaps={false}
      busy={false}
      error={null}
      onSelect={vi.fn()}
      onGeometrySnaps={vi.fn()}
      onGridSnaps={vi.fn()}
      onDiagnose={vi.fn()}
    />
  );
  expect(
    screen.getByRole('button', { name: 'Geometry snaps' })
  ).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Grid snaps' })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
});

it('names the live tool as the rails do, armed tools first', () => {
  const readout = (tool: ComponentProps<typeof SketchWorkflow>['tool']) => {
    const { container, unmount } = renderWorkflow({ tool });
    const text = container.querySelector(
      '.sketch-workflow-context span'
    )?.textContent;
    unmount();
    return text;
  };
  expect(readout(SELECT_TOOL)).toBe('Select');
  expect(readout({ ...SELECT_TOOL, tool: 'line' })).toBe('Line');
  // The circle by its type, as its tooltip names it.
  expect(
    readout({
      ...SELECT_TOOL,
      tool: 'circle',
      circleMode: 'two-point-diameter'
    })
  ).toBe('Diameter Circle');
  // An armed relation with its picks so far, in sentence case.
  expect(
    readout({
      ...SELECT_TOOL,
      pendingConstraint: { kind: 'horizontal', picks: [] }
    })
  ).toBe('Horizontal: 0/1 selected');
  // An armed modify tool rather than the Select it picks through.
  expect(
    readout({
      ...SELECT_TOOL,
      pendingEdit: { kind: 'fillet', picks: ['ent_1'] }
    })
  ).toBe('Fillet: 1/2 selected');
});

it('says the Shift hint once, in the palette footer, not here too', () => {
  renderWorkflow();
  expect(screen.queryByText(/Shift/)).toBeNull();
});
