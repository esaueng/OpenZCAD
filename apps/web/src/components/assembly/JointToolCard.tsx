import { useEffect, useMemo, useState } from 'react';
import { ArrowDownUp, RotateCw, X } from 'lucide-react';
import {
  ASSEMBLY_JOINT_DOFS,
  ASSEMBLY_JOINT_KINDS,
  jointAddError,
  solveAssembly,
  type AssemblyDofLimit,
  type AssemblyJointKind,
  type ProjectDocument
} from '@openzcad/shared';
import {
  assemblyRuntime,
  useAssemblyRuntime,
  type AssemblyFramePick,
  type AssemblyJointToolState
} from '../../lib/assembly/assemblyRuntime';
import { jointFromTool } from '../../lib/assembly/assemblyView';
import {
  defaultLimit,
  dofCountLabel,
  dofLabel,
  JOINT_KIND_META,
  suggestJointKind,
  unitSymbol
} from '../../lib/assembly/assemblyUi';
import { JointKindIcon } from './JointKindIcon';

export interface JointToolCardProps {
  document: ProjectDocument;
}

/**
 * The Joint tool (AS02): pick the part that moves, then its target, choose
 * the type, and Create. The viewport fills the picks; this card shows them,
 * suggests a type from what was picked, and refuses a pair already joined.
 */
export function JointToolCard({ document }: JointToolCardProps) {
  const tool = useAssemblyRuntime((s) => s.jointTool);
  if (!tool) return null;
  return <JointToolForm document={document} tool={tool} />;
}

