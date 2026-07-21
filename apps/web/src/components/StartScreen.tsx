import { useEffect, useState } from 'react';
import { FolderOpen, GraduationCap, Plus, Settings } from 'lucide-react';
import type { ProjectSummary, UnitSystem } from '@openzcad/shared';
import type { DemoDefinition } from '../lib/demos';
import { BrandMark } from './BrandMark';

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
}

export function StartScreen({
  projects,
  status,
  busy,
  demos,
  defaultUnits,
  onCreate,
  onOpen,
  onOpenDemo,
  onOpenSettings
}: StartScreenProps) {
  const [name, setName] = useState('New Part');
  const [units, setUnits] = useState<UnitSystem>(defaultUnits);

  useEffect(() => {
    setUnits(defaultUnits);
  }, [defaultUnits]);

  const demoIds = new Set(demos.map((demo) => demo.projectId));
  const userProjects = projects.filter(
    (project) => !demoIds.has(project.projectId)
  );

  return (
    <div className="start-screen">
      <button
        className="start-settings-button icon-button"
        type="button"
        aria-label="Open settings"
        title="Settings (Ctrl+,)"
        onClick={onOpenSettings}
      >
        <Settings size={16} aria-hidden="true" />
      </button>
      <div className="start-card">
        <div className="start-brand">
          <BrandMark />
          <h1>OpenZCAD</h1>
          <span className="start-tagline">parametric cad in the browser</span>
        </div>

        <div className="start-section">
          <h2>Design revision demos</h2>
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
        </div>

        <form
          className="start-section"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && name.trim().length > 0) {
              onCreate(name.trim(), units);
            }
          }}
          onKeyDown={(event) => {
            // Enter creates from any field, including the units select.
            if (
              event.key === 'Enter' &&
              !(event.target instanceof HTMLButtonElement)
            ) {
              event.preventDefault();
              if (!busy && name.trim().length > 0) {
                onCreate(name.trim(), units);
              }
            }
          }}
        >
          <h2>New project</h2>
          <div className="field">
            <span>Project name</span>
            <input
              value={name}
              aria-label="Project name"
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field">
            <span>Units</span>
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
          </div>
          <button
            type="submit"
            className="primary wide"
            disabled={busy || name.trim().length === 0}
          >
            <Plus size={15} aria-hidden="true" />
            Create project
          </button>
        </form>

        {userProjects.length > 0 && (
          <div className="start-section">
            <h2>Open existing</h2>
            <div className="start-project-list">
              {userProjects.map((project) => (
                <button
                  key={project.projectId}
                  type="button"
                  disabled={busy}
                  onClick={() => onOpen(project.projectId)}
                >
                  <FolderOpen size={14} aria-hidden="true" />
                  <strong>{project.name}</strong>
                  <small>
                    rev {project.revisionCount} ·{' '}
                    {new Date(project.updatedAt).toLocaleDateString()}
                  </small>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="start-status">{status}</div>
      </div>
    </div>
  );
}
