import {
  Archive,
  Copy,
  Database,
  Download,
  FileText,
  Info,
  MessageSquare,
  Share2,
  Upload
} from 'lucide-react';
import { Suspense, useId, useState, type ReactNode } from 'react';
import type { PaletteCommand } from '../CommandBar';
import { lazyWithStaleChunkNotice } from '../../lib/staleChunk';
import { DisplayUnitsRow } from '../TopBar';
import type { CompactProjectSheet } from './compactSlots';

// The File menu's clean-up, loaded as the File menu loads it: only where
// the owner's project offers one.
const UnusedMeshPayloads = lazyWithStaleChunkNotice(
  () => import('../UnusedMeshPayloads')
);

/** A row of the project sheet: a command-bar row or one of its own. */
export interface ProjectSheetRow {
  id: string;
  label: string;
  icon?: ReactNode;
  /** A quiet second line: a format, a size. */
  detail?: string;
  disabledReason?: string | null;
  run(): void;
}

/**
 * Where each File menu action sits on the project sheet. A File row this
 * list does not name still shows, under Other, so nothing the File menu
 * offers is ever left out.
 */
const GROUPS: readonly { title: string; ids: readonly string[] }[] = [
  { title: 'Revisions', ids: ['file-save', 'file-save-named'] },
  {
    title: 'Export',
    ids: [
      'file-export-step',
      'file-export-iges',
      'file-export-mesh',
      'file-export-cnc-layout',
      'file-export-image',
      'file-export-face-dxf',
      'file-export-flat-pattern',
      'file-export-project'
    ]
  },
  {
    title: 'Import',
    ids: ['file-import', 'file-import-project', 'file-insert-project']
  }
];

/** Rows the sheet draws in its own way, or the header already offers. */
const DRAWN_ELSEWHERE = new Set([
  'project-rename',
  'project-duplicate',
  'file-home',
  'file-display-units-mm',
  'file-display-units-cm',
  'file-display-units-m',
  'file-display-units-inch'
]);

