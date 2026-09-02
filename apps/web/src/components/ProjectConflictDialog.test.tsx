import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { ConflictSource, ProjectConflict } from '../lib/conflictRecovery';
import { ProjectConflictDialog } from './ProjectConflictDialog';

const owner = toUserId('user_conflict_owner');

function conflict(source: ConflictSource): ProjectConflict {
  const base = createProjectDocument('Bracket', owner);
  return {
    projectId: base.projectId,
    source,
    localDocument: { ...structuredClone(base), version: 27 },
    remoteDocument: { ...structuredClone(base), version: 9 },
    expectedRemoteVersion: 9
  };
}

describe('ProjectConflictDialog', () => {
  it('names the account as the other side and offers all three resolutions', async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <ProjectConflictDialog
        conflict={conflict('account')}
        busy={false}
        onResolve={onResolve}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByRole('dialog', { name: 'This project changed in two places' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/version 27 on this device and version 9 in your account/)
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Keep this device’s version' })
    );
    await user.click(
      screen.getByRole('button', { name: 'Use my account’s version' })
    );
    await user.click(
      screen.getByRole('button', {
        name: 'Save mine as a copy, then use the account’s'
      })
    );
    expect(onResolve).toHaveBeenNthCalledWith(1, 'keep-mine');
    expect(onResolve).toHaveBeenNthCalledWith(2, 'use-remote');
    expect(onResolve).toHaveBeenNthCalledWith(3, 'save-local-copy');
    expect(onResolve).toHaveBeenCalledTimes(3);
  });

  // The room used to resolve inside the sharing menu with its own wording,
  // so the same project could be described as 9-vs-27 there and 27-vs-9 here.
  it('names the live session when a room raised the conflict', () => {
    render(
      <ProjectConflictDialog
        conflict={conflict('room')}
        busy={false}
        onResolve={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByText(
        /version 27 on this device and version 9 in the live session/
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Use the live version' })
    ).toBeEnabled();
    expect(
      screen.getByRole('button', {
        name: 'Save mine as a copy, then use the live version'
      })
    ).toBeEnabled();
  });

  it('withholds keep-mine with the stated reason, leaving the safe choices open', () => {
    const onResolve = vi.fn();
    render(
      <ProjectConflictDialog
        conflict={conflict('room')}
        busy={false}
        keepMineDisabledReason="Keeping this device’s version requires an active edit lease."
        onResolve={onResolve}
        onClose={vi.fn()}
      />
    );

    const keepMine = screen.getByRole('button', {
      name: 'Keep this device’s version'
    });
    expect(keepMine).toBeDisabled();
    expect(keepMine).toHaveAccessibleDescription(
      'Keeping this device’s version requires an active edit lease.'
    );
    expect(
      screen.getByRole('button', { name: 'Use the live version' })
    ).toBeEnabled();
  });

  it('lets the user decide later, by button or Escape, without resolving', async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    const onClose = vi.fn();
    render(
      <ProjectConflictDialog
        conflict={conflict('account')}
        busy={false}
        onResolve={onResolve}
        onClose={onClose}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Decide later' }));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onResolve).not.toHaveBeenCalled();
  });
});
