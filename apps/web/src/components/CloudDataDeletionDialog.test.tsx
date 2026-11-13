import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountDeletionPreview } from '@openzcad/shared';
import { api } from '../lib/api';
import { CloudDataDeletionDialog } from './CloudDataDeletionDialog';

const preview: AccountDeletionPreview = {
  confirmationKind: 'phrase',
  confirmationText: 'DELETE PROJECTS',
  projectCount: 2,
  documentBytes: 1_024,
  revisionBytes: 2_048,
  revisionCount: 5,
  collaboratorCount: 0
};

describe('CloudDataDeletionDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The field mounts with the preview, after opening had already focused
   * Cancel, so the `initialFocusRef` the dialog asks for never applied.
   */
  it('focuses the confirmation field once the preview arrives', async () => {
    let arrive!: (value: AccountDeletionPreview) => void;
    vi.spyOn(api, 'accountDeletionPreview').mockReturnValue(
      new Promise((resolve) => {
        arrive = resolve;
      })
    );
    render(
      <CloudDataDeletionDialog
        scope="projects"
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await act(async () => arrive(preview));

    expect(screen.getByLabelText('Deletion confirmation')).toHaveFocus();
    expect(
      screen.getByText(/at least 3 KiB of document and revision data/)
    ).toBeVisible();
  });

  // Design review I84: nothing said what deleting the profile does to
  // encryption keys.
  it.each([
    ['profile', true],
    ['all', true],
    ['projects', false]
  ] as const)(
    'for %s, says whether the encryption keys go too',
    async (scope, shown) => {
      vi.spyOn(api, 'accountDeletionPreview').mockResolvedValue(preview);
      render(
        <CloudDataDeletionDialog
          scope={scope}
          onConfirm={vi.fn()}
          onClose={vi.fn()}
        />
      );
      await screen.findByLabelText('Deletion confirmation');
      const sentence = screen.queryByText(
        /Your recovery key will no longer unlock anything\./
      );
      if (shown) expect(sentence).toBeVisible();
      else expect(sentence).toBeNull();
    }
  );

  it('keeps focus on the delete button while it runs and after it fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'accountDeletionPreview').mockResolvedValue(preview);
    let fail!: (error: Error) => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        })
    );
    const onClose = vi.fn();
    render(
      <CloudDataDeletionDialog
        scope="projects"
        onConfirm={onConfirm}
        onClose={onClose}
      />
    );
    await user.type(
      await screen.findByLabelText('Deletion confirmation'),
      'DELETE PROJECTS'
    );
    const confirm = screen.getByRole('button', {
      name: 'Delete cloud projects'
    });
    await user.click(confirm);

    const deleting = screen.getByRole('button', { name: 'Deleting…' });
    expect(deleting).toBe(confirm);
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(confirm).toHaveFocus();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => fail(new Error('Deletion failed upstream.')));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Deletion failed upstream.'
    );
    expect(confirm).not.toHaveAttribute('aria-disabled');
    expect(confirm).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('describes a masked email instead of styling it as text to type', async () => {
    vi.spyOn(api, 'accountDeletionPreview').mockResolvedValue({
      ...preview,
      confirmationKind: 'email',
      confirmationText: 'person@example.com'
    });
    render(
      <CloudDataDeletionDialog
        scope="profile"
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const prompt = await screen.findByText(
      'Type your email address to confirm'
    );
    expect(prompt.querySelector('strong')).toBeNull();
    expect(document.body.innerHTML).not.toContain('person@example.com');
  });
});
