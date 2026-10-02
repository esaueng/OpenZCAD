import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Throws({ error }: { error: Error }): never {
  throw error;
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderFailing(error: Error, scope?: 'panel' | 'page') {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return render(
      <ErrorBoundary label="OpenZCAD workspace" scope={scope}>
        <Throws error={error} />
      </ErrorBoundary>
    );
  }

  it('names a stale chunk at page scope as an update, not a crash', () => {
    renderFailing(
      new TypeError('Failed to fetch dynamically imported module: /a.js'),
      'page'
    );
    expect(
      screen.getByRole('heading', { name: 'OpenZCAD has been updated' })
    ).toBeTruthy();
    expect(screen.queryByText(/could not be rendered/)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Reload to update' })
    ).toBeTruthy();
    expect(screen.queryByText('Error details')).toBeNull();
  });

  it('keeps the crash title at page scope and offers the error detail', () => {
    renderFailing(new Error('boom'), 'page');
    expect(
      screen.getByRole('heading', {
        name: 'OpenZCAD workspace could not be rendered.'
      })
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Reload workspace' })
    ).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
  });

  it('stays an inline panel fallback by default', () => {
    const { container } = renderFailing(new Error('boom'));
    expect(container.querySelector('.error-boundary')).not.toBeNull();
    expect(container.querySelector('.error-page')).toBeNull();
  });
});
