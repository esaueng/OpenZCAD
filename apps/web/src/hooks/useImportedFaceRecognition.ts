import { useEffect, useRef, useState } from 'react';
import type {
  BodyId,
  FaceRecognitionSummary,
  ProjectDocument
} from '@openzcad/shared';
import type { GeometryWorkerApi } from './useGeometryWorker';

/**
 * Face key for the per-face recognition cache: the body plus the face's
 * rebuild-local identity. ADR-011 hashes are geometry fingerprints, so a
 * moved face naturally misses; the topology id distinguishes two faces that
 * share one hash (the sphere-hemisphere case), where answering from the
 * other's query would be a wrong-face hit.
 */
export function recognitionCacheKey(
  bodyId: BodyId,
  faceHash: number | undefined,
  topologyId: string | undefined
): string {
  return `${bodyId}:${topologyId ?? ''}:${faceHash ?? ''}`;
}

export interface ImportedFaceRecognitionQuery {
  bodyId: BodyId;
  faceHash: number;
  topologyId?: string;
}

/** Worker input for one on-demand per-face recognition query. */
export interface RecognizeImportedFaceInput {
  document: ProjectDocument;
  bodyId: BodyId;
  faceHash: number;
  topologyId?: string;
}

export interface UseImportedFaceRecognition {
  /** The cached summary for this face, when a query already answered. */
  summary: FaceRecognitionSummary | null;
  /** True while the worker is answering this face. */
  pending: boolean;
  /** The worker's transport failure, when the query itself errored. */
  error: string | null;
}

/**
 * On-demand per-face recognition of one imported STEP face (Phase D of the
 * imported STEP edit plan).
 *
 * Lazy by construction: nothing queries until the Inspector shows a selected
 * imported face, and each (body, face) answers at most once per document
 * version — the result is cached in the shared map the caller owns, keyed by
 * {@link recognitionCacheKey}, so reselecting a face never re-queries. A
 * document version change drops every entry, because face hashes are
 * rebuild-local and a new version may have moved the geometry.
 *
 * Display-only: the summary rides the additive `FaceGeometry.recognition`
 * field on the cached copy, never the document or the rebuild payload. The
 * sole edit committed through recognition remains the existing through-hole
 * diameter resize.
 */
export function useImportedFaceRecognition(
  recognizeImportedFace:
    | Pick<GeometryWorkerApi, 'recognizeImportedFace'>
    | {
        recognizeImportedFace: (
          input: RecognizeImportedFaceInput
        ) => Promise<FaceRecognitionSummary>;
      }
    | null
    | undefined,
  document: ProjectDocument | null,
  query: ImportedFaceRecognitionQuery | null,
  cache: Map<string, FaceRecognitionSummary> | null | undefined
): UseImportedFaceRecognition {
  const key =
    query && document
      ? `${document.projectId}:${document.version}:${recognitionCacheKey(
          query.bodyId,
          query.faceHash,
          query.topologyId
        )}`
      : null;
  const cached = key && cache ? (cache.get(key) ?? null) : null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<string | null>(null);

  useEffect(() => {
    if (
      !query ||
      !document ||
      !key ||
      !cache ||
      !recognizeImportedFace ||
      cache.has(key)
    ) {
      inFlight.current = null;
      setPending(false);
      return;
    }
    if (inFlight.current === key) {
      return;
    }
    inFlight.current = key;
    setPending(true);
    setError(null);
    let cancelled = false;
    void recognizeImportedFace
      .recognizeImportedFace({
        document,
        bodyId: query.bodyId,
        faceHash: query.faceHash,
        ...(query.topologyId !== undefined
          ? { topologyId: query.topologyId }
          : {})
      })
      .then((summary) => {
        if (cancelled || inFlight.current !== key) {
          return;
        }
        cache.set(key, summary);
        inFlight.current = null;
        setPending(false);
      })
      .catch((failure: unknown) => {
        if (cancelled || inFlight.current !== key) {
          return;
        }
        inFlight.current = null;
        setPending(false);
        setError(
          failure instanceof Error ? failure.message : 'Recognition failed.'
        );
      });
    return () => {
      cancelled = true;
      // Strict Mode replays setup after cleanup with the same face key.
      if (inFlight.current === key) inFlight.current = null;
    };
    // `cache` is a caller-owned stable map (a ref), not state: mutations do
    // not re-render, and the settled write above triggers the update via
    // `setPending`. `recognizeImportedFace` is a stable bound worker call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { summary: cached, pending, error };
}
