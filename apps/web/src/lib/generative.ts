import type { BodyId, DisplayGeometry, ProjectDocument } from '@openzcad/shared';
import {
  getBodyLoad,
  getBodyRole,
  getStudySettings,
  listBodies,
  loadMagnitude,
  type StudySettings
} from './workflow';

/**
 * Mock generative solver. It produces deterministic candidate outcomes from
 * the documented setup (design-space volume, loads, study settings) so the
 * workflow, UI, and persistence around generation are real while the native
 * OpenCascade/topology kernel is still staged. All metrics are estimates and
 * are labeled as such in the UI.
 */

export interface GenerativeOutcome {
  id: string;
  name: string;
  /** Fraction of the design-space volume retained. */
  volumeFraction: number;
  /** Estimated mass in kg (steel density, bounding geometry estimate). */
  massKg: number;
  /** Estimated peak displacement in mm under the applied loads. */
  maxDisplacementMm: number;
  /** 0-100 composite score for the study objective (higher is better). */
  score: number;
  /** Uniform preview scale applied to design-space bodies. */
  previewScale: number;
}

export interface GenerativeRunSummary {
  outcomes: GenerativeOutcome[];
  designVolumeMm3: number;
  totalLoadN: number;
  settings: StudySettings;
  generatedAt: string;
  solver: 'mock';
}

const STEEL_DENSITY_KG_PER_MM3 = 7850e-9;
const YOUNGS_MODULUS_N_PER_MM2 = 210_000;
const OUTCOME_NAMES = ['A', 'B', 'C', 'D', 'E', 'F'];
const FRACTION_SPREAD = [1, 0.85, 1.15, 0.7, 1.3, 0.55];

export function estimateGeometryVolumeMm3(geometry: DisplayGeometry): number {
  if (geometry.kind === 'box') {
    return (
      (geometry.dimensions.width ?? 1) *
      (geometry.dimensions.height ?? 1) *
      (geometry.dimensions.depth ?? 1)
    );
  }
  if (geometry.kind === 'cylinder') {
    const radius = geometry.dimensions.radius ?? 1;
    return Math.PI * radius * radius * (geometry.dimensions.height ?? 1);
  }
  if (geometry.kind === 'sphere') {
    const radius = geometry.dimensions.radius ?? 1;
    return (4 / 3) * Math.PI * radius ** 3;
  }
  if (geometry.kind === 'composite') {
    return geometry.children.reduce(
      (total, child) => total + estimateGeometryVolumeMm3(child.geometry),
      0
    );
  }
  if (geometry.kind === 'mesh') {
    // Mesh: half the bounding-box volume is a serviceable estimate.
    const { vertices } = geometry;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let index = 0; index + 2 < vertices.length; index += 3) {
      minX = Math.min(minX, vertices[index]!);
      maxX = Math.max(maxX, vertices[index]!);
      minY = Math.min(minY, vertices[index + 1]!);
      maxY = Math.max(maxY, vertices[index + 1]!);
      minZ = Math.min(minZ, vertices[index + 2]!);
      maxZ = Math.max(maxZ, vertices[index + 2]!);
    }
    if (!Number.isFinite(minX)) {
      return 0;
    }
    return (
      0.5 * Math.max(0, maxX - minX) * Math.max(0, maxY - minY) * Math.max(0, maxZ - minZ)
    );
  }
  return 0;
}

function bodyVolumeMm3(document: ProjectDocument, bodyId: BodyId): number {
  const representation = document.derived.bodyRepresentations[bodyId];
  return representation ? estimateGeometryVolumeMm3(representation.geometry) : 0;
}

function outcomeCount(resolution: StudySettings['resolution']): number {
  if (resolution === 'coarse') return 3;
  if (resolution === 'fine') return 6;
  return 4;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function runMockGenerativeStudy(document: ProjectDocument): GenerativeRunSummary {
  const settings = getStudySettings(document);
  const bodies = listBodies(document);

  let designVolume = 0;
  let preservedVolume = 0;
  let totalLoad = 0;
  for (const body of bodies) {
    const role = getBodyRole(body);
    const volume = bodyVolumeMm3(document, body.bodyId);
    if (role === null) {
      designVolume += volume;
    } else if (role === 'preserve' || role === 'fixed') {
      preservedVolume += volume;
    }
    const load = getBodyLoad(body);
    if (load) {
      totalLoad += loadMagnitude(load);
    }
  }

  const characteristicLength = Math.cbrt(Math.max(designVolume, 1));
  const count = outcomeCount(settings.resolution);

  const candidates = FRACTION_SPREAD.slice(0, count).map((spread, index) => {
    const fraction = round(
      Math.min(0.9, Math.max(0.05, settings.volumeFraction * spread)),
      2
    );
    const massKg =
      (designVolume * fraction + preservedVolume) * STEEL_DENSITY_KG_PER_MM3;
    // Axial-stiffness proxy: delta = F * L / (E * A_effective).
    const effectiveArea = Math.max(characteristicLength ** 2 * fraction, 1e-6);
    const maxDisplacementMm =
      totalLoad > 0
        ? (totalLoad * characteristicLength) / (YOUNGS_MODULUS_N_PER_MM2 * effectiveArea)
        : 0;
    return { index, fraction, massKg, maxDisplacementMm };
  });

  const worstDisplacement = Math.max(
    ...candidates.map((candidate) => candidate.maxDisplacementMm),
    1e-9
  );
  const stiffnessWeight = settings.objective === 'stiffness' ? 0.65 : 0.35;

  const outcomes: GenerativeOutcome[] = candidates.map((candidate) => {
    const displacementMerit = 1 - candidate.maxDisplacementMm / worstDisplacement;
    const massMerit = 1 - candidate.fraction;
    const score = round(
      100 * (stiffnessWeight * displacementMerit + (1 - stiffnessWeight) * massMerit),
      1
    );
    return {
      id: `outcome_${candidate.index}`,
      name: `Outcome ${OUTCOME_NAMES[candidate.index] ?? candidate.index + 1}`,
      volumeFraction: candidate.fraction,
      massKg: round(candidate.massKg, 3),
      maxDisplacementMm: round(candidate.maxDisplacementMm, 4),
      score,
      previewScale: round(Math.cbrt(candidate.fraction), 3)
    };
  });

  outcomes.sort((a, b) => b.score - a.score);

  return {
    outcomes,
    designVolumeMm3: round(designVolume, 1),
    totalLoadN: round(totalLoad, 1),
    settings,
    generatedAt: new Date().toISOString(),
    solver: 'mock'
  };
}
