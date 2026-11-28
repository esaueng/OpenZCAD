import { useEffect, useMemo, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  assemblyInterferenceOperands,
  modelContentHash,
  sortInterferencePairs,
  summarizeInterference
} from '@openzcad/document-core';
import type {
  AssemblyInterferenceOperand,
  AssemblyInterferenceReport,
  ProjectDocument
} from '@openzcad/shared';
import {
  assemblyRuntime,
  useAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import { assemblyViewLeavesRest } from '../../lib/assembly/assemblyView';
import {
  checkedPartName,
  describeInterference,
  describeInterferenceSummary,
  INTERFERENCE_OTHER_POSITION,
  INTERFERENCE_OUTDATED_STATUS
} from '../../lib/assembly/interferenceUi';
import { AssemblyMotionInterference } from './AssemblyMotionInterference';
import type { AssemblySweepCheck } from '@openzcad/document-core';

export type CheckInterference = (
  document: ProjectDocument,
  operands: AssemblyInterferenceOperand[]
) => Promise<AssemblyInterferenceReport>;

type CheckState =
  | { kind: 'idle' }
  | { kind: 'running'; key: string }
  | { kind: 'done'; key: string; report: AssemblyInterferenceReport }
  | { kind: 'failed'; key: string; message: string };

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * AS04: exact pairwise interference of the assembled parts. Check runs the
 * M09 clash query on every pair of components at their solved pose (never
 * the exploded view), in the geometry worker. The list leads with what needs
 * attention; a pair's witness opens under it and picks both parts on the
 * model. A result is tied to the model and poses it checked, and says so
 * when either has changed since.
 *
 * The pose checked is the saved one, the rest position, whatever the view
 * shows: every summary names it, and says so outright while a study, a
 * scrub, a sweep's "Show" or the exploded view draws the parts somewhere
 * else (#2154).
 *
 * A check that returns after its inputs changed is shown as out of date,
 * and its summary is not posted to the workspace status as if current. Its
 * inputs are the model's content (`modelContentHash`), not only the
 * document version: a model can be replaced at the same version. A check
 * that returns after this section is gone (Assemble was left) posts nothing.
 */
export function AssemblyInterferenceSection({
  document,
  check,
  checkSweep,
  onStatus
}: {
  document: ProjectDocument;
  check: CheckInterference;
  /** AS04 through motion; absent hides it. */
  checkSweep?: AssemblySweepCheck;
  onStatus(message: string): void;
}) {
  const [state, setState] = useState<CheckState>({ kind: 'idle' });
  const [openPair, setOpenPair] = useState<string | null>(null);
  const run = useRef(0);
  const selected = useAssemblyRuntime((s) => s.selectedComponentIds);
  const overrides = useAssemblyRuntime((s) => s.overrides);
  const placementOverrides = useAssemblyRuntime((s) => s.placementOverrides);
  const exploded = useAssemblyRuntime((s) => s.exploded);
  const explodeOverrides = useAssemblyRuntime((s) => s.explodeOverrides);
  const set = document.assembly;
  // Whether the view draws the parts away from the pose this check reads.
  const elsewhere = assemblyViewLeavesRest(set, {
    overrides,
    placementOverrides,
    exploded,
    explodeOverrides
  });
  const { operands, missing } = useMemo(
    () => assemblyInterferenceOperands(document),
    [document]
  );
  // The model a result is of: its content, whatever its version says.
  const model = useMemo(
    () =>
      `${document.projectId}:${document.version}:${modelContentHash(document)}`,
    [document]
  );
  const key = `${model}:${JSON.stringify(operands)}`;
  // What a check that is still running is compared with when it returns.
  // Read only while mounted: once the section is gone nothing is current,
  // and this would only ever hold what was current when it went.
  const current = useRef(key);
  current.current = key;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const names = new Map(set?.components.map((c) => [c.id, c.name]) ?? []);
  const enough = operands.length >= 2;

  const start = () => {
    const token = ++run.current;
    setState({ kind: 'running', key });
    setOpenPair(null);
    check(document, operands).then(
      (report) => {
        if (!mounted.current || run.current !== token) return;
        // Components the main thread could not resolve are missing too.
        const merged = {
          ...report,
          missing: [...new Set([...missing, ...report.missing])]
        };
        setState({ kind: 'done', key, report: merged });
        // Of the parts as they were when it started: not the current ones.
        onStatus(
          current.current === key
            ? describeInterferenceSummary(summarizeInterference(merged)).status
            : INTERFERENCE_OUTDATED_STATUS
        );
      },
      (error: unknown) => {
        if (!mounted.current || run.current !== token) return;
        const message =
          error instanceof Error ? error.message : 'The check failed.';
        setState({ kind: 'failed', key, message });
        onStatus(`Interference check failed: ${message}`);
      }
    );
  };

  const stale = state.kind !== 'idle' && state.key !== key;
  const report = state.kind === 'done' ? state.report : null;
  // What a sweep may take for the pairs its motion leaves at rest: a result
  // of the model and the positions as they are now, and no other.
  const currentRest = report && !stale ? report : null;
  const summary = report ? summarizeInterference(report) : null;
  // As checked: a part in another configuration row is named with its row.
  const name = (id: string) =>
    checkedPartName(
      names.get(id) ?? 'Removed part',
      report?.configurations?.[id]
    );
  const attention = report
    ? sortInterferencePairs(report.pairs).filter(
        (pair) =>
          pair.verdict.kind !== 'clear' || pair.verdict.touching === true
      )
    : [];

  return (
    <div className="assembly-interference">
      <div className="assembly-interference-head">
        <p className="assembly-muted" role="status">
          {!enough
            ? 'Add a second part to check for interference.'
            : state.kind === 'running'
              ? `Checking ${plural((operands.length * (operands.length - 1)) / 2, 'pair')} exactly…`
              : state.kind === 'failed'
                ? `The check failed: ${state.message}`
                : summary
                  ? `${describeInterferenceSummary(summary).headline}${
                      elsewhere ? ` ${INTERFERENCE_OTHER_POSITION}` : ''
                    }`
                  : 'Checks every pair of parts at the rest position, with the exact kernel.'}
        </p>
        <button
          type="button"
          className="assembly-link-button"
          disabled={!enough || state.kind === 'running'}
          onClick={start}
          title="Exact pairwise check of the parts at the rest position"
        >
          {state.kind === 'idle' ? 'Check' : 'Check again'}
        </button>
      </div>
      {stale ? (
        <p className="assembly-interference-stale">
          <TriangleAlert size={12} aria-hidden="true" />
          Out of date: the parts or their positions changed since this check.
        </p>
      ) : null}
      {report && summary ? (
        <>
          {attention.length > 0 ? (
            <ul className="assembly-list" aria-label="Interference">
              {attention.map((pair) => {
                const id = `${pair.a}|${pair.b}`;
                const text = describeInterference(pair.verdict, document.units);
                const open = openPair === id;
                const picked =
                  selected.includes(pair.a) && selected.includes(pair.b);
                return (
                  <li
                    key={id}
                    className={`assembly-row is-${text.tone}${picked ? ' is-selected' : ''}`}
                  >
                    <div className="assembly-row-line">
                      <button
                        type="button"
                        className="assembly-row-main"
                        aria-expanded={open}
                        aria-label={`${name(pair.a)} and ${name(pair.b)}: ${text.value}`}
                        onClick={() => {
                          setOpenPair(open ? null : id);
                          assemblyRuntime.selectComponents(
                            open ? [] : [pair.a, pair.b]
                          );
                        }}
                      >
                        <span className="assembly-row-name">
                          {name(pair.a)} · {name(pair.b)}
                        </span>
                        <span
                          className={`assembly-interference-value is-${text.tone}`}
                        >
                          {text.value}
                        </span>
                      </button>
                    </div>
                    {open ? (
                      <p className="assembly-interference-witness">
                        {text.detail}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <p className="assembly-muted">
            {[
              summary.clear > 0 ? `${plural(summary.clear, 'pair')} clear` : '',
              summary.touching > 0
                ? `${plural(summary.touching, 'pair')} touching`
                : '',
              summary.unknown > 0
                ? `${plural(summary.unknown, 'pair')} not checked exactly`
                : '',
              summary.missing > 0
                ? `${plural(summary.missing, 'part')} with no geometry to check`
                : ''
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </>
      ) : null}
      {checkSweep ? (
        <AssemblyMotionInterference
          document={document}
          model={model}
          rest={currentRest}
          check={checkSweep}
          onStatus={onStatus}
        />
      ) : null}
    </div>
  );
}
