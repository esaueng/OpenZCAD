import { createRef } from 'react';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusActivityLog } from './StatusActivityLog';

// The panel's chunk is gone, as it is for a tab left open across a deploy.
vi.mock('./StatusActivityLogPanel', () => {
  throw new Error(
    'Failed to fetch dynamically imported module: /assets/StatusActivityLogPanel-old.js'
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StatusActivityLog when its panel cannot load', () => {
  it('fails inside the log and leaves the workspace standing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <main>
        <p>Workspace</p>
        <StatusActivityLog
          id="test-activity-log"
          open
          status="Added box."
          tone="ready"
          triggerRef={createRef<HTMLButtonElement>()}
          onClose={vi.fn()}
        />
      </main>
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Activity log could not be rendered.');
    expect(
      within(alert).getByRole('button', { name: 'Reload workspace' })
    ).toBeInTheDocument();
    // Nothing above the log was replaced by an error page.
    expect(screen.getByText('Workspace')).toBeInTheDocument();
  });
});
