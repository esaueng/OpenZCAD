import { useId, useRef } from 'react';
import { Check, Image as ImageIcon, X } from 'lucide-react';
import type { ProjectSummary } from '@openzcad/shared';
import { useModalFocus } from '../lib/useModalFocus';
import { PartThumbnail } from './PartThumbnail';

/**
 * Picks which part's preview stands for a folder on the library shelf. The
 * choice is the folder's, not the part's: nothing about the part changes.
 */
export function FolderCoverDialog({
  folderName,
  members,
  coverProjectId,
  thumbnailAccountId,
  loadThumbnail,
  publishThumbnail,
  onChoose,
  onClose
}: {
  folderName: string;
  members: ProjectSummary[];
  coverProjectId: string | undefined;
  thumbnailAccountId?: string | null;
  loadThumbnail(project: ProjectSummary): Promise<string | null | undefined>;
  publishThumbnail(project: ProjectSummary): Promise<string | null | undefined>;
  onChoose(projectId: string): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  useModalFocus(ref, { autoFocus: true });
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="folder-cover-dialog"
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
            <ImageIcon size={18} aria-hidden="true" />
            Cover for {folderName}
          </h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close cover picker"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        {members.length === 0 ? (
          <p className="folder-cover-empty">
            This folder has no parts yet. Drop a part on it first.
          </p>
        ) : (
          <div
            className="folder-cover-grid"
            role="radiogroup"
            aria-label="Folder cover"
          >
            {members.map((project) => {
              const chosen = project.projectId === coverProjectId;
              return (
                <button
                  key={project.projectId}
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  className={
                    chosen
                      ? 'folder-cover-option is-chosen'
                      : 'folder-cover-option'
                  }
                  onClick={() => {
                    onChoose(project.projectId);
                    onClose();
                  }}
                >
                  <span className="start-tile-thumb">
                    <PartThumbnail
                      project={project}
                      accountId={thumbnailAccountId}
                      loadThumbnail={loadThumbnail}
                      publishThumbnail={publishThumbnail}
                    />
                  </span>
                  <span className="folder-cover-name" title={project.name}>
                    {chosen && <Check size={12} aria-hidden="true" />}
                    {project.name}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
