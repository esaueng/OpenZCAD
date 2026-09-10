import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import { SketchWorkflow } from './SketchWorkflow';

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
      tool="select"
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
  const snap = screen.getByRole('button', { name: 'Geometry snaps on' });
  expect(snap).toHaveAttribute('aria-pressed', 'true');
  await user.click(snap);
  expect(geometrySnaps).toHaveBeenCalledOnce();
});
