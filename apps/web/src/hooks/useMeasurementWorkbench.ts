import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BodyRepresentation,
  ProjectDocument,
  TopologySelection,
  UnitSystem
} from '@openzcad/shared';
import type { PickDetail, PickSnap } from '@openzcad/viewport';
import { documentDisplayUnits } from '@openzcad/shared';
import { downloadText, exportFileStem } from '../lib/model';
import type {
  Measurement,
  MeasurementDisplayOptions,
  MeasurePointKind,
  MeasurementViewportAnnotation,
  RadialDisplay
} from '../lib/measurements';
/**
 * The measurement module's shape, for the deferred handle below. A type-only
 * namespace import is erased at build time exactly like the named ones above,
 * so naming the module here does not pull it back into the eager chunk.
 */
import type * as MeasurementModule from '../lib/measurements';
import {
  buildMeasurementRecord,
  measurementRecordContentKey
} from '../lib/measurementRecord';
import { EMPTY_MEASURE_SESSION, nextEdgeRun } from '../lib/measureSession';
import {
  measureReadings,
  pickIsMeasurable,
  pickLabel,
  samePick,
  type MeasurePick,
  type MeasureReadingKind,
  type MeasureReadingsInput,
  type MeasureSessionView
} from '../lib/measureReadings';
import {
  loadProjectMeasurements,
  saveProjectMeasurements
} from '../lib/localProjectStore';

const NO_PICKS = { first: null, second: null } as const;

