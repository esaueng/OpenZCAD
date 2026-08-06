import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { toProjectId, type ProjectSummary } from '@openzcad/shared';
import { StartScreen } from './StartScreen';

const localProject: ProjectSummary = {
  projectId: toProjectId('project_local'),
  name: 'Local bracket',
  revisionCount: 1,
  updatedAt: '2026-08-04T12:00:00.000Z'
};

function renderStartScreen(
  overrides: Partial<ComponentProps<typeof StartScreen>> = {}
) {
  return render(
    <StartScreen
      projects={[localProject]}
      status=""
      busy={false}
      demos={[]}
      defaultUnits="mm"
      onCreate={vi.fn()}
      onOpen={vi.fn()}
      onOpenDemo={vi.fn()}
      onOpenSettings={vi.fn()}
      onDuplicate={vi.fn()}
      cloudProjectIds={new Set()}
      accountProjectListReached={true}
      conflictedProjectIds={new Set()}
      signedIn={true}
      collaborationSharingEnabled={false}
      onAcceptInvitation={vi.fn().mockResolvedValue(undefined)}
      onSaveToAccount={vi.fn()}
      onSaveAllToAccount={vi.fn()}
      syncRun={null}
      onRetrySync={vi.fn()}
      onDismissSyncRun={vi.fn()}
      onMoveToShelf={vi.fn()}
      onTogglePin={vi.fn()}
      onReorder={vi.fn()}
      onDeleteForever={vi.fn()}
      onEmptyTrash={vi.fn()}
      loadThumbnailBodies={vi.fn().mockResolvedValue([])}
      {...overrides}
    />
  );
}

describe('StartScreen new part suggestion', () => {
  it('focuses the generated name without selecting its text', () => {
    renderStartScreen();

    const input = screen.getByLabelText<HTMLInputElement>('Project name');
    expect(input).toHaveFocus();
    expect(input).not.toHaveValue('New Part');
    expect(input.selectionStart).toBe(input.selectionEnd);
  });

  it('generates a new suggestion for each fresh mount', () => {
    let sample = 0;
    const getRandomValues = vi
      .spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint32Array) {
          array[0] = sample;
          sample += 1;
        }
        return array;
      });

    const first = renderStartScreen();
    const firstName =
      screen.getByLabelText<HTMLInputElement>('Project name').value;
    first.unmount();
    renderStartScreen();

    expect(screen.getByLabelText('Project name')).not.toHaveValue(firstName);
    getRandomValues.mockRestore();
  });
});

describe('StartScreen project timestamps', () => {
  it('shows the local date and time each project was last edited', () => {
    renderStartScreen();

    const editedAt = screen.getByText(/^edited /);
    const date = new Date(localProject.updatedAt);

    expect(editedAt).toHaveAttribute('datetime', localProject.updatedAt);
    expect(editedAt).toHaveTextContent(
      `edited ${date.toLocaleDateString()} at ${date.toLocaleTimeString(
        undefined,
        { hour: 'numeric', minute: '2-digit' }
      )}`
    );
  });
});

describe('StartScreen cloud project status', () => {
  it('offers a confirmed device-only project for account sync', () => {
    renderStartScreen();

    expect(screen.getByLabelText('On this device only')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save it to my account' })
    ).toBeInTheDocument();
  });

  it('does not relabel projects when the account listing failed', () => {
    renderStartScreen({ accountProjectListReached: false });

    expect(
      screen.getByText(
        'Cloud project status is temporarily unavailable. Your projects remain saved on this device.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('On this device only')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Save it to my account' })
    ).toBeNull();
  });

  it('accepts a pasted invitation only for an enabled signed-in account', async () => {
    const onAcceptInvitation = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderStartScreen({
      collaborationSharingEnabled: true,
      onAcceptInvitation
    });

    await user.type(
      screen.getByLabelText('Invitation token'),
      ' invite_token '
    );
    await user.click(screen.getByRole('button', { name: 'Join project' }));

    await waitFor(() =>
      expect(onAcceptInvitation).toHaveBeenCalledWith('invite_token')
    );
    expect(screen.getByLabelText('Invitation token')).toHaveValue('');
  });
});

describe('StartScreen collapsed project grid', () => {
  it('shows nine saved projects before moving the rest behind the expand control', () => {
    const projects = Array.from({ length: 26 }, (_, index) => ({
      projectId: toProjectId(`project_${index + 1}`),
      name: `Part ${index + 1}`,
      revisionCount: index + 1,
      updatedAt: '2026-08-04T12:00:00.000Z'
    }));

    renderStartScreen({ projects, signedIn: false });

    expect(screen.getByText('Part 9')).toBeInTheDocument();
    expect(screen.queryByText('Part 10')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show 17 more parts' }));

    expect(screen.getByText('Part 26')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Show fewer parts' })
    ).toBeInTheDocument();
  });
});
