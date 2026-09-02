import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BodyRepresentation,
  ProjectDocument,
  TopologySelection,
  UnitSystem
} from '@openzcad/shared';
import type { PickDetail } from '@openzcad/viewport';
import { downloadText, exportFileStem } from '../lib/model';
import type {
  Measurement,
  MeasurementDisplayOptions,
  MeasurementMode,
  MeasurementTarget,
  MeasurementViewportAnnotation,
  RadialDisplay
} from '../lib/measurements';
/**
 * The measurement module's shape, for the deferred handle below. A type-only
 * namespace import is erased at build time exactly like the named ones above,
 * so naming the module here does not pull it back into the eager chunk.
 */
import type * as MeasurementModule from '../lib/measurements';
import { buildMeasurementRecord } from '../lib/measurementRecord';
import {
  EMPTY_MEASURE_SESSION,
  edgeRunIsTotalable,
  nextEdgeRun
} from '../lib/measureSession';
import {
  loadProjectMeasurements,
  saveProjectMeasurements
} from '../lib/localProjectStore';

export interface MeasurementWorkbenchInput {
  doc: ProjectDocument | null;
  /** View or Tweak mode: the only modes that can measure. */
  modelingLocked: boolean;
  exactGeometryReady: boolean;
  /** The committed exact projection; the only one allowed to refresh rows. */
  representations: Record<string, BodyRepresentation>;
  /** What the viewport draws right now, previews included; picks resolve here. */
  renderedRepresentations: Record<string, BodyRepresentation>;
  viewerBodies: BodyRepresentation[];
  setStatus(message: string): void;
}

/**
 * The measurement workbench: a view-only session that never enters document
 * history. Owns the pick state, the persisted per-project list and its
 * display options, the lazily loaded measurement library, and the derived
 * annotations — everything App used to hold at arm's length between the
 * viewport, the dock, and the store.
 */