export interface MeasurementWorkbenchInput {
  doc: ProjectDocument | null;
  /**
   * View or Tweak mode. Entering one loads the measurement library ahead of
   * the first pick; Build loads it when Measure is switched on there.
   */
  modelingLocked: boolean;
  exactGeometryReady: boolean;
  /** Displayed geometry is still waiting for its measurement analysis. */
  geometryPending?: boolean;
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
  geometryPending = false,
  representations,
  renderedRepresentations,
  viewerBodies,
  setStatus
}: MeasurementWorkbenchInput) {
  /** View-only measurement session. None of this enters document/history. */
  const [measuring, setMeasuring] = useState(false);
  /** M13: the kind of point a Distance reading records ('auto' derives it). */
  const [measurementPointKind, setMeasurementPointKind] =
    useState<MeasurePointKind>('auto');
  /**
   * The live pick session: up to two picks, read every way they can be.
   * Nothing here is recorded until the reading is kept.
   */
  const [measurementPicks, setMeasurementPicks] = useState<{
    first: MeasurePick | null;
    second: MeasurePick | null;
  }>(NO_PICKS);
  /** The reading someone chose over the first one offered, if any. */
  const [chosenReadingKind, setChosenReadingKind] =
    useState<MeasureReadingKind | null>(null);
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
  const skipNextMeasurementPersistenceRef = useRef(false);
  const applyStoredMeasurements = useCallback((restored: Measurement[]) => {
    skipNextMeasurementPersistenceRef.current = true;
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
  const measurementPersistedContentRef = useRef<{
    projectId: string;
    contentKey: string;
  } | null>(null);
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
    // I03: a project measures in the unit it shows lengths in.
    setMeasurementUnit(documentDisplayUnits(doc));
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
          measurementPersistedContentRef.current = {
            projectId,
            contentKey: measurementRecordContentKey(record)
          };
        } else {
          measurementPersistedContentRef.current = null;
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
   * I03: switching the project's display unit switches the measurements
   * with it. Only a switch while the project is open: opening one restores
   * the unit its measurements were last read in.
   */
  const displayUnits = doc ? documentDisplayUnits(doc) : null;
  const shownUnitsRef = useRef<{
    projectId: string;
    units: UnitSystem;
  } | null>(null);
  useEffect(() => {
    if (!doc || displayUnits === null) return;
    const last = shownUnitsRef.current;
    shownUnitsRef.current = { projectId: doc.projectId, units: displayUnits };
    if (last?.projectId === doc.projectId && last.units !== displayUnits)
      setMeasurementUnit(displayUnits);
    // Keyed on the project and its display unit, not every document edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.projectId, displayUnits]);

  /** The debounced write still waiting for its timer, if any. */
  const pendingMeasurementWriteRef = useRef<{
    projectId: string;
    timeout: number;
    write(): Promise<void>;
  } | null>(null);
  /** Device writes started and not yet settled. */
  const measurementWritesRef = useRef(new Set<Promise<void>>());

  /**
   * Writes `projectId`'s pending measurement list now and waits for every
   * device write already started, so a reader of the device record (a
   * Duplicate copying it, #2433) sees a reading kept a moment before. Never
   * rejects: a failed write is the same best effort as the debounced one.
   */
  const flushMeasurementPersistence = useCallback(
    async (projectId: string): Promise<void> => {
      const pending = pendingMeasurementWriteRef.current;
      if (pending?.projectId === projectId) {
        window.clearTimeout(pending.timeout);
        await pending.write();
      }
      await Promise.all([...measurementWritesRef.current]);
    },
    []
  );

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
    if (skipNextMeasurementPersistenceRef.current) {
      skipNextMeasurementPersistenceRef.current = false;
      return;
    }
    const projectId = doc.projectId;
    const write = (): Promise<void> => {
      if (pendingMeasurementWriteRef.current?.write === write)
        pendingMeasurementWriteRef.current = null;
      const record = buildMeasurementRecord(
        projectId,
        measurements,
        measurementDisplay,
        new Date().toISOString()
      );
      const contentKey = measurementRecordContentKey(record);
      const previous = measurementPersistedContentRef.current;
      if (
        previous?.projectId === projectId &&
        previous.contentKey === contentKey
      ) {
        return Promise.resolve();
      }
      measurementPersistedContentRef.current = { projectId, contentKey };
      const saving = saveProjectMeasurements(record).catch(() => {
        if (
          measurementPersistedContentRef.current?.projectId === projectId &&
          measurementPersistedContentRef.current.contentKey === contentKey
        ) {
          measurementPersistedContentRef.current = previous;
        }
        // Same as the read: a device that cannot store them still measures.
      });
      const writes = measurementWritesRef.current;
      writes.add(saving);
      void saving.finally(() => writes.delete(saving));
      return saving;
    };
    const timeout = window.setTimeout(() => void write(), 400);
    pendingMeasurementWriteRef.current = { projectId, timeout, write };
    return () => {
      window.clearTimeout(timeout);
      if (pendingMeasurementWriteRef.current?.write === write)
        pendingMeasurementWriteRef.current = null;
    };
  }, [
    doc?.projectId,
    measurementHydratedProjectId,
    measurementRestoreGeneration,
    measurements,
    measurementDisplay
  ]);

  /**
   * The measurement library, loaded on first entry to View mode or on the
   * first Measure in Build.
   *
   * It is roughly nine kilobytes of derivation, formatting and export that
   * only a measure session can reach, and importing it at the top of this file put all
   * of it in the eager entry chunk — which the bundle budget guards precisely
   * because it is what every visitor downloads before anything renders. Types
   * are erased at build time, so `import type` above costs nothing; only the
   * runtime import is deferred.
   *
   * Every consumer below therefore has to tolerate `null` for the frame or two
   * between switching Measure on and the chunk arriving. That is a real state
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
    if ((!modelingLocked && !measuring) || measurementApi) {
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
  }, [modelingLocked, measuring, measurementApi]);

  /**
   * The committed exact bodies last seen for the open project in each unit
   * it was stored in. A stored-unit conversion (or its undo) gives every
   * Boolean face and edge a new identity; a refresh in the new unit
   * re-attaches each kept target from what it was on the bodies of the unit
   * the row was kept in (#2361). Held for as long as the project stays open,
   * not just the first new-unit refresh: a row can reach the list after the
   * conversion (a slow device read, a cloud restore) and still needs them.
   */
  const lastExactBodiesRef = useRef<{
    projectId: string;
    byUnit: Map<UnitSystem, BodyRepresentation[]>;
  } | null>(null);

  useEffect(() => {
    if (!doc || !exactGeometryReady || geometryPending) {
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
    // Recorded even before the measurement library loads, so a conversion
    // made before the first Measure still has the bodies it converted from.
    if (lastExactBodiesRef.current?.projectId !== doc.projectId)
      lastExactBodiesRef.current = {
        projectId: doc.projectId,
        byUnit: new Map()
      };
    const { byUnit } = lastExactBodiesRef.current;
    byUnit.set(doc.units, bodies);
    if (!measurementApi) return;
    const previous = [...byUnit]
      .filter(([unit]) => unit !== doc.units)
      .map(([unit, kept]) => ({ unit, bodies: kept }));
    // I03: rows kept in another stored unit (before a unit conversion, or
    // after its undo) are rescaled to the bodies' unit before re-measuring.
    setMeasurements((current) =>
      measurementApi.refreshMeasurements(current, bodies, doc.version, {
        force: true,
        unit: doc.units,
        ...(previous.length > 0 ? { previous } : {})
      })
    );
  }, [
    representations,
    doc?.projectId,
    doc?.version,
    doc?.units,
    exactGeometryReady,
    geometryPending,
    measurementApi,
    measurementRestoreGeneration
  ]);

  function recordMeasurement(measurement: Measurement): boolean {
    // Checked before the state update rather than inside it, so the refusal can
    // be reported. The list is capped rather than self-trimming: dropping the
    // oldest row to make room is data loss nobody was told about.
    if (!measurementApi || geometryPending) {
      return false;
    }
    if (!measurementApi.canAppendMeasurement(measurements, measurement)) {
      setStatus(measurementApi.MEASUREMENT_LIMIT_MESSAGE);
      return false;
    }
    setMeasurements((current) =>
      measurementApi.appendMeasurement(current, measurement)
    );
    setActiveMeasurementId(measurement.id);
    setStatus(`${measurement.label} measured.`);
    return true;
  }

  const readingsInput: MeasureReadingsInput | null = doc
    ? {
        bodies: renderedRepresentations,
        viewerBodies,
        revision: doc.version,
        units: doc.units,
        pointKind: measurementPointKind
      }
    : null;

  /**
   * Every reading the current picks support, most useful first, and the one
   * the card shows large: the chosen one while it still applies, otherwise
   * the first.
   */
  const measurementSession = useMemo<MeasureSessionView>(() => {
    const named = (pick: MeasurePick | null, label: string | null) =>
      pick ? { label: label ?? 'Unavailable' } : null;
    if (!measurementApi || !readingsInput || geometryPending) {
      return {
        first: named(measurementPicks.first, '…'),
        second: named(measurementPicks.second, '…'),
        readings: [],
        primary: null,
        distanceRefusal: null
      };
    }
    const { readings, distanceRefusal } = measureReadings(
      measurementApi,
      readingsInput,
      { ...measurementPicks, edgeRun: measurementEdgeRun }
    );
    const formatted = readings.map((reading) => ({
      ...reading,
      // A circle read as a radius is titled as one.
      title:
        reading.kind === 'single' &&
        reading.measurement.kind === 'diameter' &&
        measurementDisplay.radialDisplay === 'radius'
          ? 'Radius'
          : reading.title,
      formatted: measurementApi.formatMeasurement(
        reading.measurement,
        measurementDisplay
      )
    }));
    const label = (pick: MeasurePick | null) =>
      named(pick, pick ? pickLabel(measurementApi, readingsInput, pick) : null);
    return {
      first:
        measurementEdgeRun.length >= 2 && !measurementPicks.second
          ? { label: `${measurementEdgeRun.length} edges` }
          : label(measurementPicks.first),
      second: label(measurementPicks.second),
      readings: formatted,
      primary:
        formatted.find((reading) => reading.kind === chosenReadingKind) ??
        formatted[0] ??
        null,
      distanceRefusal
    };
    // `readingsInput` is rebuilt every render from the values listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    measurementApi,
    doc?.version,
    doc?.units,
    renderedRepresentations,
    viewerBodies,
    measurementPointKind,
    measurementPicks,
    measurementEdgeRun,
    chosenReadingKind,
    measurementDisplay,
    geometryPending
  ]);

  /**
   * What clicking here WOULD read, without picking anything.
   *
   * The preview runs the SAME derivation the pick will run rather than a
   * cheaper estimate that could disagree with the number the card shows.
   * With a first pick waiting it previews the relation; otherwise the
   * hovered entity on its own.
   *
   * Null when there is nothing honest to say, which includes an ambiguous
   * pick: a hover is not the place to explain ADR-011, and a silent absence
   * beats a confident wrong number.
   */
  function previewMeasurement(
    selection: TopologySelection,
    point?: { x: number; y: number; z: number },
    snap?: PickSnap
  ): string | null {
    if (!measuring || !measurementApi || !readingsInput || geometryPending) {
      return null;
    }
    const hovered: MeasurePick = { selection, point, snap };
    const { first, second } = measurementPicks;
    const pairing =
      first !== null &&
      second === null &&
      measurementEdgeRun.length < 2 &&
      !samePick(measurementApi, readingsInput, first, hovered);
    const reading = measureReadings(measurementApi, readingsInput, {
      first: pairing ? first : hovered,
      second: pairing ? hovered : null,
      edgeRun: []
    }).readings[0];
    if (!reading) {
      return null;
    }
    // Already recorded and drawn on the model: its own chip says it, and
    // a second identical chip beside it ("80.00 mm" twice) said nothing
    // more (I54).
    if (
      measurements.some(
        (entry) => entry.id === reading.measurement.id && entry.visible
      )
    ) {
      return null;
    }
    return measurementApi.formatMeasurement(
      reading.measurement,
      measurementDisplay
    ).value;
  }

  /** Abandons the pick session: both picks and the running edge total. */
  function clearMeasurementPicks() {
    setMeasurementPicks(NO_PICKS);
    setChosenReadingKind(null);
    setMeasurementEdgeRun(EMPTY_MEASURE_SESSION.edgeRun);
  }

  /** Shows a reading other than the first one large, and keeps that one. */
  function chooseMeasurementReading(kind: MeasureReadingKind) {
    setChosenReadingKind(kind);
  }

  /**
   * Records the reading the card shows, then starts a fresh session. Returns
   * whether there was one to keep, so Enter falls through when there is not.
   */
  function keepMeasurementReading(): boolean {
    if (!measuring) {
      return false;
    }
    if (geometryPending) {
      setStatus(
        'Measurements are unavailable while the model finishes updating.'
      );
      return true;
    }
    const primary = measurementSession.primary;
    if (!primary) {
      return false;
    }
    if (recordMeasurement(primary.measurement)) {
      clearMeasurementPicks();
    }
    return true;
  }

  /**
   * Takes a pick into the session, and reports whether it consumed it.
   *
   * The return value is the point. This used to be called for its side effects
   * and fall straight through into sketch entry, direct manipulation, and the
   * selection update — so measuring an edge in View mode silently replaced
   * whatever a modelling session had selected, and the two features quietly
   * shared one piece of state.
   *
   * A plain click fills the first empty slot, or starts over once both are
   * full; a Shift+Click on an edge adds it to a running total instead.
   */
  function handleMeasurementPick(
    selection: TopologySelection,
    additive: boolean,
    detail?: PickDetail
  ): boolean {
    // Measure is on in any mode it can be switched on in: View and Tweak's
    // rail, or Build's instrument rail, which ends the measure session the
    // moment another command takes the pointer.
    if (!doc || !measuring) {
      return false;
    }
    if (geometryPending) {
      setStatus(
        'Measurements are unavailable while the model finishes updating.'
      );
      return true;
    }
    // One guard for the whole handler. Dropping a pick that lands before the
    // measurement chunk arrives is better than servicing half of it, and the
    // window is a frame or two on the first measure session only. It still
    // counts as consumed: falling through to selection would be the very
    // coupling this seam removes.
    if (!measurementApi || !readingsInput) {
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
    const pick: MeasurePick = {
      selection,
      point: detail?.point,
      snap: detail?.snap
    };
    if (!pickIsMeasurable(measurementApi, readingsInput, pick)) {
      setStatus(
        (measurementPointKind !== 'auto'
          ? measurementApi.pointKindFailure(
              measurementPointKind,
              selection.kind
            )
          : null) ??
          measurementApi.measurementSelectionFailure(body, selection) ??
          'That selection does not expose a trustworthy measurement.'
      );
      return true;
    }
    setChosenReadingKind(null);
    const label = pickLabel(measurementApi, readingsInput, pick) ?? 'Pick';

    // The run lives in the measure session rather than in `selectedEdges`,
    // which is what let measuring rewrite the workspace's selection.
    if (additive && selection.kind === 'edge') {
      const run = nextEdgeRun(measurementEdgeRun, selection, true);
      setMeasurementEdgeRun(run);
      setMeasurementPicks({ first: pick, second: null });
      setStatus(
        run.length >= 2
          ? `${run.length} edges · Enter keeps their total length.`
          : `${label} selected · Shift+Click more edges to total them.`
      );
      return true;
    }

    const { first, second } = measurementPicks;
    // A whole body picked after one of its own faces or edges is the second
    // click of a double-click, which selects the body: it starts over on the
    // body rather than measuring a face against the body it bounds.
    const bodyOfFirst =
      first !== null &&
      selection.kind === 'body' &&
      first.selection.kind !== 'body' &&
      first.selection.bodyId === selection.bodyId;
    if (
      first &&
      !second &&
      !bodyOfFirst &&
      measurementEdgeRun.length < 2 &&
      !samePick(measurementApi, readingsInput, first, pick)
    ) {
      setMeasurementPicks({ first, second: pick });
      const reading = measureReadings(measurementApi, readingsInput, {
        first,
        second: pick,
        edgeRun: []
      }).readings[0];
      setStatus(
        reading
          ? `${reading.title} ${measurementApi.formatMeasurement(reading.measurement, measurementDisplay).value} · Enter keeps it.`
          : 'Those two picks share no distance or angle that can be trusted. Pick again to start over.'
      );
      return true;
    }
    setMeasurementPicks({ first: pick, second: null });
    setMeasurementEdgeRun(
      selection.kind === 'edge' ? [selection] : EMPTY_MEASURE_SESSION.edgeRun
    );
    setStatus(
      `${label} selected · pick the second target to compare · Enter keeps.`
    );
    return true;
  }

  const measurementAnnotations = useMemo<
    MeasurementViewportAnnotation[]
  >(() => {
    if (!measurementApi || geometryPending) {
      return [];
    }
    // The bodies only size each label's standoff: an area's label stands
    // just outside the face it measures, not outside the whole model. They
    // are the bodies on screen, so a previewed edit moves the label with the
    // face it is drawing rather than leaving it by the committed one.
    const pinned = measurements.flatMap((measurement) => {
      const annotation = measurementApi.measurementToViewportAnnotation(
        measurement,
        measurementDisplay,
        measurement.id === activeMeasurementId,
        viewerBodies
      );
      return annotation ? [annotation] : [];
    });
    // The live reading draws as a pinned one would, selected, unless the
    // same figure is already on the model.
    const live = measurementSession.primary?.measurement;
    if (live) {
      if (measurements.some((entry) => entry.id === live.id && entry.visible)) {
        return pinned;
      }
      const annotation = measurementApi.measurementToViewportAnnotation(
        live,
        measurementDisplay,
        true,
        viewerBodies
      );
      return annotation
        ? [...pinned, { ...annotation, id: 'measurement-draft' }]
        : pinned;
    }
    return pinned;
  }, [
    activeMeasurementId,
    geometryPending,
    measurementDisplay,
    measurementSession.primary,
    measurements,
    measurementApi,
    viewerBodies
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
    if (geometryPending) {
      setStatus(
        'Measurements are unavailable while the model finishes updating.'
      );
      return;
    }
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
    if (geometryPending) {
      setStatus(
        'Measurements are unavailable while the model finishes updating.'
      );
      return;
    }
    if (!doc || measurements.length === 0 || !measurementApi) {
      return;
    }
    const fileName = `${exportFileStem(doc.name)}.measurements.csv`;
    downloadText(
      fileName,
      `${measurementApi.measurementsToCsv(measurements, measurementDisplay)}\n`,
      'text/csv'
    );
    setStatus(
      `Exported ${measurements.length} measurement${
        measurements.length === 1 ? '' : 's'
      } to ${fileName}.`
    );
  }

  return {
    measuring,
    setMeasuring,
    measurementPointKind,
    setMeasurementPointKind,
    measurementSession,
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
    flushMeasurementPersistence,
    measurementApi,
    recordMeasurement,
    previewMeasurement,
    clearMeasurementPicks,
    chooseMeasurementReading,
    keepMeasurementReading,
    handleMeasurementPick,
    measurementAnnotations,
    formattedMeasurements,
    copyMeasurements,
    exportMeasurements
  };
}
