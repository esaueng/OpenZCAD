import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Info, LoaderCircle, X } from 'lucide-react';
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
  const rows: Array<[string, ReactNode]> = [
    [
      'Project name',
      onRename ? (
        <span key="name" className="project-properties-name">
          <input
            value={nameDraft}
            aria-label="Project name"
            aria-invalid={nameProblem ? true : undefined}
            aria-describedby={nameProblem || nameTaken ? nameHintId : undefined}
            maxLength={MAX_PROJECT_NAME_LENGTH}
            disabled={renaming}
            onChange={(event) => setNameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void commitName();
              } else if (event.key === 'Escape' && nameDraft !== savedName) {
                // The first Escape puts the name back; the next closes.
                event.preventDefault();
                event.stopPropagation();
                setNameDraft(savedName);
              }
            }}
            onBlur={() => void commitName()}
          />
          {(nameProblem || nameTaken) && (
            <small id={nameHintId} role="status">
              {nameProblem ??
                `Another project is already called “${nameTaken}”.`}
            </small>
          )}
        </span>
      ) : (
        savedName
      )
    ],
    ['Shelf', shelf],
    ['Pinned', organization.pinned ? 'Yes' : 'No'],
    ['Account copy', accountStatus],
    ['Last edited', dateLabel(properties?.updatedAt ?? project.updatedAt)],
    ['Save points', properties?.savePoints ?? project.revisionCount]
  ];
  if (properties) {
    rows.push(
      [
        properties.branchedFrom
          ? 'Branched'
          : properties.startedAt
            ? 'First recorded save'
            : 'Oldest retained save',
        dateLabel(properties.startedAt ?? properties.oldestSaveAt)
      ],
      [
        'Project data size',
        formatProjectBytes(
          properties.documentBytes + properties.referencedSourceBytes
        )
      ],
      [
        'Details from',
        properties.source === 'device' ? 'This device' : 'My account'
      ],
      ['Document size', formatProjectBytes(properties.documentBytes)],
      [
        'Referenced source files',
        formatProjectBytes(properties.referencedSourceBytes)
      ],
      [
        'Units',
        {
          mm: 'Millimeters (mm)',
          cm: 'Centimeters (cm)',
          m: 'Meters (m)',
          inch: 'Inches (in)'
        }[properties.units]
      ],
      ['Document version', properties.documentVersion],
      ['Bodies', properties.bodies],
      ['Features', properties.features],
      ['Sketches', properties.sketches],
      ['Parameters', properties.parameters]
    );
    if (properties.branchedFrom) {
      rows.push([
        'Branched from',
        `${properties.branchedFrom.projectName} · ${properties.branchedFrom.checkpointReason}`
      ]);
    }
  }
  if (organization.archivedAt)
    rows.push(['Archived', dateLabel(organization.archivedAt)]);
  if (organization.deletedAt)
    rows.push(['Moved to trash', dateLabel(organization.deletedAt)]);
  // ADR-024 Phase 6: whether the assistant may read this encrypted project.
  if (project.storageFormat === PROJECT_STORAGE_FORMAT_E2EE_V1) {
    rows.push([
      'Assistant',
      <AssistantConsentSummary key="assistant" projectId={project.projectId} />
    ]);
  }
  rows.push(['Project ID', project.projectId]);

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
        {loading && (
          <p role="status">
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
            Loading project details…
          </p>
        )}
        {!loading && !properties && (
          <p role="alert">
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
          <p role="status">
            Showing an older device copy. The latest account details are
            unavailable.
          </p>
        )}
        <dl className="project-properties-list">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {properties && (
          <p className="project-properties-note">
            Document size includes saved model data and undo history. Referenced
            source files are counted once by content; embedded files are already
            included in the document size. These sizes exclude geometry
            previews, thumbnails, backups, and separate save-point snapshots.
            {!properties.startedAt &&
              ' The original creation date is no longer recorded; the oldest retained save is shown.'}
            {!properties.branchedFrom &&
              properties.startedAt &&
              ' Save history can predate a duplicated project.'}
          </p>
        )}
        <footer className="project-properties-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
