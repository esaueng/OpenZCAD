import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../ErrorBoundary';
import { motionStudyTimelineSlot } from './MotionStudyTimelineSlot';

// An older deployment's chunk is gone: the lazy import rejects as the
// browser's does.
const MotionStudyTimelineSlot = motionStudyTimelineSlot(() =>
  Promise.reject(
    new Error(
      'Failed to fetch dynamically imported module: https://zcad.example/gone.js'
    )
  )
);

afterEach(() => vi.restoreAllMocks());

it('keeps the viewer when the timeline chunk fails to load on entering Assemble', async () => {
  // Review of #1501: the failure reached the 3D viewer's boundary and
  // removed the viewer.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(
    <ErrorBoundary label="3D viewer">
      <canvas aria-label="Viewer" />
      <MotionStudyTimelineSlot
        floating
        assembly={undefined}
        lengthUnit="mm"
        execute={() => true}
      />
    </ErrorBoundary>
  );
  expect(
    await screen.findByText('Motion study timeline did not load.')
  ).toBeInTheDocument();
  expect(screen.getByLabelText('Viewer')).toBeInTheDocument();
  expect(screen.queryByText(/3D viewer/)).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Reload workspace' })
  ).toBeInTheDocument();
});
