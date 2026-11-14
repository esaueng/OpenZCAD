import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  Copy,
  Info,
  LoaderCircle,
  Lock,
  LockOpen,
  TriangleAlert,
  X
} from 'lucide-react';
import {
  MAX_PROJECT_NAME_LENGTH,
  PROJECT_STORAGE_FORMAT_E2EE_V1,
  projectOrganization,
  type ProjectSummary
} from '@openzcad/shared';
import { AssistantConsentSummary } from './assistant/AssistantConsentSummary';
import {
  formatProjectBytes,
  type ProjectProperties
} from '../lib/projectProperties';
import {
  projectEncryptionStatus,
  type EncryptionFacts
} from '../lib/projectEncryptionStatus';
import { useModalFocus } from '../lib/useModalFocus';
import { projectNameProblem, sameNamedProject } from '../lib/projectNameHints';

export interface ProjectPropertiesDialogProps {
  project: ProjectSummary;
  accountStatus: string;
  /**
   * What the host knows about how the project is stored; the Encryption
   * row is left out without it.
   */
  encryptionFacts?: EncryptionFacts;
  loadProperties(project: ProjectSummary): Promise<ProjectProperties | null>;
  /**
   * Makes the name editable: resolves true once the new name is stored.
   * Absent for a project this build cannot open.
   */
  onRename?(name: string): Promise<boolean>;
  /** The library's projects, to say when a typed name is already taken. */
  projects?: ReadonlyArray<{ projectId: string; name: string }>;
  onClose(): void;
}

