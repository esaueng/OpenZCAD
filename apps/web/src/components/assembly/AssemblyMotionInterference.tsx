import { useMemo, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  assemblySweepOverrides,
  planAssemblySweep,
  runAssemblySweep,
  sortSweptPairs,
  summarizeSweptPairs,
  type AssemblySweepCheck,
  type AssemblySweepReport,
  type AssemblySweepSource,
  type AssemblySweptPair
} from '@openzcad/document-core';
import {
  ASSEMBLY_JOINT_DOFS,
  coupledJointLimits,
  jointSweepRange,
  type AssemblyDofUnit,
  type ProjectDocument
} from '@openzcad/shared';
import { assemblyRuntime } from '../../lib/assembly/assemblyRuntime';
import { formatAssemblyValue } from '../../lib/assembly/assemblyUi';
import {
  checkedPartName,
  describeInterference,
  describeSweepSummary,
  describeSweepUnknown,
  SWEEP_HELD_NOTE,
  SWEEP_OUTDATED_STATUS
} from '../../lib/assembly/interferenceUi';
import { formatNumber } from '../../lib/model';

type SweepState =
  | { kind: 'idle' }
  | {
      kind: 'running';
      key: string;
      pairs: number;
      /** Pairs the motion holds away from rest: checked once each. */
      held: number;
      positions: number;
    }
  | {
      kind: 'done';
      key: string;
      source: AssemblySweepSource;
      unit: AssemblyDofUnit | 's';
      /** The motion as the picker named it when it was swept. */
      label: string;
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
 * relative to each other, and once for each pair the motion holds away from
 * its rest position. Every figure says it was sampled: an overlap
 * shorter than one step can fall between positions, so nothing is called
 * clear outright. "Show" poses the assembly at a pair's worst position, as
 * a transient scrub that is never saved.
 *
 * The summary line counts what was not decided as well as what overlaps: a
 * pair unknown at every position never reads as "no overlap" (#2183).
 *
 * A sweep that returns after the motion picked, the parts or the model
 * changed is shown as out of date, and its summary is not posted to the
 * workspace status as if current.
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
    if (!set) return out;
    for (const joint of set.joints) {
      const units = ASSEMBLY_JOINT_DOFS[joint.kind];
      units.forEach((unit, dof) => {
        // As Animate sweeps it: a coupled joint as far as its mates allow.
        const range = jointSweepRange(
          { kind: joint.kind, limits: coupledJointLimits(set, joint) },
          dof
        );
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
    for (const study of set.studies) {
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
  const key = selected
    ? `${document.version}:${selected.value}:${JSON.stringify(set)}`
    : '';
  // What a sweep that is still running is compared with when it returns.
  const current = useRef(key);
  current.current = key;

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
      held: plan.held.length,
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
          label: selected.label,
          report
        });
        // Of the motion and parts as they were when it started.
        onStatus(
          current.current === key
            ? describeSweepSummary(
                summarizeSweptPairs(report),
                report.checked,
                selected.label
              ).status
            : SWEEP_OUTDATED_STATUS
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

  /**
   * Poses a position the way the motion's own player shows it: a study at
   * its playhead with the study open (so a pose made there keys the
   * timeline, as a scrub does), a joint by its own value alone.
   */
  const show = (source: AssemblySweepSource, at: number) => {
    const known =
      source.kind === 'joint'
        ? set.joints.some((joint) => joint.id === source.jointId)
        : set.studies.some((study) => study.id === source.studyId);
    if (!known) {
      onStatus('That motion is no longer in the assembly; sweep again.');
      return;
    }
    const { overrides, drivers } = assemblySweepOverrides(set, source, at);
    assemblyRuntime.stop();
    if (source.kind === 'study') {
      assemblyRuntime.selectStudy(source.studyId);
      assemblyRuntime.setStudyTime(at);
    }
    assemblyRuntime.setOverrides(overrides, drivers);
  };

  const stale = state.kind !== 'idle' && state.key !== key;
  const done = state.kind === 'done' ? state : null;
  // As checked: a part in another configuration row is named with its row.
  const name = (id: string) =>
    checkedPartName(
      names.get(id) ?? 'Removed part',
      done?.report.configurations[id]
    );
  const attention = done
    ? sortSweptPairs(done.report.pairs).filter(
        (pair) =>
          pair.overlaps.length > 0 || pair.unknownAt.length > 0 || pair.touches
      )
    : [];
  const quiet = done
    ? done.report.pairs.filter((pair) => !attention.includes(pair))
    : [];
  const quietHeld = quiet.filter((pair) => pair.held).length;
  const quietMoving = quiet.length - quietHeld;

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
            ? `Checking ${[
                state.pairs > 0
                  ? `${plural(state.pairs, 'moving pair')} at ${plural(state.positions, 'position')}`
                  : '',
                state.held > 0
                  ? `${plural(state.held, 'pair')} held away from rest`
                  : ''
              ]
                .filter(Boolean)
                .join(', and ')}…`
            : state.kind === 'failed'
              ? `The check failed: ${state.message}`
              : done
                ? describeSweepSummary(
                    summarizeSweptPairs(done.report),
                    done.report.checked,
                    done.label
                  ).headline
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
                        {pair.held ? <p>{SWEEP_HELD_NOTE}</p> : null}
                        {pair.unknownAt.length > 0 ? (
                          <p>
                            {describeSweepUnknown(
                              pair.unknownAt
                                .slice(0, 6)
                                .map((at) => format(at, done.unit)),
                              pair.unknownAt.length > 6,
                              pair.unknownReasons
                            )}
                          </p>
                        ) : null}
                        {pair.overlaps.some(
                          (stretch) =>
                            stretch.fromWithin >
                              done.report.resolution + 1e-9 ||
                            stretch.toWithin > done.report.resolution + 1e-9
                        ) ? (
                          <p>
                            {`Positions that could not be checked exactly lie beside this overlap: ${pair.overlaps
                              .map(
                                (stretch) =>
                                  `it may start up to ${format(stretch.fromWithin, done.unit)} before ${format(stretch.from, done.unit)} and end up to ${format(stretch.toWithin, done.unit)} after ${format(stretch.to, done.unit)}`
                              )
                              .join('; ')}.`}
                          </p>
                        ) : null}
                        {worst && !stale ? (
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
              quietMoving > 0
                ? `${plural(quietMoving, 'moving pair')} clear at every position checked`
                : '',
              quietHeld > 0
                ? `${plural(quietHeld, 'pair')} held away from rest, clear where held`
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
            {`Sampled: ${plural(done.report.checked, 'position')}, every ${format(done.report.step, done.unit)}, with each start and end found to within ${format(done.report.resolution, done.unit)} where the positions beside it could be checked exactly. An overlap shorter than one step can fall between positions.`}
          </p>
        </>
      ) : null}
    </div>
  );
}
