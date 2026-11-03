import { useRef, useState } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
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
  /** Makes study ids; tests pass a deterministic one. */
  newStudyId?(): string;
}

const PLAYBACK_LABELS: Record<AssemblyMotionStudy['playback'], string> = {
  once: 'once',
  loop: 'loop',
  'ping-pong': 'back and forth'
};

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

/**
 * AS07 motion studies in the Assembly panel: the project's studies with
 * their durations. Selecting one opens its timeline; New study keys every
 * moving joint where it stands now. Rename and delete are one undoable
 * command each.
 */
export function AssemblyStudiesSection({
  assembly,
  execute,
  readOnly = false,
  newStudyId = () => createId('study')
}: AssemblyStudiesSectionProps) {
  const selectedStudyId = useAssemblyRuntime((s) => s.selectedStudyId);
  const [renaming, setRenaming] = useState<string | null>(null);
  // The field being edited, read by blur: a field removed after Enter or
  // Escape may still blur, and must not commit a second time.
  const renamingRef = useRef<string | null>(null);
  const [name, setName] = useState('');
  const studies = assembly?.studies ?? [];
  const full = studies.length >= MAX_ASSEMBLY_STUDIES;

  function select(studyId: string) {
    if (selectedStudyId === studyId) return;
    const runtime = getAssemblyRuntime();
    if (runtime.playback?.kind === 'study') assemblyRuntime.stop();
    assemblyRuntime.selectStudy(studyId);
  }

  function create() {
    if (readOnly || full) return;
    const study = createDefaultStudy(
      assembly,
      newStudyId(),
      getAssemblyRuntime().overrides
    );
    if (
      execute(
        commandFactories.setAssemblyStudy(
          { study },
          `New motion study ${study.name}`
        )
      )
    )
      select(study.id);
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
    <div className="assembly-studies" role="group" aria-label="Motion studies">
      {studies.length === 0 && (
        <p className="assembly-studies-empty">
          No motion studies yet. A study keys joint values over time.
        </p>
      )}
      <ul className="assembly-studies-list">
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
                  title={`${study.tracks.length} track${study.tracks.length === 1 ? '' : 's'}, plays ${PLAYBACK_LABELS[study.playback]}`}
                  onClick={() => select(study.id)}
                  onDoubleClick={() => !readOnly && startRename(study)}
                >
                  <span className="assembly-study-name">{study.name}</span>
                  <span className="assembly-study-duration">
                    {formatStudyTime(study.durationS)} s
                  </span>
                </button>
              )}
              {!readOnly && renaming !== study.id && (
                <>
                  <button
                    type="button"
                    className="assembly-study-action"
                    aria-label={`Rename ${study.name}`}
                    title="Rename"
                    onClick={() => startRename(study)}
                  >
                    <Pencil size={11} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="assembly-study-action"
                    aria-label={`Delete ${study.name}`}
                    title="Delete"
                    onClick={() => remove(study)}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {!readOnly && (
        <button
          type="button"
          className="assembly-studies-new"
          disabled={full}
          title={
            full
              ? `An assembly keeps up to ${MAX_ASSEMBLY_STUDIES} motion studies.`
              : 'Key every moving joint where it stands now'
          }
          onClick={create}
        >
          <Plus size={11} aria-hidden="true" />
          New study
        </button>
      )}
    </div>
  );
}
