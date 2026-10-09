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
    knownDeviceOnly?: boolean;
    geometryPending?: boolean;
    geometryFailed?: boolean;
    canExport?: boolean;
    projectName?: string;
  } = {}
) {
  const handlers = {
    onSave: vi.fn(),
    onSaveAs: vi.fn(),
    onOpenSharing: vi.fn(),
    onSignIn: vi.fn(),
    onImportFiles: vi.fn(),
    onOpenMeshExport: vi.fn(),
    onRenameProject: vi.fn()
  };
  render(
    <TopBar
      projectName={options.projectName ?? 'Plate'}
      units="mm"
      canExport={options.canExport ?? false}
      exportScope={null}
      saveState={options.saveState ?? 'local'}
      geometryPending={options.geometryPending}
      geometryFailed={options.geometryFailed}
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
      collaborationStatus="offline"
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
      {...handlers}
    />
  );
  return handlers;
}

describe('TopBar save chip', () => {
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
