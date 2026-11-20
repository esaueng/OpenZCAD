import { useMemo, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  assemblySweepOverrides,
  planAssemblySweep,
  runAssemblySweep,
  sortSweptPairs,
  type AssemblySweepCheck,
  type AssemblySweepReport,
  type AssemblySweepSource,
  type AssemblySweptPair
} from '@openzcad/document-core';
import {
  ASSEMBLY_JOINT_DOFS,
  jointSweepRange,
  type AssemblyDofUnit,
  type ProjectDocument
} from '@openzcad/shared';
import { assemblyRuntime } from '../../lib/assembly/assemblyRuntime';
import { formatAssemblyValue } from '../../lib/assembly/assemblyUi';
import { describeInterference } from '../../lib/assembly/interferenceUi';
import { formatNumber } from '../../lib/model';

type SweepState =
  | { kind: 'idle' }
  | { kind: 'running'; key: string; pairs: number; positions: number }
  | {
      kind: 'done';
      key: string;
      source: AssemblySweepSource;
      unit: AssemblyDofUnit | 's';
      report: AssemblySweepReport;
    }
  | { kind: 'failed'; key: string; message: string };

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

const sourceValue = (source: AssemblySweepSource) =>
  source.kind === 'joint'
    ? `joint:${source.jointId}:${source.dof}`
    : `study:${source.studyId}`;

/**
 * AS04 interference through motion: the exact pairwise check at positions
 * along one joint's sweep or one motion study, for the pairs that move
 * relative to each other. Every figure says it was sampled: an overlap
 * shorter than one step can fall between positions, so nothing is called
 * clear outright. "Show" poses the assembly at a pair's worst position, as
 * a transient scrub that is never saved.
 */
