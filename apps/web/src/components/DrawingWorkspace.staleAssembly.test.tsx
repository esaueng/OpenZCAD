import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingViewId,
  type ProjectDocument
} from '@openzcad/shared';
import { DrawingWorkspace, resetRetainedProjections } from './DrawingWorkspace';
import { projectionBodyInput } from '../lib/drawing/sheetSources';
import type { ProjectionBodyInput } from '../lib/drawing/projectView';
import type * as DesktopBridge from '../lib/desktopBridge';

/**
 * #2115: a stale exploded sheet exports one assembly state. Its views keep
 * drawing the assembly they were drawn from until Update, and so do its
 * parts list and balloons: removing a part in Assemble neither drops its
 * row nor renumbers the balloons beside the drawing that still shows it.
 */

const saved = vi.hoisted(() => [] as string[]);
vi.mock('../lib/desktopBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof DesktopBridge>();
  return {
    ...actual,
    saveCadTextFile: vi.fn((_name: string, _format: string, text: string) => {
      saved.push(text);
      return Promise.resolve(true);
    })
  };
});

/** An `x0`-based box `width` × 20 × 10, its hashes offset by `salt`. */
function box(
  bodyId: BodyId,
  name: string,
  x0: number,
  width: number,
  salt: number
): BodyRepresentation {
  const [a, b, d, h] = [x0, x0 + width, 20, 10];
  const corners = [
    [a, 0, 0],
    [b, 0, 0],
    [b, d, 0],
    [a, d, 0],
    [a, 0, h],
    [b, 0, h],
    [b, d, h],
    [a, d, h]
  ];
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [1, 2, 6, 5],
    [0, 4, 7, 3]
  ];
  const pairs = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7]
  ];
  return {
    bodyId,
    name,
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from(corners.flat()),
      indices: Uint32Array.from(
        quads.flatMap(([p, q, r, s]) => [p!, q!, r!, p!, r!, s!])
      )
    },
    faceCount: 6,
    color: '#888888',
    exportableStep: true,
    consumed: false,
    volume: width * d * h,
    bbox: { min: { x: a, y: 0, z: 0 }, max: { x: b, y: d, z: h } },
    topology: {
      faces: quads.map((_, index) => ({
        topologyId: `f${index}`,
        hash: salt + 100 + index,
        triangleStart: index * 2,
        triangleCount: 2
      })),
      edges: pairs.map(([p, q], index) => ({
        topologyId: `e${index}`,
        hash: salt + 200 + index,
        points: [...corners[p!]!, ...corners[q!]!]
      }))
    }
  };
}

/** A base and two rails, each rail pulled out along X. */
function railAssembly() {
  const manager = new CommandManager(
    createProjectDocument('Rails', toUserId('test'))
  );
  for (const name of ['Base', 'Left rail', 'Right rail'])
    manager.execute(
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 20 }
      })
    );
  const [base, left, right] = manager.document.bodyOrder as [
    BodyId,
    BodyId,
    BodyId
  ];
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: [
        { componentId: 'c_base', name: 'Base', bodyId: base, grounded: true },
        {
          componentId: 'c_left',
          name: 'Left rail',
          bodyId: left,
          grounded: false
        },
        {
          componentId: 'c_right',
          name: 'Right rail',
          bodyId: right,
          grounded: false
        }
      ]
    })
  );
  manager.execute(
    commandFactories.setAssemblyExplode({
      offsets: {
        c_left: { x: -40, y: 0, z: 0 },
        c_right: { x: 40, y: 0, z: 0 }
      }
    })
  );
  const bodies: Record<string, BodyRepresentation> = {
    [base]: box(base, 'Base Body', 0, 60, 0),
    [left]: box(left, 'Left rail Body', -15, 10, 1000),
    [right]: box(right, 'Right rail Body', 65, 10, 2000)
  };
  return { manager, bodies, base, left, right };
}

