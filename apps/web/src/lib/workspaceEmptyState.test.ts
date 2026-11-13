import { describe, expect, it } from 'vitest';
import {
  showsWorkspaceEmptyState,
  type WorkspaceEmptyStateInput
} from './workspaceEmptyState';

const empty = (
  over: Partial<WorkspaceEmptyStateInput> = {}
): WorkspaceEmptyStateInput => ({
  buildMode: true,
  featureCount: 0,
  bodyCount: 0,
  commandActive: false,
  editDisabledReason: null,
  ...over
});

describe('workspace empty state', () => {
  it('invites a first step into an empty project in Build', () => {
    expect(showsWorkspaceEmptyState(empty())).toBe(true);
  });

  it('leaves as soon as a tool is armed', () => {
    expect(showsWorkspaceEmptyState(empty({ commandActive: true }))).toBe(
      false
    );
  });

  it('leaves once the project holds anything', () => {
    expect(showsWorkspaceEmptyState(empty({ featureCount: 1 }))).toBe(false);
    // A body with no feature behind it still fills the stage.
    expect(showsWorkspaceEmptyState(empty({ bodyCount: 1 }))).toBe(false);
  });

  it('stays out of the workspaces that do not create', () => {
    expect(showsWorkspaceEmptyState(empty({ buildMode: false }))).toBe(false);
  });

  it('does not invite an edit the project cannot take', () => {
    expect(
      showsWorkspaceEmptyState(
        empty({ editDisabledReason: 'This project is open in another tab' })
      )
    ).toBe(false);
  });
});
