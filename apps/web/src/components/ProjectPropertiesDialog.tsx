import { useEffect, useId, useRef, useState } from 'react';
import { Info, LoaderCircle, X } from 'lucide-react';
import { projectOrganization, type ProjectSummary } from '@openzcad/shared';
import {
  formatProjectBytes,
  type ProjectProperties
} from '../lib/projectProperties';
import { useModalFocus } from '../lib/useModalFocus';

export interface ProjectPropertiesDialogProps {
  project: ProjectSummary;
  accountStatus: string;
  loadProperties(project: ProjectSummary): Promise<ProjectProperties | null>;
  onClose(): void;
}

function dateLabel(value: string | undefined): string {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString()
    : 'Not recorded';
}

export function ProjectPropertiesDialog({
  project,
  accountStatus,
  loadProperties,
  onClose
}: ProjectPropertiesDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
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
  const shelf = { active: 'Parts', archived: 'Archive', deleted: 'Trash' }[
    organization.status
  ];
  const rows: Array<[string, string | number]> = [
    ['Project name', project.name],
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
  rows.push(['Project ID', project.projectId]);

  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="project-properties-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
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
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        {loading && (
          <p role="status">
            <LoaderCircle size={14} aria-hidden="true" />
            Loading project details…
          </p>
        )}
        {!loading && !properties && (
          <p role="alert">
            Project details could not be loaded.{' '}
            <button
              type="button"
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
          <button type="button" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
