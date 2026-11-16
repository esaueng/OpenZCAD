import type * as AnalysisUiTypes from './surfaceAnalysisUi';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  BodyId,
  ProjectDocument,
  SurfaceAnalysisReport,
  SurfaceAnalysisRequest
} from '@openzcad/shared';
import type { AnalysisOverlayDisplay } from '@openzcad/viewport/analysis-overlay';

type AnalysisUi = typeof AnalysisUiTypes;
let analysisUi: Promise<AnalysisUi> | undefined;
/**
 * The colouring and wording load on demand, with the first analysis: they
 * have no business in the entry chunk of a session that never turns one on.
 */
export const loadAnalysisUi = () =>
  (analysisUi ??= import('./surfaceAnalysisUi'));

export type AnalysisRunState =
  | { kind: 'running' }
  | { kind: 'done'; report: SurfaceAnalysisReport }
  | { kind: 'failed'; message: string };

export type RunSurfaceAnalysis = (
  document: ProjectDocument,
  bodyIds: BodyId[],
  request: SurfaceAnalysisRequest
) => Promise<SurfaceAnalysisReport>;

/** How long settings and edits settle before the kernel is asked again. */
export const ANALYSIS_SETTLE_MS = 250;

/**
 * What the kernel measures for a request: the settings that only change how
 * values are coloured (draft's minimum) are left out, so changing them
 * recolours the last answer instead of asking again.
 */
export function measuredPart(request: SurfaceAnalysisRequest): unknown {
  return { kind: request.kind, pull: request.pull };
}

/**
 * Runs the M09 analysis that is on against the bodies on screen, and hands
 * back the run's state and the overlay to draw. The overlay is withheld
 * whenever it would not describe what is drawn: while the model or the
 * bodies changed since it was measured, and while a preview stands in for
 * the built geometry.
 */
export function useSurfaceAnalysis({
  request,
  document,
  bodyIds,
  previewing,
  run
}: {
  request: SurfaceAnalysisRequest | null;
  document: ProjectDocument | null;
  bodyIds: readonly BodyId[];
  /** A stand-in or an unposed body is on screen instead of the build. */
  previewing: boolean;
  run: RunSurfaceAnalysis | undefined;
}): {
  state: AnalysisRunState | null;
  overlay: AnalysisOverlayDisplay | null;
} {
  const key =
    request && document && run
      ? JSON.stringify([
          document.projectId,
          document.version,
          bodyIds,
          measuredPart(request)
        ])
      : null;
  const [result, setResult] = useState<{
    key: string;
    state: AnalysisRunState;
  } | null>(null);
  const token = useRef(0);
  const latest = useRef({ request, document, bodyIds, run });
  latest.current = { request, document, bodyIds, run };

  useEffect(() => {
    if (key === null) {
      token.current += 1;
      return;
    }
    const mine = ++token.current;
    const timer = setTimeout(() => {
      const { request, document, bodyIds, run } = latest.current;
      if (!request || !document || !run) return;
      setResult({ key, state: { kind: 'running' } });
      run(document, [...bodyIds], request).then(
        (report) => {
          if (token.current !== mine) return;
          setResult({ key, state: { kind: 'done', report } });
        },
        (error: unknown) => {
          if (token.current !== mine) return;
          setResult({
            key,
            state: {
              kind: 'failed',
              message:
                error instanceof Error ? error.message : 'The kernel refused.'
            }
          });
        }
      );
    }, ANALYSIS_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [key]);

  const [ui, setUi] = useState<AnalysisUi | null>(null);
  useEffect(() => {
    if (key === null || ui) return;
    let live = true;
    loadAnalysisUi().then(
      (module) => {
        if (live) setUi(module);
      },
      () => {
        // A failed chunk load leaves the overlay off; the panel, loaded the
        // same way, reports the failure where it stands.
      }
    );
    return () => {
      live = false;
    };
  }, [key, ui]);

  const current = result !== null && result.key === key ? result.state : null;
  const report = current?.kind === 'done' ? current.report : null;
  const overlay = useMemo(
    () =>
      ui && report && request && !previewing
        ? ui.analysisOverlayFor(report, request)
        : null,
    [ui, report, request, previewing]
  );
  return {
    state: key === null ? null : (current ?? { kind: 'running' }),
    overlay
  };
}
