import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Info, LoaderCircle, X } from 'lucide-react';
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
import { useModalFocus } from '../lib/useModalFocus';
import { projectNameProblem, sameNamedProject } from '../lib/projectNameHints';

export interface ProjectPropertiesDialogProps {
  project: ProjectSummary;
  accountStatus: string;
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
  const [copiedId, setCopiedId] = useState(false);
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
      dateLabel(properties.startedAt ?? properties.oldestSaveAt)
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
  const historyHint = !properties
    ? null
    : !properties.startedAt
      ? 'The original creation date is no longer recorded; the oldest retained save is shown.'
      : !properties.branchedFrom
        ? 'A duplicated project keeps the save history of its original.'
        : null;

  const storage: Row[] = [];
  const technical: Row[] = [];
  if (properties) {
    storage.push([
      'Project data size',
      formatProjectBytes(
        properties.documentBytes + properties.referencedSourceBytes
      )
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
        aria-label={copiedId ? 'Copied project ID' : 'Copy project ID'}
        title={copiedId ? 'Copied' : 'Copy'}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(project.projectId)
            .then(() => setCopiedId(true))
            .catch(() => setCopiedId(false));
        }}
      >
        {copiedId ? (
          <Check size={12} aria-hidden="true" />
        ) : (
          <Copy size={12} aria-hidden="true" />
        )}
      </button>
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
          <PropertySection title="Library" rows={library} />
          <PropertySection title="History" rows={history} hint={historyHint} />
          {storage.length > 0 && (
            <PropertySection
              title="Storage"
              rows={storage}
              hint={`Saved model data and undo history, embedded files included${
                properties?.referencedSourceBytes
                  ? '; each referenced source file counts once'
                  : ''
              }. Excludes geometry previews, thumbnails, backups and separate save-point snapshots.`}
            />
          )}
          <PropertySection title="Technical" rows={technical} />
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

type Row = [string, ReactNode];

function PropertySection({
  title,
  rows,
  hint
}: {
  title: string;
  rows: Row[];
  hint?: string | null;
}) {
  const headingId = useId();
  return (
    <section className="project-properties-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      <dl className="project-properties-list">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {hint && <p className="project-properties-hint">{hint}</p>}
    </section>
  );
}
