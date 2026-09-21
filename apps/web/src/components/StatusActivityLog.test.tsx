import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StatusActivityLog } from './StatusActivityLog';

describe('StatusActivityLog', () => {
  it('keeps the full diagnostic with its compact status entry', () => {
    render(
      <StatusActivityLog
        id="test-activity-log"
        open
        status="Parameter height was not changed."
        detail="move-face would change topology at face 9"
        tone="warning"
        triggerRef={createRef<HTMLButtonElement>()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Parameter height was not changed.')).toBeTruthy();
    expect(
      screen.getByText('move-face would change topology at face 9')
    ).toHaveClass('status-log-detail');
  });
});
