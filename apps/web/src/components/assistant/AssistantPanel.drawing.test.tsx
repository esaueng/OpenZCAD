import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import type {
  CadDigestDrawing,
  CadPatchProposal
} from '@openzcad/ai-contracts';
import { toUserId } from '@openzcad/shared';
import { AssistantPanel } from './AssistantPanel';

/**
 * D06 slice E: asked from Draw, the assistant reads the sheet the app
 * supplies and proposes dimensions on it by the edge refs listed there. The
 * reply is checked against that sheet before it is previewed, and the
 * proposal that reaches Apply names the model edges, not the refs.
 */

const doc = createProjectDocument('Plate', toUserId('user_a'));

const line = (
  ref: string,
  hash: number,
  ends: [[number, number], [number, number]]
) => ({
  ref,
  bodyId: 'body_plate',
  hash,
  curve: 'line' as const,
  length: 20,
  ends
});

const drawing: CadDigestDrawing = {
  sheetId: 'dsht_one',
  name: 'Sheet 1',
  units: 'mm',
  scale: '2:1',
  paperMm: { width: 420, height: 297 },
  ready: true,
  views: [
    {
      viewId: 'dvw_front',
      orientation: 'front',
      parentViewId: null,
      centerMm: { x: 120, y: 150 },
      widthMm: 40,
      heightMm: 20,
      bodyIds: ['body_plate'],
      edgeInventoryComplete: true,
      edges: [
        line('v1:e1', 101, [
          [-20, 10],
          [20, 10]
        ]),
        line('v1:e2', 102, [
          [20, -10],
          [20, 10]
        ])
      ]
    }
  ],
  annotations: []
};

const linear = (
  ref: string,
  direction: string,
  placementMm: { x: number; y: number }
) => ({
  annotationKind: 'linear',
  viewId: 'dvw_front',
  direction,
  from: { edgeRef: ref, anchor: 'first' },
  to: { edgeRef: ref, anchor: 'second' },
  edgeRefs: [],
  text: null,
  placementMm,
  decimals: null
});

const proposal = {
  proposalId: 'dimension_plate',
  summary: 'Dimension the plate: width and height.',
  assumptions: [],
  preserveGeometry: false,
  operations: [
    {
      kind: 'add_drawing_annotations',
      sheetId: 'dsht_one',
      annotations: [
        linear('v1:e1', 'horizontal', { x: 0, y: 16 }),
        linear('v1:e2', 'vertical', { x: 30, y: 0 })
      ]
    }
  ]
};

/** A Responses-compatible stream that answers every ask with `proposal`. */
function fakeProvider() {
  const body = `data: ${JSON.stringify({
    type: 'response.output_text.done',
    text: JSON.stringify({
      replyKind: 'patch',
      proposal,
      questions: null,
      message: null,
      readings: null
    })
  })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`;
  const fetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

async function ask(
  overrides: Partial<ComponentProps<typeof AssistantPanel>> = {}
) {
  const fetch = fakeProvider();
  const props: ComponentProps<typeof AssistantPanel> = {
    document: doc,
    selection: { bodyIds: [], featureIds: [], topologies: [] },
    drawingDigest: () => drawing,
    onApply: vi.fn().mockResolvedValue(true),
    onPreview: vi.fn().mockResolvedValue({ ok: true }),
    collapsed: false,
    onCollapsedChange: vi.fn(),
    confirmDestructive: false,
    effectiveAssistant: {
      configured: true,
      provider: 'openai',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium'
    },
    ...overrides
  };
  const view = render(<AssistantPanel {...props} />);
  await act(async () => {
    view.rerender(
      <AssistantPanel
        {...props}
        request={{ id: 1, text: 'Add the dimensions' }}
      />
    );
  });
  return { fetch, props };
}

describe('the assistant on a Draw sheet', () => {
  it('proposes two dimensions on the sheet and applies them', async () => {
    const { fetch, props } = await ask();
    await screen.findByText('Dimension the plate: width and height.');

    // The sheet went out with the ask: its views, edges and refs.
    const request = fetch.mock.calls.find(
      ([input]) =>
        typeof input === 'string' && input.includes('/api/assistant/proposals')
    );
    const sent = JSON.parse(request?.[1]?.body as string) as {
      digest: { drawing?: CadDigestDrawing };
    };
    expect(sent.digest.drawing).toEqual(drawing);

    // Previewed only once grounded on the sheet's edges.
    const previewed = vi.mocked(props.onPreview).mock.calls.at(-1)?.[0];
    expect(previewed?.operations).toEqual([
      expect.objectContaining({
        kind: 'add_drawing_annotations',
        edges: {
          'v1:e1': { bodyId: 'body_plate', hash: 101 },
          'v1:e2': { bodyId: 'body_plate', hash: 102 }
        }
      })
    ]);
    expect(
      screen.getByText('Add 2 dimensions to the sheet')
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Apply/ }));
    await waitFor(() => expect(props.onApply).toHaveBeenCalledOnce());
    expect(vi.mocked(props.onApply).mock.calls[0]![0]).toEqual(previewed);
  });

  it('does not show a proposal the sheet check refuses', async () => {
    const onPreview = vi.fn(async (next: CadPatchProposal | null) =>
      next
        ? {
            ok: false as const,
            reason: 'Proposed annotation 2 (linear): no span to dimension.'
          }
        : { ok: true as const }
    );
    const { props } = await ask({ onPreview });
    expect(
      await screen.findAllByText(/did not pass exact geometry preflight/)
    ).not.toHaveLength(0);
    expect(screen.getAllByText(/no span to dimension/)).not.toHaveLength(0);
    expect(
      screen.queryByText('Dimension the plate: width and height.')
    ).not.toBeInTheDocument();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('refuses refs the sheet does not list before any preview', async () => {
    const { props } = await ask({
      drawingDigest: () => ({
        ...drawing,
        views: [{ ...drawing.views[0]!, edges: [] }]
      })
    });
    // The stream reports it as a reply it could not use, as it does any
    // reference the digest does not back.
    expect(
      await screen.findAllByText(/invalid structured output/)
    ).not.toHaveLength(0);
    expect(props.onPreview).not.toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: 'dimension_plate' })
    );
  });
});
