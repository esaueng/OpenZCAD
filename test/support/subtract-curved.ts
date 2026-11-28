import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type BodyId } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { meshWindingNumber } from '../../packages/kernel-adapter/src/result-acceptance';

/**
 * The issue #1242 Subtract recipes: OCCT-written STEP operands with
 * `generate.py` beside them, and `reference.json` holding OCCT's own volumes
 * for each operand, the correct cut, the shared material, and a witness point
 * inside both operands that a correct cut removes. None of those figures
 * comes from Remus.
 */
export interface SubtractRecipe {
  target: string;
  tool: string;
  targetVolume: number;
  toolVolume: number;
  cutVolume: number;
  sharedVolume: number;
  witness: [number, number, number];
  witnessClearance: number;
}

// By path rather than `new URL(…, import.meta.url)`: a happy-dom suite
// replaces the global `URL`, which `readFileSync` does not accept.
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/step/subtract-curved'
);

export const subtractFixture = (name: string) =>
  readFileSync(join(FIXTURES, name), 'utf8');

export const SUBTRACT_RECIPES = JSON.parse(
  subtractFixture('reference.json')
) as Record<string, SubtractRecipe>;

/** Volumes agree with OCCT's to a part in a thousand (tessellated measure). */
export function expectVolume(
  actual: number | undefined,
  expected: number
): void {
  expect(actual).toBeDefined();
  expect(Math.abs(actual! - expected)).toBeLessThan(expected * 1e-3);
}

/**
 * Whether a body's display mesh encloses the point. Independent of the
 * kernel's point classifier, which the issue found misplacing the overlap.
 */
export function meshEncloses(
  body: { mesh: { vertices: ArrayLike<number>; indices: ArrayLike<number> } },
  point: readonly number[]
): boolean {
  return (
    meshWindingNumber(
      {
        positions: Float64Array.from(body.mesh.vertices),
        indices: Uint32Array.from(body.mesh.indices)
      },
      point
    ) > 0.5
  );
}

/** A document holding the recipe's two operands, imported target first. */
export function importSubtractRecipe(name: string): {
  manager: CommandManager;
  recipe: SubtractRecipe;
  target: BodyId;
  tool: BodyId;
} {
  const recipe = SUBTRACT_RECIPES[name]!;
  const manager = new CommandManager(
    createProjectDocument(`Subtract ${name}`, toUserId('user_1242'))
  );
  for (const [label, file] of [
    ['Target', recipe.target],
    ['Tool', recipe.tool]
  ] as const) {
    manager.execute(
      commandFactories.importStep({
        name: label,
        artifactId: `artifact_${label.toLowerCase()}`,
        sourceName: file,
        stepText: subtractFixture(file)
      })
    );
  }
  const [target, tool] = manager.document.bodyOrder as [BodyId, BodyId];
  return { manager, recipe, target, tool };
}

/** The Subtract of target − tool, as the Boolean card's Create builds it. */
export function subtractCommand(target: BodyId, tool: BodyId) {
  return commandFactories.booleanBodies({
    name: 'Subtract',
    operation: 'subtract',
    targetBodyIds: [target, tool]
  });
}

/**
 * Executes target − tool straight into history and returns the body the
 * Subtract publishes: a document that holds the Subtract however the
 * kernel answers it now, as one saved while the kernel cut correctly does.
 * The workspace's own Create validates before committing; see
 * `validatedCreate` in `validated-commit.ts`.
 */
export function commitSubtract(
  manager: CommandManager,
  target: BodyId,
  tool: BodyId
): BodyId {
  manager.execute(subtractCommand(target, tool));
  return manager.document.bodyOrder.at(-1)!;
}

/**
 * The solids of a STEP export re-imported into a fresh kernel: each one's
 * volume, and whether its tessellation encloses `point`.
 */
export async function reimportedStepSolids(
  step: string,
  point: readonly number[]
): Promise<{ volume: number; enclosesPoint: boolean }[]> {
  const io = await loadRemusTranslators();
  const kernel = new RemusKernel();
  try {
    return [
      ...kernel.deserializeSolids(io.importStep(new TextEncoder().encode(step)))
    ].map((solid) => {
      const mesh = kernel.tessellateSolid(solid, 0.01);
      try {
        return {
          volume: kernel.volume(solid, 0.01),
          enclosesPoint:
            meshWindingNumber(
              {
                positions: mesh.positions.slice(),
                indices: mesh.indices.slice()
              },
              point
            ) > 0.5
        };
      } finally {
        mesh.free();
      }
    });
  } finally {
    kernel.free();
  }
}
