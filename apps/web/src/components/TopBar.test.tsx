import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@openzcad/shared';
import type { WorkspaceSaveState } from '../lib/cloudProjectAutosave';
import { TopBar } from './TopBar';

function renderTopBar(
  options: {
    saveState?: WorkspaceSaveState;
    signedIn?: boolean;
    saveToAccount?: boolean;
  } = {}
) {
  const handlers = {
    onSave: vi.fn(),
    onSaveAs: vi.fn(),
    onOpenSharing: vi.fn(),
    onSignIn: vi.fn()
  };
  render(
    <TopBar
      projectName="Plate"
      units="mm"
      canExport={false}
      exportScope={null}
      saveState={options.saveState ?? 'local'}
      saveToAccount={options.saveToAccount ?? false}
      localOnlySourceCount={0}
      artifacts={[]}
      session={
        options.signedIn
          ? ({ userId: 'user-1', email: 'a@example.com' } as AuthSession)
          : null
      }
      accountState={options.signedIn ? 'signed-in' : 'signed-out'}
      collaborationStatus="offline"
      collaboratorCount={0}
      projectSharingEnabled
      workspaceMode="build"
      canRenameProject
      buildModeDisabledReason={null}
      tweakModeDisabledReason={null}
      onWorkspaceMode={vi.fn()}
      onImportFiles={vi.fn()}
      onExportStep={vi.fn()}
      onOpenMeshExport={vi.fn()}
      onArchiveLocalSources={vi.fn()}
      onExportDiagnostics={vi.fn()}
      onExportInteractionLog={vi.fn()}
      onRenameProject={vi.fn()}
      onGoHome={vi.fn()}
      onOpenSettings={vi.fn()}
      {...handlers}
    />
  );
  return handlers;
}

describe('TopBar save chip', () => {
  it('is a readout that saves nothing when clicked', () => {
    const { onSave } = renderTopBar({ saveState: 'local' });
    expect(
      screen.queryByRole('button', { name: 'Local only' })
    ).not.toBeInTheDocument();
    const chip = screen.getByRole('status', { name: 'Local only' });
    fireEvent.click(chip);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('stays a button where its label names an action', () => {
    const repair = renderTopBar({ saveState: 'repair', signedIn: true });
    fireEvent.click(screen.getByRole('button', { name: 'Repair needed' }));
    expect(repair.onSave).toHaveBeenCalledOnce();
  });

  it('stays a button to save a local project to the account', () => {
    const { onSave } = renderTopBar({ signedIn: true, saveToAccount: true });
    fireEvent.click(screen.getByRole('button', { name: 'Save to my account' }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('moves saving to the File menu', () => {
    const { onSave, onSaveAs } = renderTopBar();
    fireEvent.click(screen.getByText('File'));
    fireEvent.click(
      screen.getByRole('button', { name: /^Save revision(?! as)/ })
    );
    expect(onSave).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('File'));
    fireEvent.click(screen.getByRole('button', { name: /^Save revision as…/ }));
    expect(onSaveAs).toHaveBeenCalledOnce();
  });
});

describe('TopBar sharing chip', () => {
  it('says to sign in, and goes to sign-in, when signed out', () => {
    const { onOpenSharing, onSignIn } = renderTopBar();
    const chip = screen.getByRole('button', {
      name: 'Project sharing · Sign in to share'
    });
    expect(chip).toHaveAttribute('title', 'Sign in to share');
    // A live control now, not an aria-disabled one that did nothing.
    expect(chip).not.toHaveAttribute('aria-disabled');
    expect(chip).not.toBeDisabled();
    fireEvent.click(chip);
    expect(onOpenSharing).not.toHaveBeenCalled();
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it('opens sharing when signed in', () => {
    const { onOpenSharing } = renderTopBar({ signedIn: true });
    fireEvent.click(
      screen.getByRole('button', { name: 'Open project sharing · Offline' })
    );
    expect(onOpenSharing).toHaveBeenCalledOnce();
  });
});
