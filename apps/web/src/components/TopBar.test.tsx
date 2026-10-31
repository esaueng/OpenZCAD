import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@openzcad/shared';
import type { WorkspaceSaveState } from '../lib/cloudProjectAutosave';
import { TopBar } from './TopBar';
import type { EncryptionIndicatorProps } from './EncryptionIndicator';

function renderTopBar(
  options: {
    saveState?: WorkspaceSaveState;
    signedIn?: boolean;
    saveToAccount?: boolean;
    knownDeviceOnly?: boolean;
    collaborationStatus?: 'offline' | 'rejected' | 'connecting';
    collaborationFailure?: string;
    geometryPending?: boolean;
    geometryFailed?: boolean;
    editPending?: boolean;
    editRefusal?: string;
    canExport?: boolean;
    exportWithheld?: string | null;
    exportUnavailableReason?: string | null;
    projectName?: string;
    encryption?: EncryptionIndicatorProps | null;
  } = {}
) {
  const handlers = {
    onSave: vi.fn(),
    onSaveAs: vi.fn(),
    onOpenSharing: vi.fn(),
    onSignIn: vi.fn(),
    onImportFiles: vi.fn(),
    onOpenMeshExport: vi.fn(),
    onRenameProject: vi.fn(),
    onReviewEditFailure: vi.fn()
  };
  render(
    <TopBar
      projectName={options.projectName ?? 'Plate'}
      units="mm"
      canExport={options.canExport ?? false}
      exportScope={null}
      exportWithheld={options.exportWithheld ?? null}
      exportUnavailableReason={options.exportUnavailableReason ?? null}
      saveState={options.saveState ?? 'local'}
      geometryPending={options.geometryPending}
      geometryFailed={options.geometryFailed}
      editPending={options.editPending}
      editRefusal={options.editRefusal}
      saveToAccount={options.saveToAccount ?? false}
      knownDeviceOnly={options.knownDeviceOnly ?? false}
      localOnlySourceCount={0}
      artifacts={[]}
      session={
        options.signedIn
          ? ({ userId: 'user-1', email: 'a@example.com' } as AuthSession)
          : null
      }
      accountState={options.signedIn ? 'signed-in' : 'signed-out'}
      collaborationStatus={options.collaborationStatus ?? 'offline'}
      collaborationFailure={options.collaborationFailure}
      collaboratorCount={0}
      projectSharingEnabled
      workspaceMode="build"
      canRenameProject
      buildModeDisabledReason={null}
      tweakModeDisabledReason={null}
      onWorkspaceMode={vi.fn()}
      onExportStep={vi.fn()}
      onArchiveLocalSources={vi.fn()}
      onExportDiagnostics={vi.fn()}
      onExportInteractionLog={vi.fn()}
      onGoHome={vi.fn()}
      onOpenSettings={vi.fn()}
      encryption={options.encryption ?? null}
      {...handlers}
    />
  );
  return handlers;
}

