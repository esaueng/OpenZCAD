import { useState } from 'react';
import { FolderOpen, Plus } from 'lucide-react';
import type { ProjectSummary, UnitSystem } from '@openzcad/shared';
import { BrandMark } from './BrandMark';

interface StartScreenProps {
  projects: ProjectSummary[];
  status: string;
  busy: boolean;
  onCreate(name: string, units: UnitSystem): void;
  onOpen(projectId: string): void;
}

export function StartScreen({
  projects,
  status,
  busy,
  onCreate,
  onOpen
}: StartScreenProps) {
  const [name, setName] = useState('New Part');
  const [units, setUnits] = useState<UnitSystem>('mm');

  return (
    <div className="start-screen">
      <div className="start-card">
        <div className="start-brand">
          <BrandMark />
          <h1>OpenZCAD</h1>
          <span className="start-tagline">parametric cad in the browser</span>
        </div>

        <div className="start-section">
          <h2>New project</h2>
          <div className="field">
            <span>Project name</span>
            <input
              value={name}
              aria-label="Project name"
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
            type="button"
            className="primary wide"
            disabled={busy || name.trim().length === 0}
            onClick={() => onCreate(name.trim(), units)}
          >
            <Plus size={15} aria-hidden="true" />
            Create project
          </button>
        </div>

        {projects.length > 0 && (
          <div className="start-section">
            <h2>Open existing</h2>
            <div className="start-project-list">
              {projects.map((project) => (
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
