import { useEffect, useState } from 'react';
import {
  ChevronDown,
  GraduationCap,
  Plus,
  Search,
  Settings,
  X
} from 'lucide-react';
import {
  MAX_PROJECT_NAME_LENGTH,
  type BodyRepresentation,
  type ProjectSummary,
  type UnitSystem
} from '@openzcad/shared';
import type { DemoDefinition } from '../lib/demos';
import { BrandMark } from './BrandMark';
import { PartThumbnail } from './PartThumbnail';

interface StartScreenProps {
  projects: ProjectSummary[];
  status: string;
  busy: boolean;
  demos: DemoDefinition[];
  defaultUnits: UnitSystem;
  onCreate(name: string, units: UnitSystem): void;
  onOpen(projectId: string): void;
  onOpenDemo(definition: DemoDefinition): void;
  onOpenSettings(): void;
  loadThumbnailBodies(project: ProjectSummary): Promise<BodyRepresentation[]>;
}

/**
 * How many saved parts the grid shows before it has to be expanded. Seven parts
 * plus the create tile fills roughly two rows at the widths the grid actually
 * settles on, which is enough to recognise recent work without the demos below
 * being pushed off the screen.
 */
const COLLAPSED_PROJECT_LIMIT = 7;

export function StartScreen({
  projects,
  status,
  busy,
  demos,
  defaultUnits,
  onCreate,
  onOpen,
  onOpenDemo,
  onOpenSettings,
  loadThumbnailBodies
}: StartScreenProps) {
  const [name, setName] = useState('New Part');
  const [units, setUnits] = useState<UnitSystem>(defaultUnits);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');

  // The server measures the trimmed name, so the form has to agree exactly or
  // it would block names the API accepts (or vice versa).
  const trimmedName = name.trim();
  const nameTooLong = trimmedName.length > MAX_PROJECT_NAME_LENGTH;
  const canCreate = !busy && trimmedName.length > 0 && !nameTooLong;

  useEffect(() => {
    setUnits(defaultUnits);
  }, [defaultUnits]);

  const demoIds = new Set(demos.map((demo) => demo.projectId));
  const userProjects = projects.filter(
    (project) => !demoIds.has(project.projectId)
  );

  const search = query.trim().toLowerCase();
  const matchingProjects = search
    ? userProjects.filter((project) =>
        project.name.toLowerCase().includes(search)
      )
    : userProjects;

  // A query is already a narrowing, so it shows every match and retires the
  // expand toggle — being told "3 of 40 match" and *still* having to expand to
  // see the third one would be absurd.
  const overflowCount = search
    ? 0
    : matchingProjects.length - COLLAPSED_PROJECT_LIMIT;
  const visibleProjects =
    expanded || overflowCount <= 0
      ? matchingProjects
      : matchingProjects.slice(0, COLLAPSED_PROJECT_LIMIT);

  return (
    <div className="start-screen">
      <header className="start-header">
        <BrandMark />
        <span className="start-header-name">OpenZCAD</span>
        <span className="start-tagline">parametric cad in the browser</span>
        <button
          className="start-settings-button icon-button"
          type="button"
          aria-label="Open settings"
          title="Settings (Ctrl+,)"
          onClick={onOpenSettings}
        >
          <Settings size={16} aria-hidden="true" />
        </button>
      </header>

      <div className="start-body">
        <section className="start-section">
          <div className="start-section-head">
            <h2>Your parts</h2>
            <span className="start-section-note">
              {userProjects.length === 0
                ? 'nothing saved yet'
                : search
                  ? `${matchingProjects.length} of ${userProjects.length} match`
                  : `${userProjects.length} ${
                      userProjects.length === 1 ? 'project' : 'projects'
                    }`}
            </span>
            {userProjects.length > 0 && (
              <div className="start-search">
                <Search size={13} aria-hidden="true" />
                <input
                  value={query}
                  type="text"
                  aria-label="Search parts"
                  placeholder="Search parts…"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && query) {
                      // Escape belongs to the field while it has a query;
                      // swallowing it stops the app's Escape ladder from also
                      // reacting to a keystroke the user aimed here.
                      event.stopPropagation();
                      setQuery('');
                    }
                  }}
                />
                {query && (
                  <button
                    type="button"
                    className="start-search-clear"
                    aria-label="Clear search"
                    onClick={() => setQuery('')}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="start-tile-grid">
            <form
              className="start-tile start-tile-new"
              onSubmit={(event) => {
                event.preventDefault();
                if (canCreate) {
                  onCreate(trimmedName, units);
                }
              }}
              onKeyDown={(event) => {
                // Enter creates from any field, including the units select.
                if (
                  event.key === 'Enter' &&
                  !(event.target instanceof HTMLButtonElement)
                ) {
                  event.preventDefault();
                  if (canCreate) {
                    onCreate(trimmedName, units);
                  }
                }
              }}
            >
              <span className="start-tile-new-head">
                <Plus size={15} aria-hidden="true" />
                New part
              </span>
              <input
                value={name}
                aria-label="Project name"
                autoFocus
                aria-invalid={nameTooLong || undefined}
                aria-describedby={nameTooLong ? 'project-name-error' : undefined}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setName(event.target.value)}
              />
              {nameTooLong && (
                <small
                  id="project-name-error"
                  className="field-error"
                  role="alert"
                >
                  Project name must be at most {MAX_PROJECT_NAME_LENGTH}{' '}
                  characters.
                </small>
              )}
              <select
                value={units}
                aria-label="Unit system"
                onChange={(event) => setUnits(event.target.value as UnitSystem)}
              >
                <option value="mm">Millimeters</option>
                <option value="cm">Centimeters</option>
                <option value="m">Meters</option>
                <option value="inch">Inches</option>
              </select>
              <button type="submit" className="primary wide" disabled={!canCreate}>
                Create project
              </button>
            </form>

            {visibleProjects.map((project) => (
              <button
                key={project.projectId}
                type="button"
                className="start-tile start-tile-project"
                disabled={busy}
                onClick={() => onOpen(project.projectId)}
              >
                <span className="start-tile-thumb">
                  <PartThumbnail
                    project={project}
                    loadBodies={loadThumbnailBodies}
                  />
                </span>
                <strong className="start-tile-name">{project.name}</strong>
                <small className="start-tile-meta">
                  rev {project.revisionCount} ·{' '}
                  {new Date(project.updatedAt).toLocaleDateString()}
                </small>
              </button>
            ))}
          </div>

          {search && matchingProjects.length === 0 && (
            <p className="start-no-matches" role="status">
              No parts match “{query.trim()}”.
              <button type="button" onClick={() => setQuery('')}>
                Clear search
              </button>
            </p>
          )}

          {overflowCount > 0 && (
            <button
              type="button"
              className="start-expand"
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={expanded ? 'is-open' : undefined}
              />
              {expanded
                ? 'Show fewer parts'
                : `Show ${overflowCount} more ${
                    overflowCount === 1 ? 'part' : 'parts'
                  }`}
            </button>
          )}
        </section>

        <section className="start-section">
          <div className="start-section-head">
            <h2>Design revision demos</h2>
            <span className="start-section-note">
              walk a part through revisions A → C
            </span>
          </div>
          <div className="demo-list">
            {demos.map((demo) => (
              <button
                key={demo.key}
                type="button"
                className="demo-card"
                disabled={busy}
                onClick={() => onOpenDemo(demo)}
              >
                <span className="demo-card-head">
                  <GraduationCap size={14} aria-hidden="true" />
                  <strong>{demo.name.replace('Demo · ', '')}</strong>
                </span>
                <span className="demo-card-tagline">{demo.tagline}</span>
                <span className="demo-card-revs">
                  {demo.revisions.map((revision) => (
                    <span key={revision} className="demo-rev">
                      {revision}
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <footer className="start-foot">
        <span className="start-status">{status}</span>
      </footer>
    </div>
  );
}
