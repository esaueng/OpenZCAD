import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { ConflictSource, ProjectConflict } from '../lib/conflictRecovery';
import { STALE_CHUNK_MESSAGE } from '../lib/staleChunk';
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

function setModified(document: ProjectDocument, value: string) {
  document.derived.updatedAt = value;
  document.revisions.at(-1)!.createdAt = value;
}

describe('ProjectConflictDialog', () => {
  it.each([
    new TypeError(
      'Failed to fetch dynamically imported module: /assets/keepLocalRoomVersion-old.js'
    ),
    new TypeError('Importing a module script failed.')
  ])(
    'keeps conflict work available with reload guidance after %s',
    async (failure) => {
      const user = userEvent.setup();
      const value = conflict('room');
      const original = structuredClone(value);
      const onResolve = vi.fn().mockRejectedValue(failure);
      const onClose = vi.fn();
      render(
        <ProjectConflictDialog
          conflict={value}
          busy={false}
          onResolve={onResolve}
          onClose={onClose}
        />
      );
      const keep = screen.getByRole('button', {
        name: /^This browser/
      });
      await user.click(keep);
      expect(screen.getByRole('alert')).toHaveTextContent(STALE_CHUNK_MESSAGE);
      expect(keep).toBeEnabled();
      expect(keep).not.toHaveAttribute('aria-disabled');
      expect(
        screen.getByRole('button', { name: /^Live session/ })
      ).toBeEnabled();
      expect(value).toEqual(original);
      expect(onClose).not.toHaveBeenCalled();
      expect(onResolve).toHaveBeenCalledExactlyOnceWith('keep-mine');
    }
  );

  it.each(['account', 'room'] as const)(
    'shows both modified timestamps for %s and marks the later time, not the higher version',
    (source) => {
      const value = conflict(source);
      setModified(value.localDocument, '2026-10-28T20:32:00Z');
      setModified(value.remoteDocument, '2026-10-28T20:40:00Z');
      render(
        <ProjectConflictDialog
          conflict={value}
          busy={false}
          onResolve={vi.fn()}
          onClose={vi.fn()}
        />
      );
      const local = screen.getByRole('button', { name: /^This browser/ });
      const remote = screen.getByRole('button', {
        name: source === 'account' ? /^Cloud/ : /^Live session/
      });
      expect(local.querySelector('time')).toHaveAttribute(
        'dateTime',
        '2026-10-28T20:32:00Z'
      );
      expect(remote.querySelector('time')).toHaveAttribute(
        'dateTime',
        '2026-10-28T20:40:00Z'
      );
      expect(remote).toHaveTextContent('Newer');
      expect(local).not.toHaveTextContent('Newer');
      const formatted = new Date(
        value.remoteDocument.derived.updatedAt
      ).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short'
      });
      expect(remote).toHaveTextContent(formatted);
      expect(screen.queryByText(/recovery project/)).not.toBeInTheDocument();
    }
  );

  it('marks the local row newer when its recorded modified time is later', () => {
    const value = conflict('account');
    setModified(value.localDocument, '2026-10-28T21:00:00Z');
    setModified(value.remoteDocument, '2026-10-28T20:40:00Z');
    render(
      <ProjectConflictDialog
        conflict={value}
        busy={false}
        onResolve={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(
      screen.getByRole('button', { name: /^This browser/ })
    ).toHaveTextContent('Newer');
    expect(
      screen.getByRole('button', { name: /^Cloud/ })
    ).not.toHaveTextContent('Newer');
  });

  it.each(['equal', 'invalid'] as const)(
    'never labels a version newer for %s timestamps',
    (kind) => {
      const value = conflict('account');
      setModified(
        value.remoteDocument,
        kind === 'equal' ? value.localDocument.derived.updatedAt : 'unknown'
      );
      render(
        <ProjectConflictDialog
          conflict={value}
          busy={false}
          onResolve={vi.fn()}
          onClose={vi.fn()}
        />
      );
      expect(screen.queryByText('Newer')).not.toBeInTheDocument();
      if (kind === 'invalid')
        expect(
          screen.getByRole('button', { name: /^Cloud/ })
        ).toHaveTextContent('Modified time unavailable');
    }
  );

  it('uses the latest canonical edit time even when geometry has not rebuilt', () => {
    const value = conflict('account');
    setModified(value.localDocument, '2026-10-28T20:32:00Z');
    setModified(value.remoteDocument, '2026-10-28T20:40:00Z');
    value.remoteDocument.derived.updatedAt = '2026-10-01T10:00:00Z';
    render(
      <ProjectConflictDialog
        conflict={value}
        busy={false}
        onResolve={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const cloud = screen.getByRole('button', { name: /^Cloud/ });
    expect(cloud.querySelector('time')).toHaveAttribute(
      'dateTime',
      '2026-10-28T20:40:00Z'
    );
    expect(cloud).toHaveTextContent('Newer');
  });

  it('falls back to recorded project time for legacy documents without revisions', () => {
    const value = conflict('account');
    value.localDocument.revisions = [];
    value.localDocument.derived.updatedAt = '2026-10-28T20:32:00Z';
    render(
      <ProjectConflictDialog
        conflict={value}
        busy={false}
        onResolve={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(
      screen
        .getByRole('button', { name: /^This browser/ })
        .querySelector('time')
    ).toHaveAttribute('dateTime', '2026-10-28T20:32:00Z');
  });

  it('closes on Escape once focus has fallen out of it', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ProjectConflictDialog
        conflict={conflict('account')}
        busy={false}
        onResolve={vi.fn()}
        onClose={onClose}
      />
    );
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
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
      screen.getByRole('dialog', { name: 'Choose a version to keep' })
    ).toBeInTheDocument();
    expect(
      screen.getByText('Using one version replaces the other.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Cloud stays original; yours is saved as a copy on this device.'
      )
    ).toBeInTheDocument();

    await user.click(
      screen
        .getByRole('button', { name: /^This browser/ })
        .querySelector('time')!
    );
    await user.click(screen.getByRole('button', { name: /^Cloud/ }));
    await user.click(
      screen.getByRole('button', {
        name: /^Keep both/
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
        'Live session stays original; yours is saved as a copy on this device.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Live session/ })).toBeEnabled();
    expect(
      screen.getByRole('button', {
        name: /^Keep both/
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
      name: /^This browser/
    });
    expect(keepMine).toBeDisabled();
    expect(keepMine).toHaveAccessibleDescription(
      'Keeping this device’s version requires an active edit lease.'
    );
    expect(screen.getByRole('button', { name: /^Live session/ })).toBeEnabled();
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

  it('shows pending confirmation, keeps failures visible, and allows a retry', async () => {
    const user = userEvent.setup();
    let reject!: (error: Error) => void;
    const onResolve = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, fail) => {
            reject = fail;
          })
      )
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    render(
      <ProjectConflictDialog
        conflict={conflict('room')}
        busy={false}
        onResolve={onResolve}
        onClose={onClose}
      />
    );
    const keep = screen.getByRole('button', {
      name: /^This browser/
    });
    await user.click(keep);
    // aria-disabled rather than disabled: disabling the focused choice
    // dropped focus on the body, where Escape and the error were lost.
    expect(keep).toHaveAttribute('aria-disabled', 'true');
    expect(keep).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent(
      /Waiting for confirmation/
    );
    await user.click(keep);
    expect(onResolve).toHaveBeenCalledOnce();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      reject(new Error('The room disconnected. Please retry.'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The room disconnected. Please retry.'
    );
    expect(keep).toBeEnabled();
    expect(keep).not.toHaveAttribute('aria-disabled');
    expect(keep).toHaveFocus();
    await user.click(keep);
    expect(onResolve).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
