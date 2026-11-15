import { useMemo, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  assemblyInterferenceOperands,
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
import { describeInterference } from '../../lib/assembly/interferenceUi';

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
 */
export function AssemblyInterferenceSection({
  document,
  check,
  onStatus
}: {
  document: ProjectDocument;
  check: CheckInterference;
  onStatus(message: string): void;
}) {
  const [state, setState] = useState<CheckState>({ kind: 'idle' });
  const [openPair, setOpenPair] = useState<string | null>(null);
  const run = useRef(0);
  const selected = useAssemblyRuntime((s) => s.selectedComponentIds);
  const set = document.assembly;
  const { operands, missing } = useMemo(
    () => assemblyInterferenceOperands(document),
    [document]
  );
  const key = `${document.version}:${JSON.stringify(operands)}`;
  const names = new Map(set?.components.map((c) => [c.id, c.name]) ?? []);
  const name = (id: string) => names.get(id) ?? 'Removed part';
  const enough = operands.length >= 2;

  const start = () => {
    const token = ++run.current;
    setState({ kind: 'running', key });
    setOpenPair(null);
    check(document, operands).then(
      (report) => {
        if (run.current !== token) return;
        // Components the main thread could not resolve are missing too.
        const merged = {
          ...report,
          missing: [...new Set([...missing, ...report.missing])]
        };
        setState({ kind: 'done', key, report: merged });
        const summary = summarizeInterference(merged);
        onStatus(
          summary.interfering > 0
            ? `Interference: ${plural(summary.interfering, 'pair')} of parts overlap.`
            : summary.unknown > 0
              ? `Interference: no overlap found, but ${plural(summary.unknown, 'pair')} could not be checked exactly.`
              : 'Interference: no parts overlap.'
        );
      },
      (error: unknown) => {
        if (run.current !== token) return;
        const message =
          error instanceof Error ? error.message : 'The check failed.';
        setState({ kind: 'failed', key, message });
        onStatus(`Interference check failed: ${message}`);
      }
    );
  };

  const stale = state.kind !== 'idle' && state.key !== key;
  const report = state.kind === 'done' ? state.report : null;
  const summary = report ? summarizeInterference(report) : null;
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
                  ? summary.interfering > 0
                    ? `${plural(summary.interfering, 'pair')} overlap.`
                    : summary.unknown > 0
                      ? 'No overlap found in the pairs checked exactly.'
                      : 'No parts overlap.'
                  : 'Checks every pair of parts as assembled, with the exact kernel.'}
        </p>
        <button
          type="button"
          className="assembly-link-button"
          disabled={!enough || state.kind === 'running'}
          onClick={start}
          title="Exact pairwise check of the assembled parts"
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
    </div>
  );
}
