import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SharePage, type SharePageState } from './SharePage';

function failed(retryable: boolean): SharePageState {
  return {
    phase: 'error',
    title: 'This share link is unavailable',
    message: 'It may have expired or been revoked.',
    guidance: 'Ask the owner for a new link.',
    retryable
  };
}

describe('SharePage', () => {
  it('leads with Back to projects when the link cannot open on retry', () => {
    render(
      <SharePage state={failed(false)} onRetry={vi.fn()} onBack={vi.fn()} />
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Back to projects' }).className
    ).toBe('primary');
  });

  it('leads with Try again after a transient failure', () => {
    render(
      <SharePage state={failed(true)} onRetry={vi.fn()} onBack={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: 'Try again' }).className).toBe(
      'primary'
    );
    expect(
      screen.getByRole('button', { name: 'Back to projects' }).className
    ).toBe('secondary');
  });
});
