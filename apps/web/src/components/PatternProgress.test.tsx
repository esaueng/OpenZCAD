import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PatternProgress } from './PatternProgress';

it('explains exact work and exposes an actionable cancel without claiming a percentage', () => {
  const cancel = vi.fn();
  render(<PatternProgress name="Circular pattern" onCancel={cancel} />);
  expect(
    screen.getByRole('region', { name: 'Pattern rebuild' })
  ).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('status')).toHaveTextContent(
    'Overlapping copies need exact merging'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Cancel pattern' }));
  expect(cancel).toHaveBeenCalledOnce();
});
