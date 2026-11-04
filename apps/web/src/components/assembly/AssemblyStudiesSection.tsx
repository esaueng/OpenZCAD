import { useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  ASSEMBLY_JOINT_DOFS,
  MAX_ASSEMBLY_NAME_LENGTH,
  MAX_ASSEMBLY_STUDIES,
  createId,
  type AssemblyMotionStudy,
  type AssemblySet
} from '@openzcad/shared';
import {
  assemblyRuntime,
  getAssemblyRuntime,
  useAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import {
  createDefaultStudy,
  formatStudyTime
} from '../../lib/assembly/motionStudy';

export interface AssemblyStudiesSectionProps {
  /** The open document's assembly section. */
  assembly: AssemblySet | undefined;
  /** Runs one undoable command; false when it was refused. */
  execute(command: AnyCommand): boolean;
  /** Lists and selects studies, but offers no edits. */
  readOnly?: boolean;
}

/** Stops a study's playback and closes it if it is the one shown. */
function releaseStudy(studyId: string) {
  const runtime = getAssemblyRuntime();
  if (
    runtime.playback?.kind === 'study' &&
    runtime.playback.studyId === studyId
  )
    assemblyRuntime.stop();
  if (runtime.selectedStudyId === studyId) assemblyRuntime.selectStudy(null);
}

function selectStudy(studyId: string) {
  const runtime = getAssemblyRuntime();
  if (runtime.selectedStudyId === studyId) return;
  if (runtime.playback?.kind === 'study') assemblyRuntime.stop();
  assemblyRuntime.selectStudy(studyId);
}

export interface AddStudyButtonProps {
  assembly: AssemblySet | undefined;
  execute(command: AnyCommand): boolean;
  /** Makes study ids; tests pass a deterministic one. */
  newStudyId?(): string;
}

/**
 * The Motion section's Add: a study keying every moving joint where it
 * stands now, opened with the playhead at its end, so the next part moved
 * becomes the motion. Hidden while nothing can move or the list is full.
 */
export function AddStudyButton({
  assembly,
  execute,
  newStudyId = () => createId('study')
}: AddStudyButtonProps) {
  const studies = assembly?.studies ?? [];
  const moves = (assembly?.joints ?? []).some(
    (joint) => ASSEMBLY_JOINT_DOFS[joint.kind].length > 0
  );
  if (!moves || studies.length >= MAX_ASSEMBLY_STUDIES) return null;
  function create() {
    const study = createDefaultStudy(
      assembly,
      newStudyId(),
      getAssemblyRuntime().overrides
    );
    if (
      !execute(
        commandFactories.setAssemblyStudy(
          { study },
          `New motion study ${study.name}`
        )
      )
    )
      return;
    selectStudy(study.id);
    assemblyRuntime.setStudyTime(study.durationS);
  }
  return (
    <button
      type="button"
      className="assembly-link-button"
      aria-label="Add motion study"
      title="New motion study"
      onClick={create}
    >
      <Plus size={12} aria-hidden="true" />
      Add
    </button>
  );
}

/**
 * AS07 motion studies in the Assembly panel: one row per study with its
 * duration. Clicking a row opens its timeline (again closes it); a
 * double-click renames it. Rename and delete are one undoable command each.
 */
export function AssemblyStudiesSection({
  assembly,
  execute,
  readOnly = false
}: AssemblyStudiesSectionProps) {
  const selectedStudyId = useAssemblyRuntime((s) => s.selectedStudyId);
  const [renaming, setRenaming] = useState<string | null>(null);
  // The field being edited, read by blur: a field removed after Enter or
  // Escape may still blur, and must not commit a second time.
  const renamingRef = useRef<string | null>(null);
  const [name, setName] = useState('');
  const studies = assembly?.studies ?? [];
  if (studies.length === 0) return null;

  function toggle(studyId: string) {
    if (selectedStudyId === studyId) releaseStudy(studyId);
    else selectStudy(studyId);
  }

  function startRename(study: AssemblyMotionStudy) {
    renamingRef.current = study.id;
    setRenaming(study.id);
    setName(study.name);
  }

  function cancelRename() {
    renamingRef.current = null;
    setRenaming(null);
  }

  function finishRename(study: AssemblyMotionStudy) {
    if (renamingRef.current !== study.id) return;
    cancelRename();
    const trimmed = name.trim().slice(0, MAX_ASSEMBLY_NAME_LENGTH);
    if (!trimmed || trimmed === study.name) return;
    execute(
      commandFactories.setAssemblyStudy(
        { study: { ...study, name: trimmed } },
        `Rename motion study to ${trimmed}`
      )
    );
  }

  function remove(study: AssemblyMotionStudy) {
    if (execute(commandFactories.deleteAssemblyStudy({ studyId: study.id })))
      releaseStudy(study.id);
  }

  return (
    <ul className="assembly-studies-list" aria-label="Motion studies">
      {studies.map((study) => {
        const selected = study.id === selectedStudyId;
        return (
          <li
            key={study.id}
            className={
              selected
                ? 'assembly-study-row assembly-study-row-selected'
                : 'assembly-study-row'
            }
          >
            {renaming === study.id ? (
              <input
                className="assembly-study-rename"
                aria-label={`Rename ${study.name}`}
                value={name}
                maxLength={MAX_ASSEMBLY_NAME_LENGTH}
                // The field opens on request, so it takes focus at once.
                autoFocus
                onChange={(event) => setName(event.target.value)}
                onBlur={() => finishRename(study)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    finishRename(study);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="assembly-study-select"
                aria-pressed={selected}
                title={readOnly ? undefined : 'Double-click to rename'}
                onClick={(event) => {
                  if (event.detail > 1) return;
                  toggle(study.id);
                }}
                onDoubleClick={() => !readOnly && startRename(study)}
              >
                <span className="assembly-study-name">{study.name}</span>
                <span className="assembly-study-duration">
                  {formatStudyTime(study.durationS)} s
                </span>
              </button>
            )}
            {!readOnly && renaming !== study.id && (
              <button
                type="button"
                className="assembly-study-action"
                aria-label={`Delete ${study.name}`}
                title="Delete"
                onClick={() => remove(study)}
              >
                <X size={11} aria-hidden="true" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