function SheetRows({
  label,
  rows,
  done
}: {
  label: string;
  rows: readonly ProjectSheetRow[];
  done(): void;
}) {
  const baseId = useId();
  if (rows.length === 0) return null;
  return (
    <ul className="compact-menu" aria-label={label}>
      {rows.map((row, index) => {
        const note = row.disabledReason ?? row.detail;
        // Named by its label; its format, size or reason is its description.
        const noteId = `${baseId}-${index}`;
        return (
          <li key={row.id}>
            <button
              type="button"
              className="compact-menu-row"
              data-sheet-row={row.id}
              disabled={Boolean(row.disabledReason)}
              title={row.disabledReason ?? undefined}
              aria-label={row.label}
              aria-describedby={note ? noteId : undefined}
              onClick={() => {
                done();
                row.run();
              }}
            >
              <span className="compact-menu-icon" aria-hidden="true">
                {row.icon ?? <FileText size={18} />}
              </span>
              <span className="compact-menu-label">{row.label}</span>
              {note ? (
                <small id={noteId} className="compact-menu-detail">
                  {note}
                </small>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="compact-sheet-group" aria-labelledby={id}>
      <h3 className="compact-sheet-group-title" id={id}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function fromCommand(command: PaletteCommand): ProjectSheetRow {
  return {
    id: command.id,
    label: command.label,
    icon: command.icon ?? <Download size={18} />,
    disabledReason: command.disabledReason ?? null,
    run: command.run
  };
}

/**
 * The rename field: the project's name, changed in place as the top bar's
 * name field changes it. Enter or Rename stores it; an unchanged or blank
 * name stores nothing.
 */
function RenameField({
  name,
  disabledReason,
  onRename
}: {
  name: string;
  disabledReason: string | null;
  onRename(name: string): void;
}) {
  const [draft, setDraft] = useState(name);
  const [base, setBase] = useState(name);
  // The name moved on (renamed here or elsewhere): the field follows it.
  if (base !== name) {
    setBase(name);
    setDraft(name);
  }
  const trimmed = draft.trim();
  const unchanged = trimmed === '' || trimmed === name;
  const disabled = Boolean(disabledReason);
  return (
    <form
      className="compact-rename"
      onSubmit={(event) => {
        event.preventDefault();
        if (!unchanged && !disabled) onRename(trimmed);
      }}
    >
      <input
        className="compact-rename-input"
        aria-label="Project name"
        value={draft}
        disabled={disabled}
        title={disabledReason ?? undefined}
        autoComplete="off"
        enterKeyHint="done"
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        type="submit"
        className="compact-rename-save"
        disabled={disabled || unchanged}
      >
        Rename
      </button>
    </form>
  );
}

/**
 * The project sheet (U12 slice 10): the project's name, properties,
 * sharing, comments, revisions, every File menu export and import, its
 * units and its stored files, with Duplicate project, which the regular
 * workspace offers only from the command bar.
 */
export function ProjectSheet({
  projectName,
  fileCommands,
  project,
  done
}: {
  projectName: string;
  fileCommands: readonly PaletteCommand[];
  project: CompactProjectSheet | null;
  /** Closes the sheet's pages before a row runs, as the More rows do. */
  done(): void;
}) {
  const byId = new Map(fileCommands.map((command) => [command.id, command]));
  const take = (id: string) => {
    const command = byId.get(id);
    return command ? fromCommand(command) : null;
  };
  const placed = new Set<string>(DRAWN_ELSEWHERE);
  const groups = GROUPS.map(({ title, ids }) => {
    const rows: ProjectSheetRow[] = [];
    for (const id of ids) {
      placed.add(id);
      if (id === 'file-export-iges') {
        if (project?.exportIges) {
          rows.push({
            id,
            label: 'Export IGES',
            icon: <Download size={18} />,
            disabledReason: project.exportIges.disabledReason,
            run: project.exportIges.run
          });
        }
        continue;
      }
      const row = take(id);
      if (row) rows.push(row);
    }
    return { title, rows };
  });
  const other = fileCommands
    .filter((command) => !placed.has(command.id))
    .map(fromCommand);
  const duplicate = take('project-duplicate');

  const about: ProjectSheetRow[] = [
    ...(project?.onProperties
      ? [
          {
            id: 'project-properties',
            label: 'Properties',
            icon: <Info size={18} />,
            run: project.onProperties
          }
        ]
      : []),
    ...(project?.share
      ? [
          {
            id: 'project-share',
            label: project.share.label,
            icon: <Share2 size={18} />,
            run: project.share.run
          }
        ]
      : []),
    ...(project?.onComments
      ? [
          {
            id: 'project-comments',
            label: 'Comments',
            icon: <MessageSquare size={18} />,
            run: project.onComments
          }
        ]
      : []),
    ...(duplicate ? [{ ...duplicate, icon: <Copy size={18} /> }] : [])
  ];

  const storage: ProjectSheetRow[] = [
    ...(project?.archiveLocalSources && project.archiveLocalSources.count > 0
      ? [
          {
            id: 'file-archive-local-sources',
            label: 'Archive local sources',
            icon: <Upload size={18} />,
            detail: `${project.archiveLocalSources.count} ${
              project.archiveLocalSources.count === 1 ? 'file' : 'files'
            } on this device only`,
            disabledReason: project.archiveLocalSources.disabledReason,
            run: project.archiveLocalSources.run
          }
        ]
      : []),
    ...(project?.onStorage
      ? [
          {
            id: 'account-storage',
            label: 'Account storage',
            icon: <Database size={18} />,
            run: project.onStorage
          }
        ]
      : []),
    ...(project?.storedFiles ?? []).map((file) => ({
      id: `stored-${file.id}`,
      label: file.name,
      icon: <Archive size={18} />,
      detail: file.detail,
      run: file.download
    }))
  ];

  return (
    <div className="compact-project-sheet">
      {project ? (
        <RenameField
          name={projectName}
          disabledReason={project.renameDisabledReason}
          onRename={project.onRename}
        />
      ) : null}
      <SheetRows label="Project" rows={about} done={done} />
      {groups.map(({ title, rows }) =>
        rows.length > 0 ? (
          <Group key={title} title={title}>
            <SheetRows label={title} rows={rows} done={done} />
          </Group>
        ) : null
      )}
      {project?.displayUnits ? (
        <Group title="Units">
          <div className="compact-units">
            <DisplayUnitsRow
              {...project.displayUnits}
              {...(project.displayUnits.onConvertStored
                ? {
                    onConvertStored: () => {
                      done();
                      project.displayUnits?.onConvertStored?.();
                    }
                  }
                : {})}
            />
          </div>
        </Group>
      ) : null}
      {other.length > 0 ? (
        <Group title="Other">
          <SheetRows label="Other" rows={other} done={done} />
        </Group>
      ) : null}
      <Group title="Stored files">
        {storage.length > 0 ? (
          <SheetRows label="Stored files" rows={storage} done={done} />
        ) : (
          <p className="compact-sheet-empty">No stored files yet.</p>
        )}
        {project?.meshCleanup ? (
          <Suspense fallback={null}>
            <UnusedMeshPayloads
              key={project.meshCleanup.document.projectId}
              {...project.meshCleanup}
            />
          </Suspense>
        ) : null}
      </Group>
    </div>
  );
}
