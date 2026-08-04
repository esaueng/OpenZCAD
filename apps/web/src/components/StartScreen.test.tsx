import { render, screen } from '@testing-library/react';
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
});
