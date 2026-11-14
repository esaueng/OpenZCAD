import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { patternProgressSlot } from './PatternProgressSlot';

// An older deployment's chunk is gone: the lazy import rejects as the
// browser's does.
const PatternProgressSlot = patternProgressSlot(() =>
  Promise.reject(
    new Error(
      'Failed to fetch dynamically imported module: https://zcad.example/gone.js'
    )
  )
);

afterEach(() => vi.restoreAllMocks());

it('keeps the workspace and a working Cancel when the pill chunk fails to load', async () => {
  // Review of #1501: the failure reached the page boundary and replaced the
  // whole workspace while the pattern was still rebuilding.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const cancel = vi.fn();
  render(
    <ErrorBoundary label="Workspace" scope="page">
      <p>Workspace</p>
      <PatternProgressSlot name="Grid pattern" onCancel={cancel} />
    </ErrorBoundary>
  );
  await vi.waitFor(() =>
    expect(console.error).toHaveBeenCalledWith(
      'Pattern progress crashed:',
      expect.anything(),
      expect.anything()
    )
  );
  expect(screen.getByText('Workspace')).toBeInTheDocument();
  expect(screen.queryByRole('heading')).toBeNull();
  expect(
    screen.getByRole('region', { name: 'Pattern rebuild' })
  ).toHaveTextContent('Rebuilding Grid pattern.');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel pattern' }));
  expect(cancel).toHaveBeenCalledOnce();
});

it('keeps Cancel on screen while a crashed pill remounts', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const Crashing = patternProgressSlot(() =>
    Promise.resolve({
      PatternProgress: () => {
        throw new Error('render failed');
      }
    })
  );
  const cancel = vi.fn();
  render(<Crashing name="Grid pattern" onCancel={cancel} />);
  await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
  // The boundary remounts once on its own; Cancel stays throughout.
  fireEvent.click(screen.getByRole('button', { name: 'Cancel pattern' }));
  expect(cancel).toHaveBeenCalledOnce();
});