describe('TopBar save chip', () => {
  it.each(['synced', 'local'] as const)(
    'shows an uncommitted edit being checked instead of %s',
    (saveState) => {
      renderTopBar({ saveState, editPending: true });
      const chip = screen.getByRole('status', { name: 'Checking' });
      expect(chip).toHaveTextContent('Checking');
      expect(chip.querySelector('.spin')).not.toBeNull();
      expect(chip).toHaveAttribute(
        'title',
        expect.stringContaining('proposed edit')
      );
    }
  );

  it('keeps a save failure actionable while an edit is being checked', () => {
    renderTopBar({ saveState: 'repair', editPending: true });
    expect(screen.getByRole('button', { name: 'Repair needed' })).toBeVisible();
  });
  it('distinguishes stored work from exact geometry readiness', () => {
    renderTopBar({
      saveState: 'synced',
      signedIn: true,
      geometryPending: true
    });
    const chip = screen.getByRole('status', {
      name: 'Saved · preparing model'
    });
    expect(chip).toHaveAttribute(
      'title',
      expect.stringContaining('Saved on this device and in your account.')
    );
    expect(chip).toHaveAttribute(
      'title',
      expect.stringContaining('Face and edge edits become available')
    );
  });
  it('does not describe a failed rebuild as ongoing preparation', () => {
    renderTopBar({
      saveState: 'synced',
      signedIn: true,
      geometryPending: true,
      geometryFailed: true
    });
    expect(
      screen.getByRole('status', { name: 'Saved · model unavailable' })
    ).toHaveAttribute('title', expect.stringContaining('activity log'));
  });
  it('keeps its width to the short labels while the model prepares', () => {
    renderTopBar({
      saveState: 'synced',
      signedIn: true,
      geometryPending: true
    });
    const chip = screen.getByRole('status', {
      name: 'Saved · preparing model'
    });
    const slot = chip.querySelector('.stable-label');
    expect(slot).toHaveTextContent(/^Saved$/);
    expect(slot?.getAttribute('data-reserve')).not.toContain('model');
    // Announced through the live region's content, not only its name.
    expect(chip).toHaveTextContent('Saved · preparing model');
    expect(chip.querySelector('.spin')).not.toBeNull();
  });
  it('is a readout that saves nothing when clicked', () => {
    const { onSave } = renderTopBar({ saveState: 'local' });
    expect(
      screen.queryByRole('button', { name: 'Local only' })
    ).not.toBeInTheDocument();
    const chip = screen.getByRole('status', { name: 'Local only' });
    fireEvent.click(chip);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows a new validation instead of an earlier refusal', () => {
    renderTopBar({
      saveState: 'synced',
      editPending: true,
      editRefusal: 'The previous proposal was refused.'
    });
    expect(screen.getByRole('status', { name: 'Checking' })).toHaveTextContent(
      'Checking'
    );
    expect(
      screen.queryByRole('button', { name: 'Edit not applied' })
    ).not.toBeInTheDocument();
  });

  it('opens the refusal log without saving the old model again', () => {
    const handlers = renderTopBar({
      saveState: 'synced',
      editRefusal: 'The proposed edit would remove the body.'
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit not applied' }));
    expect(handlers.onReviewEditFailure).toHaveBeenCalledOnce();
    expect(handlers.onSave).not.toHaveBeenCalled();
  });

  it('keeps a device write failure ahead of a refused proposal', () => {
    renderTopBar({
      saveState: 'device-failed',
      editRefusal: 'The proposed edit was refused.'
    });
    expect(
      screen.queryByRole('button', { name: 'Edit not applied' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Not saved' })).toHaveTextContent(
      'Not saved'
    );
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
  it('describes a room refusal without claiming the project is unshared', () => {
    renderTopBar({
      signedIn: true,
      collaborationStatus: 'rejected',
      collaborationFailure: 'The room could not confirm this edit.'
    });
    expect(
      screen.getByRole('button', { name: 'Open project sharing · Unavailable' })
    ).toHaveAttribute(
      'title',
      'Connection refused: The room could not confirm this edit.'
    );
    expect(screen.queryByText('Not shared')).toBeNull();
  });
  it('says to sign in, and goes to sign-in, when signed out', () => {
    const { onOpenSharing, onSignIn } = renderTopBar();
    // Its name starts with the label it shows (WCAG 2.5.3).
    const chip = screen.getByRole('button', {
      name: 'Offline · Sign in to share'
    });
    expect(chip).toHaveTextContent('Offline');
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

  it('says a device-only project is not shared, not that it is offline', () => {
    renderTopBar({
      signedIn: true,
      saveToAccount: true,
      knownDeviceOnly: true
    });
    expect(
      screen.getByRole('button', { name: 'Open project sharing · Not shared' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Offline/ })
    ).not.toBeInTheDocument();
  });

  it('keeps Offline while the account is unreachable', () => {
    // The project list never arrived, so nothing proves this project is not
    // in the account; the open path has just called the account unreachable.
    renderTopBar({ signedIn: true, saveToAccount: true });
    expect(
      screen.getByRole('button', { name: 'Open project sharing · Offline' })
    ).toBeInTheDocument();
  });
});

describe('TopBar File menu', () => {
  function fileMenu(): HTMLDetailsElement {
    return document.querySelector<HTMLDetailsElement>('details.file-menu')!;
  }

  it('is named by what it shows', () => {
    renderTopBar();
    const summary = fileMenu().querySelector('summary')!;
    expect(summary).toHaveAccessibleName('File');
    expect(summary).toHaveAttribute('title', 'File: save, import and export');
  });

  it('reaches Import CAD files from the keyboard', () => {
    const { onImportFiles } = renderTopBar();
    fileMenu().open = true;
    const item = screen.getByRole('button', { name: /^Import CAD files…/ });
    // A focusable button now, not a label around a display:none input.
    expect(item.tabIndex).toBe(0);
    const input = screen.getByLabelText<HTMLInputElement>(
      'Import FreeCAD, STEP or a mesh file…'
    );
    expect(input).toHaveAttribute('type', 'file');
    const pick = vi.spyOn(input, 'click');
    fireEvent.click(item);
    expect(pick).toHaveBeenCalledOnce();

    const part = new File(['solid'], 'part.stl');
    fireEvent.change(input, { target: { files: [part] } });
    expect(onImportFiles).toHaveBeenCalledWith([part]);
  });

  it('keeps the import format list out of the import name', () => {
    renderTopBar({ canExport: true });
    fileMenu().open = true;
    expect(
      screen.getByRole('button', { name: 'Import CAD files…' })
    ).toHaveAttribute('title', expect.stringContaining('STEP'));
    // Only Export STEP answers to the format's name.
    expect(screen.getAllByRole('button', { name: /STEP/ })).toHaveLength(1);
  });

  it('says which body a failed feature holds out of the export', () => {
    const reason =
      'Duct 1 not exported: “Duct wall” failed to rebuild, so it does not match the design. Fix or suppress the failed feature in History to export it.';
    renderTopBar({ canExport: false, exportWithheld: reason });
    fileMenu().open = true;
    expect(screen.getByRole('note')).toHaveTextContent(reason);
    const exportStep = screen.getByRole('button', { name: /Export STEP/ });
    expect(exportStep).toBeDisabled();
    expect(exportStep).toHaveAttribute('title', reason);
  });

  it('tells users to show a hidden body before exporting', () => {
    renderTopBar({ exportUnavailableReason: 'Show a body before exporting.' });
    fileMenu().open = true;
    for (const name of [/Export STEP/, /Export mesh/]) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Show a body before exporting.');
    }
  });

  it('keeps a partial export available and says what it leaves out', () => {
    const reason = 'Duct 1 not exported: “Duct wall” failed to rebuild.';
    renderTopBar({ canExport: true, exportWithheld: reason });
    fileMenu().open = true;
    const exportStep = screen.getByRole('button', { name: /Export STEP/ });
    expect(exportStep).toBeEnabled();
    expect(exportStep).toHaveAttribute(
      'title',
      `Export all bodies as STEP. ${reason}`
    );
  });

  it('separates Export from Import with a rule', () => {
    renderTopBar();
    const exportLabel = [
      ...fileMenu().querySelectorAll('.topbar-menu-label')
    ].find((label) => label.textContent === 'Export')!;
    expect(exportLabel.previousElementSibling).toHaveClass('topbar-menu-sep');
  });

  it('hands focus to the File button before a menu item opens a dialog', () => {
    // The dialog restores focus to its opener; a menu item hidden inside the
    // closed menu could not take it, and focus fell to <body>.
    const { onSaveAs, onOpenMeshExport } = renderTopBar({ canExport: true });
    const summary = fileMenu().querySelector('summary')!;

    fileMenu().open = true;
    const saveAs = screen.getByRole('button', { name: /^Save revision as…/ });
    saveAs.focus();
    fireEvent.click(saveAs);
    expect(onSaveAs).toHaveBeenCalledOnce();
    expect(fileMenu().open).toBe(false);
    expect(summary).toHaveFocus();

    fileMenu().open = true;
    const mesh = screen.getByRole('button', { name: /^Export mesh…/ });
    mesh.focus();
    fireEvent.click(mesh);
    expect(onOpenMeshExport).toHaveBeenCalledOnce();
    expect(fileMenu().open).toBe(false);
    expect(summary).toHaveFocus();
  });

  it('closes when focus tabs out of it', () => {
    renderTopBar();
    fileMenu().open = true;
    const last = screen.getByRole('button', {
      name: /^Export interaction log/
    });
    const settings = screen.getByRole('button', { name: 'Open settings' });
    last.focus();
    // Moving between its own items keeps it open.
    fireEvent.blur(last, {
      relatedTarget: screen.getByRole('button', {
        name: /^Export diagnostics/
      })
    });
    expect(fileMenu().open).toBe(true);
    fireEvent.blur(last, { relatedTarget: settings });
    expect(fileMenu().open).toBe(false);
  });
});

describe('TopBar project title', () => {
  function titleButton() {
    return screen.getByRole('button', { name: 'Rename project Plate' });
  }

  it('carries the name it shows in its accessible name', () => {
    renderTopBar();
    expect(titleButton()).toHaveTextContent('Plate');
  });

  it('does not answer to a command named like the project', () => {
    renderTopBar({ projectName: 'Fillet retarget' });
    expect(screen.queryByRole('button', { name: /^Fillet/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Rename project Fillet retarget' })
    ).toBeInTheDocument();
  });

  it('returns focus to the title after a rename is committed', () => {
    const { onRenameProject } = renderTopBar();
    fireEvent.click(titleButton());
    const input = screen.getByRole('textbox', { name: 'Project name' });
    fireEvent.change(input, { target: { value: 'Bracket' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameProject).toHaveBeenCalledWith('Bracket');
    expect(titleButton()).toHaveFocus();
  });

  it('returns focus to the title after a rename is abandoned', () => {
    const { onRenameProject } = renderTopBar();
    fireEvent.click(titleButton());
    const input = screen.getByRole('textbox', { name: 'Project name' });
    fireEvent.change(input, { target: { value: 'Bracket' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRenameProject).not.toHaveBeenCalled();
    expect(titleButton()).toHaveFocus();
  });

  it('leaves focus where it went when a click elsewhere commits', () => {
    renderTopBar();
    fireEvent.click(titleButton());
    const input = screen.getByRole('textbox', { name: 'Project name' });
    const settings = screen.getByRole('button', { name: 'Open settings' });
    settings.focus();
    fireEvent.blur(input, { relatedTarget: settings });
    expect(settings).toHaveFocus();
  });
});

describe('TopBar encryption indicator', () => {
  const indicator = (
    status: EncryptionIndicatorProps['status'],
    extra: Partial<EncryptionIndicatorProps> = {}
  ): EncryptionIndicatorProps => ({
    status,
    onOpenEncryptionSettings: vi.fn(),
    ...extra
  });

  it('shows nothing new for a plaintext project', () => {
    renderTopBar({ signedIn: true, saveState: 'synced' });
    expect(screen.queryByText('End-to-end encrypted')).toBeNull();
    expect(screen.queryByLabelText(/End-to-end encrypted/)).toBeNull();
    expect(document.querySelector('.encryption-menu')).toBeNull();
  });

  it('names a verified project by the shelf badge’s words', () => {
    renderTopBar({ encryption: indicator({ state: 'verified' }) });
    const lock = screen.getByLabelText('End-to-end encrypted');
    expect(lock.tagName).toBe('SUMMARY');
    expect(lock).toHaveAttribute('title', 'End-to-end encrypted');
    expect(lock.closest('details')).toHaveAttribute(
      'data-encryption-state',
      'verified'
    );
    fireEvent.click(lock);
    expect(lock.closest('details')).toHaveAttribute('open');
    expect(screen.getByText('Verified')).toBeVisible();
    expect(screen.getByText(/signed by one of your devices/)).toBeVisible();
    // No claim the account cannot fork or roll back (ADR-024).
    expect(
      document.querySelector('.encryption-menu-panel')
    ).not.toHaveTextContent(/cannot (fork|roll back)|zero.knowledge|military/i);
  });

  it('shows a warning-styled lock while a verification warning is active', () => {
    renderTopBar({
      encryption: indicator({
        state: 'warning',
        warning: {
          kind: 'stale-head',
          signedAt: Date.UTC(2026, 9, 1, 9),
          updatedAt: Date.UTC(2026, 9, 2, 9)
        }
      })
    });
    const lock = screen.getByLabelText(
      'End-to-end encrypted · verification warning'
    );
    expect(lock.closest('details')).toHaveClass('is-warning');
    fireEvent.click(lock);
    expect(screen.getByText('Verification warning')).toBeVisible();
    expect(
      screen.getByText(/cannot tell whether a newer version was left out/)
    ).toBeVisible();
    expect(screen.getByText(/^Signed .* · last activity .*$/)).toBeVisible();
  });

  it('prompts to unlock in Settings › Encryption when keys are locked', () => {
    const onOpenEncryptionSettings = vi.fn();
    renderTopBar({
      encryption: indicator({ state: 'locked' }, { onOpenEncryptionSettings })
    });
    const lock = screen.getByLabelText(
      'End-to-end encrypted · encryption locked'
    );
    fireEvent.click(lock);
    expect(screen.getByText('Locked on this device')).toBeVisible();
    expect(
      screen.getByText(
        'Unlock encryption on this device (Settings › Encryption) to open or save encrypted projects.'
      )
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: 'Encryption settings' })
    );
    expect(onOpenEncryptionSettings).toHaveBeenCalledTimes(1);
    expect(lock.closest('details')).not.toHaveAttribute('open');
  });

  it('reports a failed verification in its own words', () => {
    renderTopBar({
      encryption: indicator({
        state: 'problem',
        problem:
          'The head was written under an older key epoch than this browser already accepted.'
      })
    });
    const lock = screen.getByLabelText(
      'End-to-end encrypted · verification failed'
    );
    expect(lock.closest('details')).toHaveClass('is-problem');
    fireEvent.click(lock);
    expect(screen.getByText('Verification failed')).toBeVisible();
    expect(
      screen.getByText(/older key epoch than this browser already accepted/)
    ).toBeVisible();
    expect(screen.queryByText(/needs repair/)).toBeNull();
  });

  it('shows a problem while the account copy needs repair and autosave waits', () => {
    renderTopBar({
      saveState: 'repair',
      encryption: indicator({ state: 'verified' }, { needsRepair: true })
    });
    const lock = screen.getByLabelText('End-to-end encrypted · repair needed');
    expect(lock.closest('details')).toHaveAttribute(
      'data-encryption-state',
      'problem'
    );
    fireEvent.click(lock);
    expect(
      screen.getByText(
        'The account copy needs repair. Your work remains saved on this device; click Repair needed to retry.'
      )
    ).toBeVisible();
  });

  it('says nothing is verified before this page opens or saves a version', () => {
    renderTopBar({ encryption: indicator({ state: 'unverified' }) });
    const lock = screen.getByLabelText(
      'End-to-end encrypted · not verified yet'
    );
    fireEvent.click(lock);
    expect(screen.getByText('Not verified yet')).toBeVisible();
  });

  it('shows the project state code in full only when one is given', () => {
    renderTopBar({ encryption: indicator({ state: 'verified' }) });
    fireEvent.click(screen.getByLabelText('End-to-end encrypted'));
    expect(screen.queryByText('Project state code')).toBeNull();
  });

  it('carries a slot for the project state code', () => {
    const code = '0123 4567 89ab cdef 0123 4567 89ab cdef';
    renderTopBar({
      encryption: indicator({ state: 'verified' }, { projectStateCode: code })
    });
    fireEvent.click(screen.getByLabelText('End-to-end encrypted'));
    expect(screen.getByText('Project state code')).toBeVisible();
    expect(screen.getByText(code).tagName).toBe('CODE');
  });

  it('copies the project state code', async () => {
    const code = '0123 4567 89ab cdef 0123 4567 89ab cdef';
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    renderTopBar({
      encryption: indicator({ state: 'verified' }, { projectStateCode: code })
    });
    fireEvent.click(screen.getByLabelText('End-to-end encrypted'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy project state code' })
    );
    expect(writeText).toHaveBeenCalledWith(code);
    expect(
      await screen.findByRole('button', { name: 'Copied project state code' })
    ).toBeVisible();
  });

  it('shuts the padlock only once a version is verified', () => {
    const shackle = (status: EncryptionIndicatorProps['status']) => {
      renderTopBar({ encryption: indicator(status) });
      const lock = document.querySelector('.encryption-indicator');
      const value =
        lock?.querySelector('[data-shackle]')?.getAttribute('data-shackle') ??
        null;
      cleanup();
      return value;
    };
    expect(shackle({ state: 'verified' })).toBe('closed');
    expect(shackle({ state: 'unverified' })).toBe('open');
    expect(shackle({ state: 'warning' })).toBe('open');
    expect(shackle({ state: 'locked' })).toBe('keyhole');
    expect(shackle({ state: 'problem', problem: 'Bad head.' })).toBeNull();
  });

  it('closes on Escape and hands focus back to the lock', () => {
    renderTopBar({ encryption: indicator({ state: 'verified' }) });
    const lock = screen.getByLabelText('End-to-end encrypted');
    fireEvent.click(lock);
    const settings = screen.getByRole('button', {
      name: 'Encryption settings'
    });
    settings.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(lock.closest('details')).not.toHaveAttribute('open');
    expect(lock).toHaveFocus();
  });
});