/** The start screen tile's exact form (its tooltip): no seconds. */
function dateLabel(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) {
    return 'Not recorded';
  }
  const date = new Date(value);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })}`;
}

export function ProjectPropertiesDialog({
  project,
  accountStatus,
  encryptionFacts,
  loadProperties,
  onRename,
  projects = [],
  onClose
}: ProjectPropertiesDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const nameHintId = useId();
  // The name as stored, which a rename here moves ahead of `project`.
  const [savedName, setSavedName] = useState(project.name);
  const [nameDraft, setNameDraft] = useState(project.name);
  const [renaming, setRenaming] = useState(false);
  const nameProblem = projectNameProblem(nameDraft);
  const nameTaken = nameProblem
    ? null
    : sameNamedProject(nameDraft, projects, project.projectId);
  async function commitName() {
    const next = nameDraft.trim();
    if (!onRename || renaming || nameProblem || next === savedName) {
      if (nameProblem) setNameDraft(savedName);
      return;
    }
    setRenaming(true);
    const stored = await onRename(next).catch(() => false);
    setRenaming(false);
    if (stored) {
      setSavedName(next);
      setNameDraft(next);
    } else {
      setNameDraft(savedName);
    }
  }
  const [properties, setProperties] = useState<ProjectProperties | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  // Copy feedback settles back to Copy, so a later copy elsewhere does not
  // leave this one claiming the clipboard.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle'
  );
  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  useModalFocus(ref, { autoFocus: true });
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setProperties(null);
    void loadProperties(project)
      .catch(() => null)
      .then((result) => {
        if (!cancelled) {
          setProperties(result);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project, loadProperties, attempt]);

  const organization = projectOrganization(project);
  const shelf = { active: 'Projects', archived: 'Archive', deleted: 'Trash' }[
    organization.status
  ];
  const library: Row[] = [
    ['Shelf', shelf],
    ['Pinned', organization.pinned ? 'Yes' : 'No'],
    ['Account copy', accountStatus]
  ];
  const encryption =
    encryptionFacts && projectEncryptionStatus(project, encryptionFacts);
  if (encryption) {
    const Icon = {
      encrypted: Lock,
      encrypting: LoaderCircle,
      plaintext: LockOpen,
      unreadable: Lock
    }[encryption.state];
    library.push([
      'Encryption',
      <span
        key="encryption"
        className={`project-properties-encryption is-${encryption.state}`}
      >
        <Icon
          size={12}
          className={encryption.state === 'encrypting' ? 'spin' : undefined}
          aria-hidden="true"
        />
        {encryption.label}
      </span>,
      encryption.detail
    ]);
  }
  if (organization.archivedAt)
    library.push(['Archived', dateLabel(organization.archivedAt)]);
  if (organization.deletedAt)
    library.push(['Moved to trash', dateLabel(organization.deletedAt)]);
  // ADR-024 Phase 6: whether the assistant may read this encrypted project.
  if (project.storageFormat === PROJECT_STORAGE_FORMAT_E2EE_V1) {
    library.push([
      'Assistant',
      <AssistantConsentSummary key="assistant" projectId={project.projectId} />
    ]);
  }

  const history: Row[] = [
    ['Last edited', dateLabel(properties?.updatedAt ?? project.updatedAt)]
  ];
  if (properties) {
    history.push([
      properties.branchedFrom
        ? 'Branched'
        : properties.startedAt
          ? 'First recorded save'
          : 'Oldest retained save',
      dateLabel(properties.startedAt ?? properties.oldestSaveAt),
      properties.branchedFrom
        ? undefined
        : properties.startedAt
          ? 'A duplicated project keeps the save history of its original.'
          : 'The original creation date is no longer recorded; this is the oldest retained save.'
    ]);
    if (properties.branchedFrom) {
      history.push([
        'Branched from',
        `${properties.branchedFrom.projectName} · ${properties.branchedFrom.checkpointReason}`
      ]);
    }
  }
  history.push([
    'Save points',
    properties?.savePoints ?? project.revisionCount
  ]);

  const storage: Row[] = [];
  const technical: Row[] = [];
  if (properties) {
    storage.push([
      'Project data size',
      formatProjectBytes(
        properties.documentBytes + properties.referencedSourceBytes
      ),
      `Saved model data and undo history, embedded files included${
        properties.referencedSourceBytes
          ? '; each referenced source file counts once'
          : ''
      }. Excludes geometry previews, thumbnails, backups and separate save-point snapshots.`
    ]);
    // The split only says something when a source file adds to the total;
    // without one, both rows repeated the same size.
    if (properties.referencedSourceBytes > 0) {
      storage.push(
        ['Document size', formatProjectBytes(properties.documentBytes)],
        [
          'Referenced source files',
          formatProjectBytes(properties.referencedSourceBytes)
        ]
      );
    }
    technical.push(
      [
        'Units',
        {
          mm: 'Millimeters (mm)',
          cm: 'Centimeters (cm)',
          m: 'Meters (m)',
          inch: 'Inches (in)'
        }[properties.units]
      ],
      ['Document version', properties.documentVersion]
    );
  }
  technical.push([
    'Project ID',
    <span key="id" className="project-properties-id">
      <code>{project.projectId}</code>
      <button
        type="button"
        className="icon-button"
        aria-label={
          copyState === 'copied'
            ? 'Copied project ID'
            : copyState === 'failed'
              ? 'Could not copy project ID; select it to copy'
              : 'Copy project ID'
        }
        title={
          copyState === 'copied'
            ? 'Copied'
            : copyState === 'failed'
              ? 'Could not copy; select the ID to copy it'
              : 'Copy'
        }
        onClick={() => {
          // A browser without clipboard access, or one that refuses the
          // write, says so instead of doing nothing.
          const clipboard = (navigator as Navigator & { clipboard?: Clipboard })
            .clipboard;
          if (!clipboard) {
            setCopyState('failed');
            return;
          }
          void clipboard.writeText(project.projectId).then(
            () => setCopyState('copied'),
            () => setCopyState('failed')
          );
        }}
      >
        {copyState === 'copied' ? (
          <Check size={12} aria-hidden="true" />
        ) : copyState === 'failed' ? (
          <TriangleAlert size={12} aria-hidden="true" />
        ) : (
          <Copy size={12} aria-hidden="true" />
        )}
      </button>
      <span className="visually-hidden" role="status">
        {copyState === 'copied'
          ? 'Project ID copied.'
          : copyState === 'failed'
            ? 'Could not copy the project ID. Select it to copy it.'
            : ''}
      </span>
    </span>
  ]);

  const counts: Array<[string, number]> = properties
    ? [
        ['Bodies', properties.bodies],
        ['Features', properties.features],
        ['Sketches', properties.sketches],
        ['Parameters', properties.parameters]
      ]
    : [];

  return (
    <div
      className="modal-backdrop"
      // Mouse-down, as the other dialogs: a text selection dragged out of
      // the dialog released over the backdrop and closed it on click.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="project-properties-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="project-properties-header">
          <h2 id={titleId}>
            <Info size={18} aria-hidden="true" />
            Project properties
          </h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close project properties"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <div className="project-properties-body">
          <div className="project-properties-name">
            {onRename ? (
              <>
                <input
                  value={nameDraft}
                  aria-label="Project name"
                  aria-invalid={nameProblem ? true : undefined}
                  aria-describedby={
                    nameProblem || nameTaken ? nameHintId : undefined
                  }
                  maxLength={MAX_PROJECT_NAME_LENGTH}
                  disabled={renaming}
                  title="Press Enter to rename"
                  onChange={(event) => setNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void commitName();
                    } else if (
                      event.key === 'Escape' &&
                      nameDraft !== savedName
                    ) {
                      // The first Escape puts the name back; the next closes.
                      event.preventDefault();
                      event.stopPropagation();
                      setNameDraft(savedName);
                    }
                  }}
                  onBlur={() => void commitName()}
                />
                {(nameProblem || nameTaken) && (
                  <small
                    id={nameHintId}
                    role="status"
                    className={nameProblem ? 'is-problem' : undefined}
                  >
                    {nameProblem ??
                      `Another project is already called “${nameTaken}”.`}
                  </small>
                )}
              </>
            ) : (
              <p>{savedName}</p>
            )}
          </div>
          {loading && (
            <p role="status" className="project-properties-message">
              <LoaderCircle size={14} className="spin" aria-hidden="true" />
              Loading project details…
            </p>
          )}
          {!loading && !properties && (
            <p role="alert" className="project-properties-message">
              Project details could not be loaded.{' '}
              <button
                type="button"
                className="secondary"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </button>
            </p>
          )}
          {properties?.olderDeviceCopy && (
            <p role="status" className="project-properties-message">
              Showing an older device copy. The latest account details are
              unavailable.
            </p>
          )}
          {counts.length > 0 && (
            <dl className="project-properties-counts" aria-label="Contents">
              {counts.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="project-properties-grid">
            <PropertySection title="Library" rows={library} />
            <PropertySection title="History" rows={history} />
            {storage.length > 0 && (
              <PropertySection title="Storage" rows={storage} />
            )}
            <PropertySection title="Technical" rows={technical} />
          </div>
        </div>
        <footer className="project-properties-actions">
          {properties && (
            <span className="project-properties-source">
              Details from{' '}
              {properties.source === 'device' ? 'this device' : 'my account'}
            </span>
          )}
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Label, value, and an optional caveat the label's info button reveals. */
type Row = [string, ReactNode, string?];

function PropertySection({ title, rows }: { title: string; rows: Row[] }) {
  const headingId = useId();
  const noteId = useId();
  // A caveat opens under its row on demand: shown always, they pushed the
  // dialog past the screen; as a hover tooltip, keyboard and touch could
  // not reach them.
  const [openNote, setOpenNote] = useState<string | null>(null);
  return (
    <section className="project-properties-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      <dl className="project-properties-list">
        {rows.map(([label, value, note], index) => (
          <div key={label}>
            <dt>
              {label}
              {note && (
                <button
                  type="button"
                  className="icon-button project-properties-note-toggle"
                  aria-label={`About ${label}`}
                  aria-expanded={openNote === label}
                  aria-controls={`${noteId}-${index}`}
                  title={note}
                  onClick={() =>
                    setOpenNote((open) => (open === label ? null : label))
                  }
                >
                  <Info size={12} aria-hidden="true" />
                </button>
              )}
            </dt>
            <dd>{value}</dd>
            {note && (
              <dd
                id={`${noteId}-${index}`}
                className="project-properties-note"
                hidden={openNote !== label}
              >
                {note}
              </dd>
            )}
          </div>
        ))}
      </dl>
    </section>
  );
}
