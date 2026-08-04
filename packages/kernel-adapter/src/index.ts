/**
 * Kernel adapter surface.
 *
 * OpenZCAD builds every body with one exact B-rep kernel. The adapter that
 * drives it lives in `./exact`, loaded on demand because it pulls a WASM
 * module; this entry point carries only the synchronous helpers the app and
 * the adapters share — topology lineage, face attachment, imported-feature
 * recognition, and the mesh handoff.
 */
export * from './topology-lineage';
export * from './face-attachment';
export * from './extrude-inference';

export {
  importedMeshStl,
  meshBooleanUnsupportedError,
  type ImportedMeshFeatureData
} from './imported-mesh';

export {
  DEFAULT_EXACT_BEZIER_EDGES,
  bezierProfileEdgesEnabled,
  setBezierProfileEdges
} from './profile-bezier-edges';

export {
  DEFAULT_RECOGNITION_LIMITS,
  recognizeImportedFeature,
  type ExactFaceAdjacency,
  type ExactFaceAdjacencyQuery,
  type ExactRecognitionFace,
  type ExactRecognitionSurface,
  type ImportedFeatureProof,
  type ImportedFeatureRecognition,
  type RecognitionLimits,
  type RecognitionRefusalReason
} from './imported-feature-recognition';