export function AssemblyMotionInterference({
  document,
  check,
  onStatus
}: {
  document: ProjectDocument;
  check: AssemblySweepCheck;
  onStatus(message: string): void;
}) {
  const set = document.assembly;
  const sources = useMemo(() => {
    const out: { value: string; label: string; source: AssemblySweepSource }[] =
      [];
    for (const joint of set?.joints ?? []) {
      const units = ASSEMBLY_JOINT_DOFS[joint.kind];
      units.forEach((unit, dof) => {
        const range = jointSweepRange(joint, dof);
        if (!range) return;
        const source: AssemblySweepSource = {
          kind: 'joint',
          jointId: joint.id,
          dof
        };
        out.push({
          value: sourceValue(source),
          label: `${joint.name} (${formatAssemblyValue(range.min, unit, document.units)} to ${formatAssemblyValue(range.max, unit, document.units)})`,
          source
        });
      });
    }
    for (const study of set?.studies ?? []) {
      if (study.tracks.length === 0 || !(study.durationS > 0)) continue;
      const source: AssemblySweepSource = { kind: 'study', studyId: study.id };
      out.push({
        value: sourceValue(source),
        label: `${study.name} (${formatNumber(study.durationS)} s study)`,
        source
      });
    }
    return out;
  }, [set, document.units]);
  const [chosen, setChosen] = useState<string>('');
  const [state, setState] = useState<SweepState>({ kind: 'idle' });
  const [openPair, setOpenPair] = useState<string | null>(null);
  const run = useRef(0);
  const selected =
    sources.find((entry) => entry.value === chosen) ?? sources[0] ?? null;
  const names = new Map(set?.components.map((c) => [c.id, c.name]) ?? []);
  const name = (id: string) => names.get(id) ?? 'Removed part';
  const key = selected
    ? `${document.version}:${selected.value}:${JSON.stringify(set)}`
    : '';

  if (!set || sources.length === 0) return null;

  const format = (value: number, unit: AssemblyDofUnit | 's') =>
    unit === 's'
      ? `${formatNumber(Math.round(value * 100) / 100)} s`
      : formatAssemblyValue(value, unit, document.units);

  const start = () => {
    if (!selected) return;
    const planned = planAssemblySweep(document, selected.source);
    if (!planned.ok) {
      onStatus(planned.reason);
      return;
    }
    const plan = planned.plan;
    const token = ++run.current;
    setOpenPair(null);
    setState({
      kind: 'running',
      key,
      pairs: plan.pairs.length,
      positions: plan.positions.length
    });
    runAssemblySweep(document, plan, check).then(
      (report) => {
        if (run.current !== token) return;
        setState({
          kind: 'done',
          key,
          source: plan.source,
          unit: plan.unit,
          report
        });
        const overlapping = report.pairs.filter(
          (pair) => pair.overlaps.length > 0
        ).length;
        onStatus(
          overlapping > 0
            ? `Interference through motion: ${plural(overlapping, 'pair')} of parts overlap along ${selected.label}.`
            : `Interference through motion: no overlap at ${plural(report.checked, 'position')} checked along ${selected.label}.`
        );
      },
      (error: unknown) => {
        if (run.current !== token) return;
        const message =
          error instanceof Error ? error.message : 'The check failed.';
        setState({ kind: 'failed', key, message });
        onStatus(`Interference through motion failed: ${message}`);
      }
    );
  };

  const show = (source: AssemblySweepSource, at: number) => {
    const { overrides, drivers } = assemblySweepOverrides(set, source, at);
    assemblyRuntime.stop();
    assemblyRuntime.setOverrides(overrides, drivers);
  };

  const stale = state.kind !== 'idle' && state.key !== key;
  const done = state.kind === 'done' ? state : null;
  const attention = done
    ? sortSweptPairs(done.report.pairs).filter(
        (pair) =>
          pair.overlaps.length > 0 || pair.unknownAt.length > 0 || pair.touches
      )
    : [];
  const quiet = done ? done.report.pairs.length - attention.length : 0;

  const pairValue = (pair: AssemblySweptPair, unit: AssemblyDofUnit | 's') => {
    if (pair.overlaps.length > 0)
      return pair.overlaps
        .map((stretch) =>
          stretch.from === stretch.to
            ? `at ${format(stretch.from, unit)}`
            : `${format(stretch.from, unit)} to ${format(stretch.to, unit)}`
        )
        .join(', ');
    if (pair.unknownAt.length > 0)
      return `Unknown at ${plural(pair.unknownAt.length, 'position')}`;
    return 'Touching';
  };

  return (
    <div className="assembly-interference-motion">
      <h4 className="assembly-interference-motion-title">Through motion</h4>
      <select
        className="assembly-select"
        aria-label="Motion to check"
        value={selected?.value ?? ''}
        onChange={(event) => setChosen(event.target.value)}
      >
        {sources.map((entry) => (
          <option key={entry.value} value={entry.value}>
            {entry.label}
          </option>
        ))}
      </select>
      <div className="assembly-interference-head">
        {/* Not a second status role: the section's own status leads. */}
        <p className="assembly-muted" aria-live="polite">
          {state.kind === 'running'
            ? `Checking ${plural(state.pairs, 'moving pair')} at ${plural(state.positions, 'position')}…`
            : state.kind === 'failed'
              ? `The check failed: ${state.message}`
              : done
                ? attention.some((pair) => pair.overlaps.length > 0)
                  ? `${plural(
                      attention.filter((pair) => pair.overlaps.length > 0)
                        .length,
                      'pair'
                    )} overlap along the motion.`
                  : `No overlap at the ${plural(done.report.checked, 'position')} checked.`
                : 'Checks the parts that move against each other, at positions along the motion.'}
        </p>
        <button
          type="button"
          className="assembly-link-button"
          disabled={state.kind === 'running'}
          onClick={start}
          title="Exact pairwise check at positions along the motion"
        >
          {state.kind === 'idle' ? 'Sweep' : 'Sweep again'}
        </button>
      </div>
      {stale ? (
        <p className="assembly-interference-stale">
          <TriangleAlert size={12} aria-hidden="true" />
          Out of date: the parts, their motion or the model changed since this
          check.
        </p>
      ) : null}
      {done ? (
        <>
          {attention.length > 0 ? (
            <ul
              className="assembly-list"
              aria-label="Interference through motion"
            >
              {attention.map((pair) => {
                const id = `${pair.a}|${pair.b}`;
                const open = openPair === id;
                const tone =
                  pair.overlaps.length > 0
                    ? 'interference'
                    : pair.unknownAt.length > 0
                      ? 'unknown'
                      : 'contact';
                const value = pairValue(pair, done.unit);
                const worst = pair.worst;
                return (
                  <li key={id} className={`assembly-row is-${tone}`}>
                    <div className="assembly-row-line">
                      <button
                        type="button"
                        className="assembly-row-main"
                        aria-expanded={open}
                        aria-label={`${name(pair.a)} and ${name(pair.b)}: ${value}`}
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
                          className={`assembly-interference-value is-${tone}`}
                        >
                          {value}
                        </span>
                      </button>
                    </div>
                    {open ? (
                      <div className="assembly-interference-witness">
                        {worst ? (
                          <p>
                            {`Largest overlap at ${format(worst.at, done.unit)}: `}
                            {
                              describeInterference(
                                worst.verdict,
                                document.units
                              ).detail
                            }
                          </p>
                        ) : null}
                        {pair.unknownAt.length > 0 ? (
                          <p>
                            {`Not checked exactly at ${pair.unknownAt
                              .slice(0, 6)
                              .map((at) => format(at, done.unit))
                              .join(
                                ', '
                              )}${pair.unknownAt.length > 6 ? ', …' : ''}; not reported as clear there.`}
                          </p>
                        ) : null}
                        {worst ? (
                          <button
                            type="button"
                            className="assembly-link-button"
                            onClick={() => show(done.source, worst.at)}
                          >
                            {`Show at ${format(worst.at, done.unit)}`}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <p className="assembly-muted">
            {[
              quiet > 0
                ? `${plural(quiet, 'moving pair')} clear at every position checked`
                : '',
              done.report.still > 0
                ? `${plural(done.report.still, 'pair')} keep their places (see the check above)`
                : '',
              done.report.missing.length > 0
                ? `${plural(done.report.missing.length, 'part')} with no geometry to check`
                : ''
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <p className="assembly-muted">
            {`Sampled: ${plural(done.report.checked, 'position')}, every ${format(done.report.step, done.unit)}, with each start and end found to within ${format(done.report.resolution, done.unit)}. An overlap shorter than one step can fall between positions.`}
          </p>
        </>
      ) : null}
    </div>
  );
}