function tessellation(bodies: Record<string, BodyRepresentation>) {
  return (
    _document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<Record<string, ProjectionBodyInput>> =>
    Promise.resolve(
      Object.fromEntries(
        bodyIds.flatMap((id) => {
          const input = bodies[id] ? projectionBodyInput(bodies[id]) : null;
          return input ? [[id, input]] : [];
        })
      )
    );
}

function workspace(
  document: ProjectDocument,
  bodies: Record<string, BodyRepresentation>
) {
  const shown = {
    ...document,
    derived: { ...document.derived, bodyRepresentations: bodies }
  };
  return (
    <DrawingWorkspace
      document={shown}
      bodies={bodies}
      geometryPending={false}
      defaultBodyIds={Object.keys(bodies) as BodyId[]}
      requestTessellation={tessellation(bodies)}
      editDisabledReason={null}
      onCommand={vi.fn(() => true)}
      onStatus={vi.fn()}
    />
  );
}

function svgTexts(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);
}

async function exportedSvg(): Promise<string> {
  const before = saved.length;
  const button = screen.getByRole('button', { name: 'Export SVG' });
  await waitFor(() => expect(button).not.toBeDisabled());
  await userEvent.click(button);
  await waitFor(() => expect(saved.length).toBe(before + 1));
  return saved.at(-1)!;
}

describe('DrawingWorkspace: a stale exploded sheet (#2115)', () => {
  beforeEach(() => {
    resetRetainedProjections();
    saved.length = 0;
  });
  afterEach(cleanup);

  it('exports the parts list and balloons of the assembly its views drew', async () => {
    const { manager, bodies, base, left, right } = railAssembly();
    const ids = [base, left, right];
    const sheet: DrawingSheet = {
      sheetId: 'dsht_rails' as DrawingSheetId,
      name: 'Sheet 1',
      paper: { size: 'A3', orientation: 'landscape' },
      scale: { numerator: 1, denominator: 2 },
      projectionAngle: 'first',
      titleBlock: {},
      source: { fingerprint: 'v1:pending' },
      views: [
        {
          viewId: 'dvw_front' as DrawingViewId,
          orientation: 'front',
          bodyIds: ids,
          centerMm: { x: 200, y: 170 },
          hiddenLines: false,
          exploded: true
        }
      ],
      annotations: [
        {
          annotationId: 'dann_list' as DrawingAnnotationId,
          kind: 'bom-table',
          placementMm: { x: 20, y: 120 }
        },
        {
          annotationId: 'dann_right' as DrawingAnnotationId,
          kind: 'balloon',
          viewId: 'dvw_front' as DrawingViewId,
          leader: { bodyId: right, hash: 2000 + 204 },
          componentId: 'c_right',
          placementMm: { x: 60, y: 30 }
        }
      ] satisfies DrawingAnnotation[]
    };
    // Fenced to the model as drawn, by the sheet's own Update.
    const onCommand = vi.fn(() => true);
    const document = { ...manager.document, drawings: { sheets: [sheet] } };
    const first = render(
      <DrawingWorkspace
        {...workspace(document, bodies).props}
        onCommand={onCommand}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /Update/ }));
    const { source } = (
      onCommand.mock.calls[0] as unknown as [
        { payload: { source: DrawingSheet['source'] } }
      ]
    )[0].payload;
    first.unmount();
    const fenced: DrawingSheet = { ...sheet, source };
    const fresh = render(
      workspace({ ...manager.document, drawings: { sheets: [fenced] } }, bodies)
    );
    const drawn = await exportedSvg();
    const listed = svgTexts(drawn);
    expect(listed.some((text) => text.includes('Left rail'))).toBe(true);
    fresh.unmount();

    // Assemble removes the unballooned left rail; Draw is not updated.
    manager.execute(
      commandFactories.deleteAssemblyComponent({ componentId: 'c_left' })
    );
    render(
      workspace({ ...manager.document, drawings: { sheets: [fenced] } }, bodies)
    );
    expect(screen.getByRole('status')).toHaveTextContent('Model changed');
    const stale = await exportedSvg();
    // The kept views still draw the left rail, and the parts list and the
    // right rail's balloon are the ones drawn with them: one state.
    expect(svgTexts(stale)).toEqual(listed);
    expect(stale).toBe(drawn);
  });
});
