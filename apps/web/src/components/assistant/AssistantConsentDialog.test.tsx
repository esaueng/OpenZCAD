import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AssistantConsentDialog } from './AssistantConsentDialog';

describe('AssistantConsentDialog', () => {
  it('cannot be declined while the allow is being stored', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const onAllow = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const onCancel = vi.fn();
    render(
      <AssistantConsentDialog
        routeLabel="OpenZCAD’s AI provider"
        onAllow={onAllow}
        onCancel={onCancel}
      />
    );
    await user.click(
      screen.getByRole('button', { name: 'Allow for this project' })
    );
    const notNow = screen.getByRole('button', { name: 'Not now' });
    expect(notNow.getAttribute('aria-disabled')).toBe('true');
    await user.click(notNow);
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();

    // Once the store settles (here, as a failure the panel reports), the
    // user can decline again.
    release();
    await vi.waitFor(() =>
      expect(notNow.getAttribute('aria-disabled')).toBeNull()
    );
    await user.click(notNow);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
