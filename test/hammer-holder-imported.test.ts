/** Opt-in private-fixture integration; the STEP bytes are never committed. */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  createProjectDocument,
  normalizeDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { parseCadPatchProposal } from '@openzcad/ai-contracts';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  composeCommands
} from '@openzcad/command-system';
import { sanitizeStepHeaderPrivacy } from '@openzcad/io-step';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { buildDocumentHistory } from '../packages/kernel-adapter/src/exact-build-loop';
import { inspectTriangleMeshClosure } from '../packages/kernel-adapter/src/boolean-result-validation';
import { parseProjectBackup } from '../apps/web/src/lib/projectBackup';

const path = process.env.OPENZCAD_HAMMER_STEP;
it.skipIf(!path)(
  'replays the imported hammer opening through reviewed AI commands',
  async () => {
    const width = Number(process.env.OPENZCAD_HAMMER_WIDTH ?? 50);
    const io = await loadRemusTranslators();
    const kernel = new RemusKernel();
    const manager = new CommandManager(
      createProjectDocument('Hammer opening', toUserId('local_hammer'))
    );
    const stepText = sanitizeStepHeaderPrivacy(
      readFileSync(path!, 'utf8'),
      'hammer-holder.step'
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Hammer source',
        artifactId: 'hammer_source',
        sourceName: 'hammer-holder.step',
        stepText
      })
    );
    const original = manager.document;
    const proposal = parseCadPatchProposal({
      proposalId: 'hammer_opening_v1',
      summary: `Set the opening to ${width} mm`,
      assumptions: [
        'Measured source spacing is 46 mm; preserve the outer body and mounting bores.',
        'This recipe is qualified for this holder and the original 46 mm and edited 50 mm widths only.'
      ],
      operations: [
        {
          kind: 'set_parameter',
          name: 'opening_width',
          expression: String(width)
        },
        {
          kind: 'add_imported_opening_recipe',
          name: 'Hammer opening',
          localId: 'opened',
          targetBodyId: original.bodyOrder[0],
          axis: 'x',
          sourceWidth: 46,
          editedWidth: 50,
          width: 'opening_width',
          regions: [
            { min: { x: -18, y: -10, z: 0 }, max: { x: 11, y: 43, z: 70 } },
            { min: { x: 11, y: -10, z: 0 }, max: { x: 40, y: 43, z: 70 } }
          ]
        }
      ]
    });
    manager.execute(
      composeCommands(
        'Parameterize opening',
        commandsForCadPatch(original, proposal)
      )
    );
    const document = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    try {
      const build = buildDocumentHistory(kernel, document);
      expect(build.warnings).toEqual([]);
      const final = build.shapes.get(document.bodyOrder.at(-1)!)?.solids;
      expect(final).toHaveLength(1);
      const solid = final![0]!;
      expect(kernel.validateSolid(solid)).toBe(0);
      Array.from(kernel.boundingBox(solid)).forEach((v, i) =>
        expect(v).toBeCloseTo([-26, 6.5, 4.5, 48, 59.5, 62.5][i]!, 6)
      );
      const mesh = kernel.tessellateSolid(solid, 0.05);
      try {
        expect(
          inspectTriangleMeshClosure(mesh.positions, mesh.indices)
        ).toMatchObject({
          boundaryEdges: 0,
          nonManifoldEdges: 0,
          inconsistentWindingEdges: 0
        });
      } finally {
        mesh.free();
      }
      const exported = io.exportStep(
        kernel.serializeSolids(new Uint32Array([solid]))
      );
      const restored = kernel.deserializeSolids(io.importStep(exported));
      expect(restored).toHaveLength(1);
      expect(kernel.validateSolid(restored[0]!)).toBe(0);
      for (const current of [solid, restored[0]!]) {
        const faces = Array.from(kernel.getSolidFaces(current));
        const bores = faces.filter((face) => {
          const surface = JSON.parse(kernel.getAnalyticSurfaceParams(face)) as {
            type: string;
            radius?: number;
          };
          return (
            surface.type === 'cylinder' &&
            typeof surface.radius === 'number' &&
            Math.abs(surface.radius - 2.5) < 1e-7
          );
        });
        expect(bores).toHaveLength(2);
        for (const x of [11 - width / 2, 11 + width / 2]) {
          expect(
            faces.some((face) => {
              if (
                (
                  JSON.parse(kernel.getAnalyticSurfaceParams(face)) as {
                    type: string;
                  }
                ).type !== 'plane'
              )
                return false;
              const vertices = Array.from(kernel.getFaceVertices(face));
              return (
                vertices.length >= 4 &&
                vertices.every(
                  (v) => Math.abs(kernel.getVertexPosition(v)[0]! - x) < 1e-7
                )
              );
            }),
            `opening wall x=${x}`
          ).toBe(true);
        }
      }
      const volume = kernel.volume(solid, 0.01);
      expect(volume).toBeGreaterThan(0);
      expect(Math.abs(kernel.volume(restored[0]!, 0.01) - volume)).toBeLessThan(
        volume * 1e-6
      );
      const backup = {
        format: 'openzcad-project',
        version: 1,
        document: withoutDerivedProjection(document),
        files: [],
        sources: [],
        saveStates: []
      };
      const text = JSON.stringify(backup);
      expect((await parseProjectBackup(text)).document.featureOrder).toEqual(
        document.featureOrder
      );
      if (process.env.OPENZCAD_HAMMER_OUTPUT)
        writeFileSync(process.env.OPENZCAD_HAMMER_OUTPUT, text);
      manager.undo();
      expect(manager.document.featureOrder).toEqual(original.featureOrder);
      manager.redo();
      expect(manager.document.featureOrder).toEqual(document.featureOrder);
    } finally {
      kernel.free();
    }
  },
  600_000
);