export function useMeasurementWorkbench({
  doc,
  modelingLocked,
  exactGeometryReady,
  representations,
  renderedRepresentations,
  viewerBodies,
  setStatus
}: MeasurementWorkbenchInput) {
  /** View-only measurement session. None of this enters document/history. */
  const [measuring, setMeasuring] = useState(false);
  const [measurementMode, setMeasurementMode] =
    useState<MeasurementMode>('smart');
  const [measurementDraft, setMeasurementDraft] =
    useState<MeasurementTarget | null>(null);
  /**
   * Edges accumulated by Shift+Click for a running total. Owned here rather
   * than read from `selectedEdges`, which is what let measuring rewrite the
   * workspace's selection; the rules live in `measureSession.ts`.
   */
  const [measurementEdgeRun, setMeasurementEdgeRun] = useState<
    readonly TopologySelection[]
  >(EMPTY_MEASURE_SESSION.edgeRun);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  /** Advances whenever a persisted list replaces the in-memory measurement list. */
  const [measurementRestoreGeneration, setMeasurementRestoreGeneration] =
    useState(0);
  const applyStoredMeasurements = useCallback((restored: Measurement[]) => {
    setMeasurements(restored);
    setMeasurementRestoreGeneration((current) => current + 1);
  }, []);
  const [activeMeasurementId, setActiveMeasurementId] = useState<string | null>(
    null
  );
  const [measurementUnit, setMeasurementUnit] = useState<UnitSystem>('mm');
  const [measurementPrecision, setMeasurementPrecision] = useState(2);
  const [radialDisplay, setRadialDisplay] = useState<RadialDisplay>('diameter');
  /**
   * The project whose stored list has been answered, including the answer
   * "none". Until this matches the open project, writes stay disabled: an
   * empty initial render must never outrun a slow read and erase the record it
   * was still loading.
   */
  const [measurementHydratedProjectId, setMeasurementHydratedProjectId] =
    useState<string | null>(null);
  const measurementDisplay = useMemo<MeasurementDisplayOptions>(
    () => ({
      unit: measurementUnit,
      precision: measurementPrecision,
      radialDisplay
    }),
    [measurementPrecision, measurementUnit, radialDisplay]
  );

  // A measurement session belongs to one open project, not the application.
  //
  // The list is cleared first and then restored from storage, so a project
  // with no stored measurements lands empty rather than inheriting the last
  // project's. The restore is deliberately not awaited before clearing: an
  // in-flight read for the PREVIOUS project must not be able to land on this
  // one, which the id check inside the effect prevents.
  useEffect(() => {
    setMeasurements([]);
    setActiveMeasurementId(null);
    clearMeasurementPicks();
    setMeasurementHydratedProjectId(null);
    if (!doc) {
      return;
    }
    const projectId = doc.projectId;
    setMeasurementUnit(doc.units);
    setMeasurementPrecision(2);
    setRadialDisplay('diameter');
    let cancelled = false;
    void loadProjectMeasurements(projectId)
      .then((record) => {
        if (cancelled) {
          return;
        }
        if (record) {
          applyStoredMeasurements(record.measurements);
          setMeasurementUnit(record.display.unit);
          setMeasurementPrecision(record.display.precision);
          setRadialDisplay(record.display.radialDisplay);
        }
        setMeasurementHydratedProjectId(projectId);
      })
      .catch(() => {
        // Leave writes disabled for this project. Besides unavailable storage,
        // this includes a record from a newer build: writing the empty v1 list
        // over fields this build refused to read would be the data loss the
        // parser's forward-version guard exists to prevent.
      });
    return () => {
      cancelled = true;
    };
  }, [applyStoredMeasurements, doc?.projectId]);

  /**
   * Writes the measurement list back, debounced.
   *
   * Coalesced rather than written per pick because a Shift+Click run rewrites
   * the list on every click, and an IndexedDB put per click would serialise
   * the whole list each time for a result that is superseded a moment later.
   */
  useEffect(() => {
    if (!doc || measurementHydratedProjectId !== doc.projectId) {
      return;
    }
    const projectId = doc.projectId;
    const timeout = window.setTimeout(() => {
      void saveProjectMeasurements(
        buildMeasurementRecord(
          projectId,
          measurements,
          measurementDisplay,
          new Date().toISOString()
        )
      ).catch(() => {
        // Same as the read: a device that cannot store them still measures.
      });
    }, 400);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    doc?.projectId,
    measurementHydratedProjectId,
    measurements,
    measurementDisplay
  ]);

  /**
   * The measurement library, loaded on first entry to View mode.
   *
   * It is roughly nine kilobytes of derivation, formatting and export that
   * only View mode can reach, and importing it at the top of this file put all
   * of it in the eager entry chunk — which the bundle budget guards precisely
   * because it is what every visitor downloads before anything renders. Types
   * are erased at build time, so `import type` above costs nothing; only the
   * runtime import is deferred.
   *
   * Every consumer below therefore has to tolerate `null` for the frame or two
   * between entering View mode and the chunk arriving. That is a real state
   * rather than a formality: a fast picker can click before it lands, and the
   * pick is dropped rather than half-handled.
   *
   * This is the interim shape. The measure seam replaces it with a session
   * that owns this state outright instead of App holding it at arm's length.
   */
  const [measurementApi, setMeasurementApi] = useState<
    typeof MeasurementModule | null
  >(null);

  useEffect(() => {
    if (!modelingLocked || measurementApi) {
      return;
    }
    let cancelled = false;
    void import('../lib/measurements').then((module) => {
      if (!cancelled) {
        setMeasurementApi(module);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [modelingLocked, measurementApi]);

  useEffect(() => {
    if (!doc || !exactGeometryReady || !measurementApi) {
      return;
    }
    // Stored rows and worker bodies can arrive in either order. Re-resolve on
    // each authoritative arrival even when the document revision is equal;
    // the library's default short-circuit remains intact for other callers.
    // Only the committed exact projection is authoritative here: previewDoc is
    // transient and must never rewrite the persisted list. Hidden bodies stay
    // included because visibility does not invalidate their measurements.
    const bodies = Object.values(representations).filter(
      (body) => !body.consumed
    );
    setMeasurements((current) =>
      measurementApi.refreshMeasurements(current, bodies, doc.version, {
        force: true
      })
    );
  }, [
    representations,
    doc?.version,
    exactGeometryReady,
    measurementApi,
    measurementRestoreGeneration
  ]);

  function recordMeasurement(measurement: Measurement) {
    // Checked before the state update rather than inside it, so the refusal can
    // be reported. The list is capped rather than self-trimming: dropping the
    // oldest row to make room is data loss nobody was told about.
    if (!measurementApi) {
      return;
    }
    if (!measurementApi.canAppendMeasurement(measurements, measurement)) {
      setStatus(measurementApi.MEASUREMENT_LIMIT_MESSAGE);
      return;
    }
    setMeasurements((current) =>
      measurementApi.appendMeasurement(current, measurement)
    );
    setActiveMeasurementId(measurement.id);
    setMeasurementDraft(null);
    setStatus(`${measurement.label} measured.`);
  }

  /**
   * What measuring this pick WOULD report, without recording anything.
   *
   * A tool that only answers after you commit makes you record a row to find
   * out whether you picked the right thing, then delete it. The preview runs
   * the SAME derivation the click will run rather than a cheaper estimate that
   * could disagree with the number that lands.
   *
   * Null when there is nothing honest to say, which includes an ambiguous
   * pick: a hover is not the place to explain ADR-011, and a silent absence
   * beats a confident wrong number.
   */
  function previewMeasurement(
    selection: TopologySelection,
    point?: { x: number; y: number; z: number }
  ): string | null {
    if (!doc || !modelingLocked || !measuring || !measurementApi) {
      return null;
    }
    const body = renderedRepresentations[selection.bodyId];
    if (!body) {
      return null;
    }
    if (measurementMode === 'smart') {
      const measurement = measurementApi.createSmartMeasurement(
        body,
        selection,
        point,
        doc.version,
        doc.units
      );
      return measurement
        ? measurementApi.formatMeasurement(measurement, measurementDisplay)
            .value
        : null;
    }
    const target = measurementApi.measurementTargetFromSelection(
      body,
      selection,
      point,
      measurementMode
    );
    if (!target?.point) {
      return null;
    }
    // The first of two picks has nothing to measure against yet, so it names
    // the target rather than guessing at a distance.
    if (!measurementDraft) {
      return target.label;
    }
    const measurement =
      measurementMode === 'distance'
        ? measurementApi.createDistanceMeasurement(
            measurementDraft,
            target,
            doc.version,
            doc.units
          )
        : measurementApi.createAngleMeasurement(
            measurementDraft,
            target,
            doc.version,
            doc.units
          );
    return measurement
      ? measurementApi.formatMeasurement(measurement, measurementDisplay).value
      : null;
  }

  /**
   * Abandons whatever pick was in progress: the two-pick draft and the running
   * edge total both. Not called after a measurement is recorded — a run has to
   * survive that, or a fourth Shift+Click could not extend a total of three.
   */
  function clearMeasurementPicks() {
    setMeasurementDraft(null);
    setMeasurementEdgeRun(EMPTY_MEASURE_SESSION.edgeRun);
  }

  /**
   * Measures a pick, and reports whether it consumed it.
   *
   * The return value is the point. This used to be called for its side effects
   * and fall straight through into sketch entry, direct manipulation, and the
   * selection update — so measuring an edge in View mode silently replaced
   * whatever a modelling session had selected, and the two features quietly
   * shared one piece of state.
   */
  function handleMeasurementPick(
    selection: TopologySelection,
    additive: boolean,
    detail?: PickDetail
  ): boolean {
    if (!doc || !modelingLocked || !measuring) {
      return false;
    }
    // One guard for the whole handler. Dropping a pick that lands before the
    // measurement chunk arrives is better than servicing half of it, and the
    // window is a frame or two on first entry to View mode only. It still
    // counts as consumed: falling through to selection would be the very
    // coupling this seam removes.
    if (!measurementApi) {
      setStatus('Measure is still loading. Try that pick again.');
      return true;
    }
    const body = renderedRepresentations[selection.bodyId];
    if (!body) {
      setStatus(
        'The selected body has no current exact projection to measure.'
      );
      return true;
    }
    const point = detail?.point;
    if (measurementMode === 'smart') {
      if (selection.kind === 'edge') {
        // The run lives in the measure session rather than in `selectedEdges`,
        // which is what let measuring rewrite the workspace's selection.
        const run = nextEdgeRun(measurementEdgeRun, selection, additive);
        setMeasurementEdgeRun(run);
        if (edgeRunIsTotalable(run)) {
          const total = measurementApi.createEdgeTotalMeasurement(
            viewerBodies,
            run,
            doc.version,
            doc.units
          );
          if (total) {
            recordMeasurement(total);
            return true;
          }
        }
      }
      const measurement = measurementApi.createSmartMeasurement(
        body,
        selection,
        point,
        doc.version,
        doc.units
      );
      if (measurement) {
        recordMeasurement(measurement);
      } else {
        setStatus(
          measurementApi.measurementSelectionFailure(body, selection) ??
            'That selection does not expose a trustworthy measurement.'
        );
      }
      return true;
    }
    const target = measurementApi.measurementTargetFromSelection(
      body,
      selection,
      point,
      measurementMode
    );
    if (!target?.point) {
      setStatus(
        measurementApi.measurementSelectionFailure(body, selection) ??
          (measurementMode === 'angle'
            ? 'Angle needs a straight edge, circular axis, or measured face direction.'
            : 'That selection does not expose a trustworthy measurement point.')
      );
      return true;
    }
    if (!measurementDraft) {
      setMeasurementDraft(target);
      setStatus(`${target.label} selected · pick the second target.`);
      return true;
    }
    const measurement =
      measurementMode === 'distance'
        ? measurementApi.createDistanceMeasurement(
            measurementDraft,
            target,
            doc.version,
            doc.units
          )
        : measurementApi.createAngleMeasurement(
            measurementDraft,
            target,
            doc.version,
            doc.units
          );
    if (measurement) {
      recordMeasurement(measurement);
    } else {
      setStatus(
        measurementMode === 'angle'
          ? 'Those targets do not provide two stable directions; the first target is still selected.'
          : 'Those targets could not produce a stable distance; the first target is still selected.'
      );
    }
    return true;
  }

  const measurementAnnotations = useMemo<
    MeasurementViewportAnnotation[]
  >(() => {
    if (!measurementApi) {
      return [];
    }
    const pinned = measurements.flatMap((measurement) => {
      const annotation = measurementApi.measurementToViewportAnnotation(
        measurement,
        measurementDisplay,
        measurement.id === activeMeasurementId
      );
      return annotation ? [annotation] : [];
    });
    return measurementDraft?.point
      ? [
          ...pinned,
          {
            id: 'measurement-draft',
            label: `A · ${measurementDraft.semantic.replaceAll('-', ' ')}`,
            selected: true,
            status: 'current' as const,
            // The first of two picks marks a point; there is no second point
            // to span to until it lands.
            graphic: 'anchor' as const,
            anchor: measurementDraft.point,
            segments: []
          }
        ]
      : pinned;
  }, [
    activeMeasurementId,
    measurementDisplay,
    measurementDraft,
    measurements,
    measurementApi
  ]);
  const formattedMeasurements = useMemo(
    () =>
      measurementApi
        ? Object.fromEntries(
            measurements.map((measurement) => [
              measurement.id,
              measurementApi.formatMeasurement(measurement, measurementDisplay)
            ])
          )
        : {},
    [measurementDisplay, measurements, measurementApi]
  );

  async function copyMeasurements(measurement?: Measurement) {
    const selected = measurement ? [measurement] : measurements;
    if (selected.length === 0 || !measurementApi) {
      return;
    }
    try {
      await navigator.clipboard.writeText(
        measurementApi.measurementsToText(selected, measurementDisplay)
      );
      setStatus(
        `Copied ${selected.length} measurement${selected.length === 1 ? '' : 's'}.`
      );
    } catch {
      setStatus('Could not reach the clipboard. Export CSV instead.');
    }
  }

  function exportMeasurements() {
    if (!doc || measurements.length === 0 || !measurementApi) {
      return;
    }
    const fileName = `${exportFileStem(doc.name)}.measurements.csv`;
    downloadText(
      fileName,
      `${measurementApi.measurementsToCsv(measurements, measurementDisplay)}\n`,
      'text/csv'
    );
    setStatus(`Exported ${measurements.length} measurements to ${fileName}.`);
  }

  return {
    measuring,
    setMeasuring,
    measurementMode,
    setMeasurementMode,
    measurementDraft,
    measurementEdgeRun,
    measurements,
    setMeasurements,
    applyStoredMeasurements,
    activeMeasurementId,
    setActiveMeasurementId,
    measurementUnit,
    setMeasurementUnit,
    measurementPrecision,
    setMeasurementPrecision,
    radialDisplay,
    setRadialDisplay,
    measurementHydratedProjectId,
    measurementDisplay,
    measurementApi,
    recordMeasurement,
    previewMeasurement,
    clearMeasurementPicks,
    handleMeasurementPick,
    measurementAnnotations,
    formattedMeasurements,
    copyMeasurements,
    exportMeasurements
  };
}
