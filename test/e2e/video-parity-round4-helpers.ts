/** Read-only evidence over the actual UI document; never authors an edit. */
import type { Page } from '@playwright/test';
import type {
  ProjectDocument,
  GeometryBodyRepresentation
} from '@openzcad/shared';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import { inspectTriangleMeshClosure } from '../../packages/kernel-adapter/src/boolean-result-validation';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ObservedBody {
  hash: string;
  bodyId?: string;
  volume?: number;
  faces: number;
  mesh?: { vertices: number[]; indices: number[] };
  geometry: NonNullable<
    GeometryBodyRepresentation['topology']
  >['faces'][number]['geometry'][];
}
export class Round4Oracle {
  private adapter = createExactKernelAdapter({
    resolveSourceBytes: async () =>
      new Uint8Array(
        readFileSync(
          join(process.env.VIDEO_PARITY_INPUT!, 'Gentle-Gecko-W-Fillet.step')
        )
      )
  });
  async assess(page: Page, bodies: ObservedBody[]) {
    const document = await page.evaluate(
      () =>
        (
          window as Window & {
            __parityCommittedDocument?: ProjectDocument;
          }
        ).__parityCommittedDocument
    );
    if (!document) return { error: 'No committed worker document observed' };
    writeFileSync(
      join(
        process.env.VIDEO_PARITY_OUT!,
        `committed-v${document.version}.json`
      ),
      JSON.stringify(document)
    );
    try {
      const adapter = await this.adapter;
      const derived = await adapter.syncDocument(document);
      const id = derived.exportableBodyIds[0]!;
      const probe = adapter as unknown as {
        historyKernel: RemusKernel;
        currentMassSnapshot: { bodies: Map<string, { solid: number }> };
      };
      const solid = probe.currentMassSnapshot.bodies.get(id)?.solid;
      if (solid === undefined)
        return {
          error: 'No single live solid in replay',
          warnings: derived.warnings
        };
      const k = probe.historyKernel;
      const census: Record<string, number> = {};
      for (const f of k.getSolidFaces(solid)) {
        const t = k.getSurfaceType(f);
        census[t] = (census[t] ?? 0) + 1;
      }
      const volume = [0.005, 0.02, 0.1].map((deflection) => ({
        deflection,
        value: k.volume(solid, deflection)
      }));
      const relativeSpread =
        (Math.max(...volume.map((v) => v.value)) -
          Math.min(...volume.map((v) => v.value))) /
        Math.max(1, volume[0]!.value);
      const mesh = bodies[0]?.mesh;
      const meshClosure = mesh
        ? inspectTriangleMeshClosure(mesh.vertices, mesh.indices)
        : null;
      const strictErrors = k.validateSolid(solid);
      const detailed: unknown = k.validateSolidDetailed(solid);
      return {
        projectId: document.projectId,
        version: document.version,
        featureOrder: document.featureOrder,
        visibleBodyId: bodies[0]?.bodyId,
        bodyCount: bodies.length,
        solidCount: derived.exportableBodyIds.length,
        strictErrors,
        detailed,
        meshClosure,
        census,
        volume,
        relativeSpread,
        uiVolume: bodies[0]?.volume,
        warnings: derived.warnings,
        valid:
          strictErrors === 0 &&
          bodies.length === 1 &&
          relativeSpread < 1e-5 &&
          meshClosure?.boundaryEdges === 0 &&
          meshClosure.nonManifoldEdges === 0 &&
          meshClosure.inconsistentWindingEdges === 0
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
  async dispose() {
    (await this.adapter).dispose();
  }
}

/** Real pointer preview, then Escape. Keypad commit is measured separately. */
export async function pointerProbe(
  page: Page,
  target: number,
  cylinder: boolean
) {
  const canvas = page.locator('.viewer-host canvas');
  try {
    const text = await page
      .getByTestId('direct-manipulation-value')
      .innerText();
    const matches = text.match(/[-+]?\d+(?:\.\d+)?/g);
    const displayed = Number(matches?.at(-1));
    const initial = cylinder ? displayed / 2 : displayed;
    const desired = cylinder ? target / 2 : target;
    const h = await canvas.evaluate((c) => {
      const d = c.dataset;
      return {
        x: Number(d.e2eHandleX),
        y: Number(d.e2eHandleY),
        dx: Number(d.e2eHandleDx),
        dy: Number(d.e2eHandleDy),
        ppu: Number(d.e2eHandlePixelsPerUnit)
      };
    });
    if (!Number.isFinite(initial) || !(h.ppu > 0))
      return { error: 'No readable pointer handle', text };
    const box = (await canvas.boundingBox())!;
    await page.evaluate(() => {
      (window as Window & { __ozFaceDragTrace?: unknown[] }).__ozFaceDragTrace =
        [];
    });
    await page.mouse.move(box.x + h.x, box.y + h.y);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    await page.mouse.move(
      box.x + h.x + h.dx * h.ppu * (desired - initial),
      box.y + h.y + h.dy * h.ppu * (desired - initial)
    );
    await page.waitForFunction(
      () => {
        const t =
          (
            window as Window & {
              __ozFaceDragTrace?: {
                kind: string;
                t: number;
                detail?: { presented?: number };
              }[];
            }
          ).__ozFaceDragTrace ?? [];
        const p = t.find((e) => e.kind === 'publish');
        return (
          t.some((e) => e.kind === 'refusal') ||
          [...document.querySelectorAll('.edit-refusal-line')].some(
            (e) =>
              e.textContent?.includes('Solid unchanged') &&
              e.getClientRects().length > 0
          ) ||
          (p &&
            t.some(
              (e) =>
                e.kind === 'frame' && e.t > p.t && e.detail?.presented === 1
            ))
        );
      },
      undefined,
      { timeout: 60_000 }
    );
    return await page.evaluate(() => {
      const t =
        (
          window as Window & {
            __ozFaceDragTrace?: {
              kind: string;
              t: number;
              value?: number;
              detail?: { presented?: number };
            }[];
          }
        ).__ozFaceDragTrace ?? [];
      const pointer = t.find((e) => e.kind === 'pointer'),
        publish = t.find((e) => e.kind === 'publish');
      const frame =
        publish &&
        t.find(
          (e) =>
            e.kind === 'frame' && e.t > publish.t && e.detail?.presented === 1
        );
      return {
        pointerToFrameMs: pointer && frame ? frame.t - pointer.t : null,
        value: pointer?.value,
        trace: t
      };
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.keyboard.up('Shift');
  }
}
