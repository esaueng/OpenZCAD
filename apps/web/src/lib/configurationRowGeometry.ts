import { useEffect, useMemo, useRef, useState } from 'react';
import { documentForConfiguration } from '@openzcad/document-core';
import type { GeometryReadyState, ProjectDocument } from '@openzcad/shared';
import { geometryContentKey } from '../worker/exactRebuildCache';
import {
  resolvedForDisplay,
  type SolveSketch
} from './sketch/parameterResolve';

/**
 * F06 slice 4: configuration rows shown beside the active one. A view or an
 * assembly component that names another row is drawn from that row built on
 * its own (`documentForConfiguration`), while the document's active row stays
 * the model being edited. This hook builds each named row once per geometry
 * content (moving a part, a drawing or a folder does not rebuild it), one at
 * a time, and keeps the last good build of a row on screen until its next
 * one lands, so an edit elsewhere does not blank the part.
 */
export interface ConfigurationRowBuild {
  /** The row's document, with the geometry it builds to. */
  document: ProjectDocument;
  /** `geometryContentKey` of the live document it was built from. */
  contentKey: string;
}

export interface ConfigurationRowGeometry {
  builds: ReadonlyMap<string, ConfigurationRowBuild>;
  /** Rows that could not be built, with the reason. */
  errors: ReadonlyMap<string, string>;
  /**
   * `geometryContentKey` of the live document, or '' while no row is named.
   * A build whose own key differs is the last good one kept on screen.
   */
  contentKey: string;
}

/**
 * A row's build only when it was built from the document as it now stands.
 * The hook keeps the previous build drawn while the next one runs, so an
 * export or any other result that must match the model reads this rather
 * than `builds` directly.
 */
export function currentConfigurationRow(
  geometry: ConfigurationRowGeometry,
  rowId: string
): ProjectDocument | null {
  const entry = geometry.builds.get(rowId);
  return entry &&
    geometry.contentKey !== '' &&
    entry.contentKey === geometry.contentKey
    ? entry.document
    : null;
}

export type BuildRowGeometry = (
  document: ProjectDocument,
  options: { signal: AbortSignal }
) => Promise<GeometryReadyState>;

/** The rows to build: named, in the table, not the active one, once each. */
export function configurationRowsToBuild(
  document: ProjectDocument | null,
  rowIds: readonly (string | null | undefined)[]
): string[] {
  const set = document?.configurations;
  if (!set) return [];
  const wanted = new Set<string>();
  for (const rowId of rowIds)
    if (
      rowId &&
      rowId !== set.activeRowId &&
      set.rows.some((row) => row.id === rowId)
    )
      wanted.add(rowId);
  return [...wanted].sort();
}

/** One row's document with its geometry, or the reason it has none. */
export async function buildConfigurationRow(
  document: ProjectDocument,
  rowId: string,
  build: BuildRowGeometry,
  signal: AbortSignal,
  /** Solves the sketches the row's parameter values drive, for display. */
  solve?: SolveSketch
): Promise<ProjectDocument> {
  const switched = documentForConfiguration(document, rowId);
  const row = solve
    ? await resolvedForDisplay(document, switched, solve)
    : switched;
  signal.throwIfAborted();
  const ready = await build(row, { signal });
  // The active row's solve never stands in for this row's.
  const { sketchGeometry: _activeGeometry, ...derived } = row.derived;
  return {
    ...row,
    derived: {
      ...derived,
      // Display geometry: drawn, picked and measured, never weighed. A row's
      // volume and mass come from its exact export or the Inspector's own
      // request, so the analysis fields a preview build leaves out are never
      // read from these.
      bodyRepresentations:
        ready.bodyRepresentations as ProjectDocument['derived']['bodyRepresentations'],
      warnings: ready.warnings,
      // The build's own solve: sketches tied to a linked projection are
      // solved against the row's re-projected edge only here, so the
      // overlays (`resolvedSketchDocument`) draw them where the solids are.
      ...(ready.sketchGeometry ? { sketchGeometry: ready.sketchGeometry } : {})
    }
  };
}

export function useConfigurationRowGeometry(
  document: ProjectDocument | null,
  rowIds: readonly (string | null | undefined)[],
  build: BuildRowGeometry | null,
  /**
   * Whether the model itself is built. Rows wait for it: a row asked for
   * while the worker is still building the model (just after a reload, say)
   * would be dropped or refused, and is asked for again once it is ready.
   */
  ready = true,
  /**
   * Solves a sketch. A row's parameter values can drive a sketch the active
   * row solved to other sizes; each row's build solves those again, so it
   * shows the row's geometry rather than the active row's.
   */
  solve?: SolveSketch
): ConfigurationRowGeometry {
  const wanted = configurationRowsToBuild(document, rowIds);
  const wantedKey = wanted.join('\n');
  // Only paid for while a row is named.
  const contentKey = useMemo(
    () => (document && wantedKey !== '' ? geometryContentKey(document) : ''),
    [document, wantedKey]
  );
  const latest = useRef(document);
  latest.current = document;
  const solveRef = useRef(solve);
  solveRef.current = solve;
  const [state, setState] = useState<{
    builds: Map<string, ConfigurationRowBuild>;
    errors: Map<string, string>;
  }>(() => ({ builds: new Map(), errors: new Map() }));
  const current = useRef(state);
  current.current = state;

  useEffect(() => {
    const document = latest.current;
    if (!document || !build || !ready || wantedKey === '') return;
    // A row already built for this geometry stays as it is.
    const rows = wantedKey
      .split('\n')
      .filter(
        (rowId) => current.current.builds.get(rowId)?.contentKey !== contentKey
      );
    if (rows.length === 0) return;
    const abort = new AbortController();
    void (async () => {
      for (const rowId of rows) {
        if (abort.signal.aborted) return;
        try {
          const built = await buildConfigurationRow(
            document,
            rowId,
            build,
            abort.signal,
            solveRef.current
          );
          if (abort.signal.aborted) return;
          setState((current) => {
            const builds = new Map(current.builds);
            builds.set(rowId, { document: built, contentKey });
            const errors = new Map(current.errors);
            errors.delete(rowId);
            return { builds, errors };
          });
        } catch (error) {
          if (abort.signal.aborted) return;
          setState((current) => {
            const builds = new Map(current.builds);
            builds.delete(rowId);
            const errors = new Map(current.errors);
            errors.set(
              rowId,
              error instanceof Error
                ? error.message
                : 'The configuration could not be built.'
            );
            return { builds, errors };
          });
        }
      }
    })();
    return () => abort.abort();
  }, [contentKey, build, wantedKey, ready]);

  // Rows no longer named, or of another project, are not shown.
  return useMemo(() => {
    const keep = new Set(wanted);
    const builds = new Map(
      [...state.builds].filter(
        ([rowId, entry]) =>
          keep.has(rowId) && entry.document.projectId === document?.projectId
      )
    );
    const errors = new Map(
      [...state.errors].filter(([rowId]) => keep.has(rowId))
    );
    return { builds, errors, contentKey };
    // `wanted` is derived from `wantedKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, wantedKey, document?.projectId, contentKey]);
}