function JointToolForm({
  document,
  tool
}: {
  document: ProjectDocument;
  tool: AssemblyJointToolState;
}) {
  const set = document.assembly;
  // Until a type is chosen by hand, the picks choose it.
  const [chosen, setChosen] = useState(false);
  const suggested =
    tool.child && tool.parent
      ? suggestJointKind(tool.child.source.kind, tool.parent.source.kind)
      : null;
  useEffect(() => {
    if (!chosen && suggested && suggested !== tool.kind)
      assemblyRuntime.updateJointTool({ kind: suggested, limits: undefined });
  }, [chosen, suggested, tool.kind]);

  const asBuilt = useMemo(() => {
    if (!set || tool.step !== 'review') return false;
    return (
      jointFromTool(solveAssembly(set), tool, 'preview', 'preview')?.asBuilt ??
      false
    );
  }, [set, tool]);
  const refusal =
    set && tool.child && tool.parent
      ? jointAddError(set, tool.parent.componentId, tool.child.componentId)
      : null;
  const canCreate = tool.step === 'review' && refusal === null;
  const units = ASSEMBLY_JOINT_DOFS[tool.kind];
  const componentName = (pick: AssemblyFramePick | null) =>
    pick
      ? (set?.components.find((c) => c.id === pick.componentId)?.name ??
        'A component')
      : null;

  const setLimit = (dof: number, limit: AssemblyDofLimit | null) =>
    assemblyRuntime.updateJointTool({
      limits: units.map((_, i) =>
        i === dof ? limit : (tool.limits?.[i] ?? null)
      )
    });

  const step = (
    end: 'child' | 'parent',
    index: number,
    title: string,
    prompt: string
  ) => {
    const pick = tool[end];
    const active = tool.step === end;
    return (
      <li
        className={`assembly-step${active ? ' is-active' : ''}${pick ? ' is-done' : ''}`}
        aria-current={active ? 'step' : undefined}
      >
        <span className="assembly-step-index">{index}</span>
        <span className="assembly-step-text">
          <span className="assembly-step-title">{title}</span>
          <span className="assembly-muted">
            {pick ? `${componentName(pick)} · ${pick.source.label}` : prompt}
          </span>
        </span>
        {pick ? (
          <button
            type="button"
            className="assembly-row-text-action"
            onClick={() => assemblyRuntime.repickJointEnd(end)}
          >
            Re-pick
          </button>
        ) : null}
      </li>
    );
  };

  return (
    <section className="assembly-joint-tool" aria-label="Add joint">
      <header className="assembly-joint-tool-header">
        <h2 className="assembly-panel-title">Add joint</h2>
        <button
          type="button"
          className="assembly-icon-button"
          aria-label="Close the joint tool"
          title="Cancel (Esc)"
          onClick={() => assemblyRuntime.closeJointTool()}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <ol className="assembly-steps">
        {step(
          'child',
          1,
          'Moving part',
          'Click a hole, face or edge on the part that moves.'
        )}
        {step(
          'parent',
          2,
          'Target',
          'Click where it attaches on another part.'
        )}
      </ol>

      <div className="assembly-kind-grid" role="group" aria-label="Joint type">
        {ASSEMBLY_JOINT_KINDS.map((kind: AssemblyJointKind) => (
          <button
            key={kind}
            type="button"
            className={`assembly-kind-option${tool.kind === kind ? ' is-active' : ''}`}
            aria-pressed={tool.kind === kind}
            title={JOINT_KIND_META[kind].hint}
            onClick={() => {
              setChosen(true);
              if (kind !== tool.kind)
                assemblyRuntime.updateJointTool({ kind, limits: undefined });
            }}
          >
            <JointKindIcon kind={kind} />
            <span className="assembly-kind-label">
              {JOINT_KIND_META[kind].label}
            </span>
            <span className="assembly-kind-dof">
              {ASSEMBLY_JOINT_DOFS[kind].length}
            </span>
            {suggested === kind ? (
              <span className="assembly-kind-suggested">Suggested</span>
            ) : null}
          </button>
        ))}
      </div>

      {tool.step === 'review' ? (
        asBuilt ? (
          <p className="assembly-notice">
            Already aligned — the moving part stays where you modelled it, and
            that pose becomes 0.
          </p>
        ) : (
          <div className="assembly-tool-row">
            <button
              type="button"
              className="secondary"
              aria-pressed={tool.flip}
              onClick={() =>
                assemblyRuntime.updateJointTool({ flip: !tool.flip })
              }
            >
              <ArrowDownUp size={13} aria-hidden="true" />
              Flip
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                assemblyRuntime.updateJointTool({
                  quarterTurns: (tool.quarterTurns + 1) % 4
                })
              }
            >
              <RotateCw size={13} aria-hidden="true" />
              Rotate 90°
            </button>
          </div>
        )
      ) : null}

      {units.length > 0 ? (
        <details className="assembly-tool-limits">
          <summary>
            Limits{' '}
            <span className="assembly-muted">
              optional · {dofCountLabel(units.length)}
            </span>
          </summary>
          {units.map((unit, dof) => {
            const limit = tool.limits?.[dof] ?? null;
            const label = dofLabel(tool.kind, dof);
            return (
              <div className="assembly-limit" key={dof}>
                <label className="assembly-check">
                  <input
                    type="checkbox"
                    checked={limit !== null}
                    onChange={(event) =>
                      setLimit(
                        dof,
                        event.currentTarget.checked
                          ? defaultLimit(unit, 0)
                          : null
                      )
                    }
                  />
                  <span>{label}</span>
                </label>
                {limit ? (
                  <span className="assembly-limit-range">
                    <LimitInput
                      label={`${label} minimum`}
                      value={limit.min}
                      onChange={(min) =>
                        setLimit(dof, { min, max: Math.max(min, limit.max) })
                      }
                    />
                    <span className="assembly-muted">to</span>
                    <LimitInput
                      label={`${label} maximum`}
                      value={limit.max}
                      onChange={(max) =>
                        setLimit(dof, { min: Math.min(max, limit.min), max })
                      }
                    />
                    <span className="assembly-unit">{unitSymbol(unit)}</span>
                  </span>
                ) : null}
              </div>
            );
          })}
        </details>
      ) : null}

      <label className="assembly-check">
        <input
          type="checkbox"
          checked={tool.preview}
          onChange={(event) =>
            assemblyRuntime.updateJointTool({
              preview: event.currentTarget.checked
            })
          }
        />
        <span>Preview motion</span>
      </label>

      {refusal ? (
        <p className="form-error" role="alert">
          {refusal}
        </p>
      ) : null}

      <div className="assembly-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => assemblyRuntime.closeJointTool()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!canCreate}
          title="Create (Enter)"
          onClick={() => assemblyRuntime.createJoint()}
        >
          Create
        </button>
      </div>
    </section>
  );
}

function LimitInput({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange(value: number): void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft.trim());
    if (draft.trim() !== '' && Number.isFinite(parsed) && parsed !== value)
      onChange(parsed);
    else setDraft(String(value));
  };
  return (
    <span className="assembly-number">
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
      />
    </span>
  );
}
