import { useMemo, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { GearMeshSolution, ProjectDocument } from '@openzcad/shared';
import type { AssemblyExecute } from '../../lib/assembly/assembleWorkspace';
import {
  assemblyRuntime,
  useAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import {
  gearComponentIds,
  type GearMeshDraft
} from '../../lib/assembly/gearMesh';
import {
  createGearMeshFromSetup,
  gearMeshErrorText,
  gearMeshJoint
} from '../../lib/assembly/gearMeshJoint';
import { unitLabel } from '../../lib/measurements';
import { gearMeshCardContext } from './gearMeshEntry';

export interface GearMeshCardProps {
  document: ProjectDocument;
  execute: AssemblyExecute;
  onStatus(message: string): void;
}

/**
 * Place gears (M14 meshing-pair helper): pick the gear that stays put and
 * the one that meshes with it; the card shows the working centre distance,
 * pressure angle, ratio and play, or why the pair cannot mesh, and Place
 * saves a rigid joint that places the second gear there. Loaded lazily
 * by the Assembly panel: the entry chunk keeps only `gearMeshEntry`.
 */
export function GearMeshCard(props: GearMeshCardProps) {
  const draft = useAssemblyRuntime((s) => s.gearMesh);
  if (!draft) return null;
  return <GearMeshForm {...props} draft={draft} />;
}

function GearMeshForm({
  document,
  execute,
  onStatus,
  draft
}: GearMeshCardProps & { draft: GearMeshDraft }) {
  const context = useMemo(() => gearMeshCardContext(document), [document]);
  const result = useMemo(
    () =>
      context
        ? gearMeshJoint(context, draft, 'gear-mesh-preview')
        : { error: 'This project has no assembly.' },
    [context, draft]
  );
  if (!context) return null;
  const gearIds = new Set(gearComponentIds(context));
  const gears = context.set.components.filter((c) => gearIds.has(c.id));
  const base = gears.find((c) => c.id === draft.baseId);
  const units = unitLabel('length', document.units);

  return (
    <section className="assembly-joint-tool" aria-label="Place gears">
      <header className="assembly-joint-tool-header">
        <h2 className="assembly-panel-title">Place gears</h2>
        <button
          type="button"
          className="assembly-icon-button"
          aria-label="Close Place gears"
          title="Cancel (Esc)"
          onClick={() => assemblyRuntime.closeGearMesh()}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <ol className="assembly-steps">
        <Step index={1} title="Stays put">
          <select
            className="assembly-select"
            aria-label="Gear that stays put"
            value={draft.baseId ?? ''}
            onChange={(event) => {
              const baseId = event.currentTarget.value;
              assemblyRuntime.updateGearMesh({
                baseId,
                ...(baseId === draft.movingId
                  ? {
                      movingId: gears.find((c) => c.id !== baseId)?.id ?? null
                    }
                  : {})
              });
            }}
          >
            {gears.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {base && !base.grounded && 'joint' in result && result.groundBase ? (
            <span className="assembly-muted">
              Not fixed yet — Place fixes it in place.
            </span>
          ) : null}
        </Step>
        <Step index={2} title="Meshes with it">
          <select
            className="assembly-select"
            aria-label="Gear that meshes with it"
            value={draft.movingId ?? ''}
            onChange={(event) =>
              assemblyRuntime.updateGearMesh({
                movingId: event.currentTarget.value
              })
            }
          >
            {gears
              .filter((c) => c.id !== draft.baseId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <span className="assembly-muted">
            Placed beside it with mid-faces level and teeth between teeth. The
            pair stays fixed together; linked rotation is not available yet.
          </span>
        </Step>
      </ol>

      {'mesh' in result ? (
        <MeshReadout mesh={result.mesh} units={units} />
      ) : (
        <p className="form-error" role="alert">
          {gearMeshErrorText(result, units)}
        </p>
      )}

      <div className="assembly-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => assemblyRuntime.closeGearMesh()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={'error' in result}
          onClick={() =>
            createGearMeshFromSetup(
              { document, execute, onStatus },
              context,
              draft
            )
          }
        >
          Place
        </button>
      </div>
    </section>
  );
}

function round(value: number): string {
  return String(Number(value.toFixed(4)));
}

function MeshReadout({
  mesh,
  units
}: {
  mesh: GearMeshSolution;
  units: string;
}) {
  const rows: [string, string][] = [
    [
      mesh.pair === 'rack' ? 'Axis to pitch line' : 'Centre distance',
      `${round(mesh.centerDistance)} ${units}`
    ],
    ['Working pressure angle', `${round(mesh.workingPressureAngleDeg)}°`],
    mesh.travelPerTurn !== null
      ? ['Calculated travel per turn', `${round(mesh.travelPerTurn)} ${units}`]
      : [
          'Calculated turns per base turn',
          `${round(Math.abs(mesh.ratio ?? 0))}, ${
            (mesh.ratio ?? 0) < 0 ? 'the other way' : 'the same way'
          }`
        ],
    ['Backlash', `${round(mesh.backlash)} ${units}`]
  ];
  return (
    <dl className="assembly-gear-readout" aria-label="Mesh">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Step({
  index,
  title,
  children
}: {
  index: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="assembly-step is-done">
      <span className="assembly-step-index">{index}</span>
      <span className="assembly-step-text assembly-setup-field">
        <span className="assembly-step-title">{title}</span>
        {children}
      </span>
    </li>
  );
}
