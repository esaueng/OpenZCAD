import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkspaceReadout } from './WorkspaceReadout';

describe('WorkspaceReadout', () => {
  it('shows the live status, and the hint once it goes quiet', () => {
    render(
      <WorkspaceReadout
        status="Fillet added"
        statusAt={Date.now()}
        tone="ready"
        hint="Click a face"
        saveState="synced"
        snap={null}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Fillet added');
  });

  it('keeps only the corner facts while a tool card carries the message', () => {
    render(
      <WorkspaceReadout
        status="The resulting body wouldn't be valid."
        tone="warning"
        hint="Try another value"
        saveState="synced"
        snap={{ spacing: 1, units: 'mm', enabled: true }}
        muted
      />
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('Snap 1 mm')).toBeInTheDocument();
  });
});
