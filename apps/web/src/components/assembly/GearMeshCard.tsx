import { useMemo, type ReactNode } from 'react';
import { X } from 'lucide-react';
import {
  isGearMeshRefusal,
  type GearMeshSolution,
  type ProjectDocument
} from '@openzcad/shared';
import type { AssemblyExecute } from '../../lib/assembly/assembleWorkspace';
import {
  assemblyRuntime,
  useAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import {
  createGearCouplingFromSetup,
  defaultGearCarrier,
  gearBaseDrive,
  gearCarrierChoices,
  gearCouplingPlan
} from '../../lib/assembly/gearCoupling';
import {
  gearComponentIds,
  type GearMeshDraft,
  type GearMeshMotion
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
 * pressure angle, ratio and play, or why the pair cannot mesh. Place saves
 * either a rigid joint that holds the second gear there, or (AS02 gear
 * coupling) a joint per gear on the part they are mounted on and the
 * coupling that moves them together. Loaded lazily by the Assembly panel:
 * the entry chunk keeps only `gearMeshEntry`.
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
  const coupled = draft.motion === 'coupled';
  const result = useMemo(
    () =>
      !context
        ? { error: 'This project has no assembly.' }
        : coupled
          ? gearCouplingPlan(context, draft, {
              baseJointId: 'gear-mesh-preview-base',
              jointId: 'gear-mesh-preview',
              couplingId: 'gear-mesh-preview-coupling'
            })
          : gearMeshJoint(context, draft, 'gear-mesh-preview'),
    [context, coupled, draft]
  );
  if (!context) return null;
  const gearIds = new Set(gearComponentIds(context));
  const gears = context.set.components.filter((c) => gearIds.has(c.id));
  const base = gears.find((c) => c.id === draft.baseId);
  const moving = gears.find((c) => c.id === draft.movingId);
  const units = unitLabel('length', document.units);
  const rackPair = [draft.baseId, draft.movingId].some((id) => {
    const gear = id ? context.gearOf(id) : null;
    return !!gear && !isGearMeshRefusal(gear) && gear.gearType === 'rack';
  });
  // The first gear's own joint decides the mount; else the user chooses it.
  const drive = coupled ? gearBaseDrive(context, draft.baseId) : null;
  const carriers = coupled ? gearCarrierChoices(context, draft) : [];
  const carrierId = draft.carrierId ?? defaultGearCarrier(context, draft);
  const carrierName = (id: string | null) =>
    context.set.components.find((c) => c.id === id)?.name ?? 'the mount';
  const plan = 'coupling' in result ? result : null;

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
                // The mount is chosen among the other parts: choose again.
                carrierId: null,
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
          {base &&
          !base.grounded &&
          'groundBase' in result &&
          result.groundBase ? (
            <span className="assembly-muted">
              Not fixed yet — Place fixes it in place.
            </span>
          ) : null}
          {base && plan?.releaseBase ? (
            <span className="assembly-muted">
              Fixed now — Place lets it move on its own joint.
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
                movingId: event.currentTarget.value,
                carrierId: null
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
            Placed beside it with mid-faces level and teeth between teeth.
          </span>
        </Step>
        <Step index={3} title="Motion">
          <select
            className="assembly-select"
            aria-label="How the pair moves"
            value={coupled ? 'coupled' : 'fixed'}
            onChange={(event) =>
              assemblyRuntime.updateGearMesh({
                motion: event.currentTarget.value as GearMeshMotion
              })
            }
          >
            <option value="fixed">Fixed together</option>
            <option value="coupled">
              {rackPair ? 'Move together' : 'Turn together'}
            </option>
          </select>
          {!coupled ? (
            <span className="assembly-muted">
              The pair stays fixed together. Choose{' '}
              {rackPair ? 'Move together' : 'Turn together'} to link their
              motion.
            </span>
          ) : drive ? (
            <span className="assembly-muted">
              {base?.name ?? 'The first gear'} already moves on{' '}
              {drive.jointName}; {moving?.name ?? 'its mate'} joins{' '}
              {carrierName(drive.carrierId)} and follows it.
            </span>
          ) : (
            <>
              {carriers.length > 0 ? (
                <select
                  className="assembly-select"
                  aria-label="Part the gears are mounted on"
                  value={carrierId ?? ''}
                  onChange={(event) =>
                    assemblyRuntime.updateGearMesh({
                      carrierId: event.currentTarget.value
                    })
                  }
                >
                  {carriers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <span className="assembly-muted">
                {plan?.groundCarrier
                  ? `Each gets its own joint on ${carrierName(plan.carrierId)}, which Place fixes in place. Moving one moves the other.`
                  : 'Each gets its own joint on the part they are mounted on. Moving one moves the other.'}
              </span>
            </>
          )}
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
            (coupled ? createGearCouplingFromSetup : createGearMeshFromSetup)(
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
