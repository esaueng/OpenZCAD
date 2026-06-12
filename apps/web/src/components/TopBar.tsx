import { Redo2, Save, Sparkles, Undo2 } from 'lucide-react';
import type { UnitSystem } from '@openzcad/shared';
import { BrandMark } from './BrandMark';

interface TopBarProps {
  projectName: string | null;
  units: UnitSystem | null;
  activeStepTitle: string;
  canUndo: boolean;
  canRedo: boolean;
  generating: boolean;
  canGenerate: boolean;
  onUndo(): void;
  onRedo(): void;
  onSave(): void;
  onGenerate(): void;
  onGoHome(): void;
}

export function TopBar({
  projectName,
  units,
  activeStepTitle,
  canUndo,
  canRedo,
  generating,
  canGenerate,
  onUndo,
  onRedo,
  onSave,
  onGenerate,
  onGoHome
}: TopBarProps) {
  return (
    <header className="topbar">
      <button className="brand" type="button" onClick={onGoHome} title="Back to projects">
        <BrandMark />
        OpenZCAD <span className="beta-tag">Beta</span>
      </button>
      <div className="topbar-divider" />
      <div className="breadcrumb">
        <strong>{projectName ?? 'No project'}</strong>
        {projectName && (
          <>
            <span className="breadcrumb-sep">/</span>
            <span>{activeStepTitle}</span>
            <span className="mono">{units ?? ''}</span>
          </>
        )}
      </div>
      <div className="topbar-tools" aria-label="Workspace tools">
        <button
          className="icon-button"
          type="button"
          title="Undo"
          aria-label="Undo"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <Undo2 size={15} aria-hidden="true" />
        </button>
        <button
          className="icon-button"
          type="button"
          title="Redo"
          aria-label="Redo"
          disabled={!canRedo}
          onClick={onRedo}
        >
          <Redo2 size={15} aria-hidden="true" />
        </button>
      </div>
      <button
        className={`primary topbar-action ${generating ? 'running' : ''}`}
        type="button"
        disabled={!canGenerate || generating}
        onClick={onGenerate}
        title={canGenerate ? 'Run generative study' : 'Complete the setup checklist before generating'}
      >
        <Sparkles size={15} aria-hidden="true" />
        {generating ? 'Generating…' : 'Generate'}
      </button>
      <button
        className="secondary topbar-action"
        type="button"
        disabled={!projectName}
        onClick={onSave}
        title="Save a revision to persistence"
      >
        <Save size={15} aria-hidden="true" />
        Save
      </button>
    </header>
  );
}
