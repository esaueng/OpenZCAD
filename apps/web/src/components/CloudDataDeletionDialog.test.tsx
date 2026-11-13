import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountDeletionPreview } from '@openzcad/shared';
import { api, ApiError } from '../lib/api';
import {
  CloudDataDeletionDialog,
  deletionFailureMessage
} from './CloudDataDeletionDialog';

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

  // Design review I78: the masked email field hid typos, and a mismatch only
  // left the button disabled.
  it('unmasks the email while typing and says when it does not match', async () => {
    const user = userEvent.setup();
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
    const field = await screen.findByLabelText('Deletion confirmation');
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute('type', 'text');
    // A prefix of the address is not yet a mismatch.
    await user.type(field, 'person@');
    expect(screen.queryByText(/doesn’t match/)).toBeNull();
    await user.type(field, 'exmaple.com');
    expect(
      screen.getByText('That doesn’t match your account’s email address.')
    ).toBeVisible();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await user.tab();
    expect(field).toHaveAttribute('type', 'password');
    expect(
      screen.getByText('That doesn’t match your account’s email address.')
    ).toBeVisible();
  });

  // Design review I84.
  it('offers to download the data first', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'accountDeletionPreview').mockResolvedValue(preview);
    const onDownloadFirst = vi.fn();
    render(
      <CloudDataDeletionDialog
        scope="projects"
        onConfirm={vi.fn()}
        onClose={vi.fn()}
        onDownloadFirst={onDownloadFirst}
      />
    );
    await user.click(
      await screen.findByRole('button', { name: 'Download your data first' })
    );
    expect(onDownloadFirst).toHaveBeenCalledOnce();
  });

  it('says a server failure may have stopped partway, and a refusal did nothing', () => {
    expect(
      deletionFailureMessage(new ApiError(500, 'Internal error.'))
    ).toMatch(
      /Internal error\. Deletion may have stopped partway.*Nothing on this device was deleted\. Try again to finish\./
    );
    expect(
      deletionFailureMessage(
        new ApiError(400, 'Type your email address exactly to continue.')
      )
    ).toBe('Type your email address exactly to continue.');
  });
});
