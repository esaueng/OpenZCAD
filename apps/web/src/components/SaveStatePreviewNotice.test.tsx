import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SaveStatePreviewNotice } from './SaveStatePreviewNotice';

describe('SaveStatePreviewNotice', () => {
  it('names the saved version, its bodies, and the ways out', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    const onBranch = vi.fn();
    const onClose = vi.fn();
    render(
      <SaveStatePreviewNotice
        label="Before fillets"
        createdAt="2026-11-16T10:00:00.000Z"
        bodyCount={2}
        onRestore={onRestore}
        onBranch={onBranch}
        onClose={onClose}
      />
    );
    const region = screen.getByRole('region', { name: 'Save preview' });
    expect(region).toHaveTextContent('Previewing “Before fillets”');
    expect(region).toHaveTextContent('2 bodies · read only');
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await user.click(screen.getByRole('button', { name: 'Branch' }));
    await user.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onBranch).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers no Restore to a seat that cannot edit', () => {
    render(
      <SaveStatePreviewNotice
        label="Manual save"
        createdAt="2026-11-16T10:00:00.000Z"
        bodyCount={1}
        onBranch={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole('region')).toHaveTextContent('1 body');
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Branch' })).toBeVisible();
  });
});
