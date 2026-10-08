import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import type { CadPatchProposal } from '@openzcad/ai-contracts';
import { toBodyId, toUserId } from '@openzcad/shared';
import {
  loadAssistantThread,
  saveAssistantThread
} from '../../lib/assistant/history';
import {
  sendAssistantPromptFiles,
  sendAssistantPromptKey
} from '../../lib/assistant/promptKeys';
import { AssistantPanel } from './AssistantPanel';

const doc = createProjectDocument('Bracket', toUserId('user_a'));

function allEdgeDocument() {
  const document = addPrimitiveFeature(
    createProjectDocument('Block', toUserId('user_a')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 30, depth: 20 }
    }
  );
  const bodyId = document.bodyOrder[0]!;
  document.derived.bodyRepresentations[bodyId] = {
    bodyId,
    name: 'Block Body',
    source: 'primitive',
    consumed: false,
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array(),
      indices: new Uint32Array()
    },
    faceCount: 6,
    color: '#ffffff',
    exportableStep: true,
    volume: 24000,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 30, z: 20 } },
    topology: {
      faces: [],
      edges: Array.from({ length: 12 }, (_, index) => ({
        topologyId: `edge:${index + 1}`,
        hash: index + 1,
        points: []
      }))
    }
  };
  return document;
}

function seedThread() {
  saveAssistantThread(
    doc.projectId,
    [
      {
        kind: 'user',
        id: 'entry_one',
        text: 'Put a 6 mm hole through the boss',
        attachments: [],
        answers: [],
        at: 1
      },
      {
        kind: 'message',
        id: 'entry_two',
        text: 'Done — the hole is through the boss.',
        tone: 'info',
        at: 2
      }
    ],
    2
  );
}

async function renderPanel(
  overrides: Partial<ComponentProps<typeof AssistantPanel>> = {}
) {
  const user = userEvent.setup();
  render(
    <AssistantPanel
      document={doc}
      selection={{ bodyIds: [], featureIds: [], topologies: [] }}
      onApply={vi.fn().mockResolvedValue(true)}
      onPreview={vi.fn().mockResolvedValue({ ok: true })}
      collapsed={false}
      onCollapsedChange={vi.fn()}
      confirmDestructive
      {...overrides}
    />
  );
  const clear = await screen.findByRole('button', {
    name: "Clear this project's conversation"
  });
  return { user, clear };
}

beforeEach(() => {
  window.localStorage.clear();
  seedThread();
  // The panel asks the Worker what model is configured on mount. Nothing here
  // depends on the answer, and an unstubbed fetch is a noisy rejection.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The trash icon sits in the panel header beside "collapse", one click from
 * anywhere, and it used to run straight through. What it discards is every
 * drawing attached to the conversation and every reason the model was built
 * the way it was — held only in this thread, copied nowhere, and not covered
 * by document undo, which knows about geometry rather than about the thread.
 */
describe('clearing the assistant conversation', () => {
  it('asks first, and keeps the thread when the answer is no', async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    const { user, clear } = await renderPanel();

    await user.click(clear);

    expect(confirm).toHaveBeenCalledOnce();
    expect(loadAssistantThread(doc.projectId)).toHaveLength(2);
    expect(
      screen.getByText('Put a 6 mm hole through the boss')
    ).toBeInTheDocument();
  });

  it('clears the thread when the answer is yes', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const { user, clear } = await renderPanel();

    await user.click(clear);

    await waitFor(() =>
      expect(loadAssistantThread(doc.projectId)).toHaveLength(0)
    );
    expect(screen.queryByText('Put a 6 mm hole through the boss')).toBeNull();
  });

  it('does not ask when the user has turned confirmations off', async () => {
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirm);
    const { user, clear } = await renderPanel({ confirmDestructive: false });

    await user.click(clear);

    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(loadAssistantThread(doc.projectId)).toHaveLength(0)
    );
  });
});

describe('selected geometry analysis', () => {
  it('requires one selected part before starting geometry work', async () => {
    const onAnalyze = vi.fn();
    const { user } = await renderPanel({ onAnalyze });
    await user.click(
      screen.getByRole('button', { name: 'Analyze selected geometry' })
    );
    expect(onAnalyze).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Select one part and optionally one or two faces to analyze.'
      )
    ).toBeInTheDocument();
  });

  it('ignores analysis completing after the document changes', async () => {
    let finish!: (derived: typeof doc.derived) => void;
    const onAnalyze = vi.fn(
      () =>
        new Promise<typeof doc.derived>((resolve) => {
          finish = resolve;
        })
    );
    const props: ComponentProps<typeof AssistantPanel> = {
      document: doc,
      selection: { bodyIds: ['selected-part'], featureIds: [], topologies: [] },
      onApply: vi.fn().mockResolvedValue(true),
      onPreview: vi.fn().mockResolvedValue({ ok: true }),
      onAnalyze,
      collapsed: false,
      onCollapsedChange: vi.fn(),
      confirmDestructive: false
    };
    const user = userEvent.setup();
    const { rerender } = render(<AssistantPanel {...props} />);
    await user.click(
      await screen.findByRole('button', { name: 'Analyze selected geometry' })
    );
    expect(onAnalyze).toHaveBeenCalledWith(doc, {
      bodyId: 'selected-part',
      faceHashes: []
    });
    rerender(
      <AssistantPanel
        {...props}
        document={{ ...doc, version: doc.version + 1 }}
      />
    );
    await act(async () => {
      finish(doc.derived);
    });
    expect(screen.queryByText(/Analysis complete/)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Analyze selected geometry' })
    ).toBeEnabled();
  });
});

describe('local whole-part fillets', () => {
  it('previews a typed all-edge request without a configured provider, then applies the complete proposal', async () => {
    const document = allEdgeDocument();
    const onPreview = vi
      .fn<ComponentProps<typeof AssistantPanel>['onPreview']>()
      .mockResolvedValue({ ok: true });
    const onApply = vi.fn().mockResolvedValue(true);
    const { user } = await renderPanel({
      document,
      onPreview,
      onApply,
      request: { id: 1, text: 'add a filet on all edges by 1 mm' }
    });
    const apply = await screen.findByRole('button', {
      name: /^Apply$/
    });
    const proposal = onPreview.mock.calls.find(([value]) => value != null)?.[0];
    expect(proposal?.operations).toHaveLength(1);
    expect(proposal?.operations[0]).toMatchObject({
      targetBodyId: document.bodyOrder[0],
      size: 1,
      edgeHashes: Array.from({ length: 12 }, (_, index) => index + 1)
    });
    expect(onApply).not.toHaveBeenCalled();
    await user.click(apply);
    expect(onApply).toHaveBeenCalledWith(proposal);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([url]) =>
            typeof url === 'string' && url.includes('/api/assistant/proposals')
        )
    ).toBe(false);
  });

  it('keeps a refused whole-part preview out of the apply path', async () => {
    const onApply = vi.fn();
    await renderPanel({
      document: allEdgeDocument(),
      onApply,
      onPreview: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'Unsupported corner blend.' }),
      request: { id: 2, text: 'Fillet all edges' }
    });
    expect(
      await screen.findByText(/Unsupported corner blend/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Apply$/ })).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe('assistant model settings', () => {
  it('updates the model and reasoning after a save without clearing the conversation', async () => {
    const props: ComponentProps<typeof AssistantPanel> = {
      document: doc,
      selection: { bodyIds: [], featureIds: [], topologies: [] },
      onApply: vi.fn().mockResolvedValue(true),
      onPreview: vi.fn().mockResolvedValue({ ok: true }),
      collapsed: false,
      onCollapsedChange: vi.fn(),
      confirmDestructive: true,
      effectiveAssistant: {
        configured: true,
        provider: 'openai',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'medium'
      }
    };
    const { rerender } = render(<AssistantPanel {...props} />);
    expect(screen.getByText('gpt-5.6-sol · medium')).toBeInTheDocument();

    rerender(
      <AssistantPanel
        {...props}
        effectiveAssistant={{
          ...props.effectiveAssistant!,
          model: 'openai/gpt-5.6-terra',
          reasoningEffort: 'high'
        }}
      />
    );

    expect(screen.getByText('gpt-5.6-terra · high')).toBeInTheDocument();
    expect(screen.queryByText('gpt-5.6-sol · medium')).toBeNull();
    expect(
      screen.getByText('Put a 6 mm hole through the boss')
    ).toBeInTheDocument();
    expect(loadAssistantThread(doc.projectId)).toHaveLength(2);
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores a stale initial status request after account settings arrive', async () => {
    let resolveStatus!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveStatus = resolve;
          })
      )
    );
    const props: ComponentProps<typeof AssistantPanel> = {
      document: doc,
      selection: { bodyIds: [], featureIds: [], topologies: [] },
      onApply: vi.fn().mockResolvedValue(true),
      onPreview: vi.fn().mockResolvedValue({ ok: true }),
      collapsed: false,
      onCollapsedChange: vi.fn(),
      confirmDestructive: true
    };
    const { rerender } = render(<AssistantPanel {...props} />);
    rerender(
      <AssistantPanel
        {...props}
        effectiveAssistant={{
          configured: true,
          provider: 'openai',
          model: 'gpt-5.6-terra',
          reasoningEffort: 'high'
        }}
      />
    );
    await act(async () => {
      resolveStatus(
        new Response(
          JSON.stringify({
            configured: true,
            provider: 'openai',
            model: 'gpt-5.6-sol',
            reasoningEffort: 'medium'
          })
        )
      );
    });
    expect(screen.getByText('gpt-5.6-terra · high')).toBeInTheDocument();
    expect(screen.queryByText('gpt-5.6-sol · medium')).toBeNull();
  });
});

/**
 * Search and the assistant are one prompt line: a question typed into it
 * arrives here as a request, and the stream stands on the bar or is tucked
 * away behind it.
 */
describe('asking from the prompt line', () => {
  const configured = {
    configured: true,
    provider: 'openai',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium'
  } as const;

  function panelProps(
    overrides: Partial<ComponentProps<typeof AssistantPanel>> = {}
  ): ComponentProps<typeof AssistantPanel> {
    return {
      document: doc,
      selection: { bodyIds: [], featureIds: [], topologies: [] },
      onApply: vi.fn().mockResolvedValue(true),
      onPreview: vi.fn().mockResolvedValue({ ok: true }),
      collapsed: false,
      onCollapsedChange: vi.fn(),
      confirmDestructive: true,
      ...overrides
    };
  }

  it('sends the question as a turn, once per request id', async () => {
    const props = panelProps({ effectiveAssistant: configured });
    const { rerender } = render(<AssistantPanel {...props} />);
    await act(async () => {});

    const request = { id: 1, text: '  Why is the wall so thin?  ' };
    await act(async () => {
      rerender(<AssistantPanel {...props} request={request} />);
    });
    expect(await screen.findAllByText('Why is the wall so thin?')).toHaveLength(
      1
    );
    expect(fetch).toHaveBeenCalled();

    // The same id again — any re-render of the app — does not ask twice.
    const calls = vi.mocked(fetch).mock.calls.length;
    await act(async () => {
      rerender(<AssistantPanel {...props} request={{ ...request }} />);
    });
    expect(screen.getAllByText('Why is the wall so thin?')).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
  });

  it('hands the question back to the prompt line when it cannot take it', async () => {
    const onDraft = vi.fn();
    render(
      <AssistantPanel
        {...panelProps({ onDraft })}
        request={{ id: 1, text: 'Why is the wall so thin?' }}
      />
    );
    await waitFor(() =>
      expect(onDraft).toHaveBeenCalledWith('Why is the wall so thin?')
    );
    // Waiting, not sent: no turn carries it, and the reason is on screen.
    expect(screen.queryAllByText('Why is the wall so thin?')).toHaveLength(0);
    // The hand-back fires on mount, before the status load settles, so the
    // reason arrives later than the draft does.
    expect(await screen.findAllByRole('status')).not.toHaveLength(0);
  });

  it('offers its openers as drafts for the prompt line', async () => {
    window.localStorage.clear();
    const onDraft = vi.fn();
    const user = userEvent.setup();
    render(<AssistantPanel {...panelProps({ onDraft })} />);
    const opener = await screen.findByRole('button', {
      name: /80 × 60 × 6 mm plate/
    });
    await user.click(opener);
    expect(onDraft).toHaveBeenCalledWith(
      expect.stringMatching(/80 × 60 × 6 mm plate/)
    );
  });

  it('renders nothing while tucked away and reports what the prompt line shows', () => {
    const onActivity = vi.fn();
    const { container } = render(
      <AssistantPanel
        {...panelProps({
          collapsed: true,
          onActivity,
          selection: {
            bodyIds: [],
            featureIds: [],
            topologies: [
              { kind: 'edge', bodyId: toBodyId('b'), hash: 1 },
              { kind: 'edge', bodyId: toBodyId('b'), hash: 2 }
            ]
          }
        })}
      />
    );
    expect(container).toBeEmptyDOMElement();
    expect(onActivity).toHaveBeenLastCalledWith({
      thinking: false,
      unread: 0,
      context: '2 selected edges',
      unavailable: false
    });
  });
});

describe('selection grounding for assistant follow-ups', () => {
  it('carries the originating selection intent through a clarification answer', async () => {
    window.localStorage.clear();
    const document = allEdgeDocument();
    const bodyId = document.bodyOrder[0]!;
    saveAssistantThread(
      document.projectId,
      [
        {
          kind: 'user',
          id: 'initial_request',
          text: 'Fillet all selected edges',
          attachments: [],
          answers: [],
          at: 1
        },
        {
          kind: 'questions',
          id: 'clarification',
          preamble: 'How large should the fillet be?',
          questions: [
            {
              id: 'radius',
              prompt: 'Fillet size',
              options: [{ label: '5 mm', value: '5 mm' }],
              allowFreeText: true,
              unit: 'mm'
            }
          ],
          answers: {},
          sent: false,
          at: 2
        }
      ],
      2
    );

    const proposal = {
      proposalId: 'followup_wrong_edge_guess',
      summary: 'Fillet the selected edges.',
      assumptions: [],
      operations: [
        {
          kind: 'add_edge_modifier',
          name: 'Selected edge fillets',
          localId: null,
          modifier: 'fillet',
          targetBodyId: 'body_other',
          edgeHashes: [999],
          size: 5
        }
      ]
    };
    const streamBody = `data: ${JSON.stringify({
      type: 'response.output_text.done',
      text: JSON.stringify({
        replyKind: 'patch',
        proposal,
        questions: null,
        message: null,
        readings: null
      })
    })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        (input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
        ).includes('/api/assistant/proposals')
          ? new Response(streamBody, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' }
            })
          : new Response(JSON.stringify({ configured: true }))
      )
    );
    const user = userEvent.setup();
    const onPreview = vi.fn(async (_proposal: CadPatchProposal | null) => ({
      ok: true as const
    }));
    render(
      <AssistantPanel
        document={document}
        selection={{
          bodyIds: [bodyId],
          featureIds: [],
          topologies: [
            { bodyId, kind: 'edge', topologyId: 'edge:1', hash: 1 },
            { bodyId, kind: 'edge', topologyId: 'edge:2', hash: 2 }
          ]
        }}
        onApply={vi.fn().mockResolvedValue(true)}
        onPreview={onPreview}
        collapsed={false}
        onCollapsedChange={vi.fn()}
        confirmDestructive
        effectiveAssistant={{
          configured: true,
          provider: 'openai',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'medium'
        }}
      />
    );

    await user.click(await screen.findByRole('button', { name: '5 mm' }));
    await user.click(screen.getByRole('button', { name: 'Build it' }));

    await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(2));
    expect(onPreview.mock.calls.at(-1)?.[0]).toMatchObject({
      operations: [
        expect.objectContaining({
          kind: 'add_edge_modifier',
          targetBodyId: bodyId,
          edgeHashes: [1, 2],
          size: 5
        })
      ]
    });
  });
});

/**
 * The proposal waiting at the foot of the stream is driven from the empty
 * prompt line: Enter applies, `p` previews, Escape rejects. The keys arrive
 * as window events the bar sends, and the stream says when it took one.
 * A restored proposal reopens as rejected, so the open one comes from a
 * stubbed reply.
 */
describe('prompt keys on the open proposal', () => {
  const proposal = {
    proposalId: 'proposal_keys',
    summary: 'Add a 10 mm cube.',
    assumptions: [],
    operations: [
      {
        kind: 'add_primitive',
        name: 'Assistant Cube',
        localId: null,
        primitiveKind: 'box',
        dimensions: {
          width: 10,
          height: 10,
          depth: 10,
          radius: null,
          bottomRadius: null,
          topRadius: null,
          majorRadius: null,
          minorRadius: null
        }
      }
    ]
  };
  const configured = {
    configured: true,
    provider: 'openai',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium'
  } as const;

  function stubReply() {
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
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
          })
      )
    );
  }

  async function renderWithOpenProposal(
    overrides: Partial<ComponentProps<typeof AssistantPanel>> = {}
  ) {
    window.localStorage.clear();
    stubReply();
    const props: ComponentProps<typeof AssistantPanel> = {
      document: doc,
      selection: { bodyIds: [], featureIds: [], topologies: [] },
      onApply: vi.fn().mockResolvedValue(true),
      onPreview: vi.fn().mockResolvedValue({ ok: true }),
      collapsed: false,
      onCollapsedChange: vi.fn(),
      confirmDestructive: false,
      effectiveAssistant: configured,
      ...overrides
    };
    const view = render(<AssistantPanel {...props} />);
    await act(async () => {
      view.rerender(
        <AssistantPanel {...props} request={{ id: 1, text: 'Add a cube' }} />
      );
    });
    const card = (await screen.findByText('Add a 10 mm cube.')).closest(
      '.assistant-card'
    );
    expect(card).toHaveClass('open');
    return { ...view, card: card as HTMLElement, props };
  }

  it('applies, previews and rejects the newest open proposal', async () => {
    const { card, props } = await renderWithOpenProposal();
    // The reply was previewed on arrival; the keyed actions say which key
    // drives them.
    expect(props.onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ proposalId: 'proposal_keys' })
    );
    expect(
      screen.getByRole('button', { name: 'Apply' }).querySelector('kbd')
    ).toHaveTextContent('⏎');

    let taken = false;
    await act(async () => {
      taken = sendAssistantPromptKey('preview');
    });
    expect(taken).toBe(true);
    // Previewing already: the key hides the preview.
    expect(props.onPreview).toHaveBeenLastCalledWith(null);
    await act(async () => {
      taken = sendAssistantPromptKey('reject');
    });
    expect(taken).toBe(true);
    await waitFor(() => expect(card).toHaveClass('rejected'));
    // Nothing open any more: the keys fall through to the bar.
    await act(async () => {
      taken = sendAssistantPromptKey('apply');
    });
    expect(taken).toBe(false);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('applies on Enter and leaves an applied proposal alone', async () => {
    const { card, props } = await renderWithOpenProposal();
    let taken = false;
    await act(async () => {
      taken = sendAssistantPromptKey('apply');
    });
    expect(taken).toBe(true);
    await waitFor(() => expect(card).toHaveClass('applied'));
    expect(props.onApply).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: 'proposal_keys' })
    );
    await act(async () => {
      taken = sendAssistantPromptKey('apply');
    });
    expect(taken).toBe(false);
    expect(props.onApply).toHaveBeenCalledTimes(1);
  });

  it('acts on the newest proposal still open once a later one is decided', async () => {
    const { card, props, rerender } = await renderWithOpenProposal();
    await act(async () => {
      rerender(
        <AssistantPanel
          {...props}
          request={{ id: 2, text: 'Add another cube' }}
        />
      );
    });
    await waitFor(() =>
      expect(
        document.querySelectorAll('.assistant-card.proposal')
      ).toHaveLength(2)
    );
    const later = document.querySelectorAll('.assistant-card.proposal')[1]!;
    expect(later).toHaveClass('open');

    // Escape rejects the newest; Enter then applies the one before it.
    await act(async () => {
      sendAssistantPromptKey('reject');
    });
    await waitFor(() => expect(later).toHaveClass('rejected'));
    let taken = false;
    await act(async () => {
      taken = sendAssistantPromptKey('apply');
    });
    expect(taken).toBe(true);
    await waitFor(() => expect(card).toHaveClass('applied'));
    expect(props.onApply).toHaveBeenCalledTimes(1);
  });

  it('takes files pasted into the prompt line and brings a tucked-away stream up', async () => {
    const onCollapsedChange = vi.fn();
    render(
      <AssistantPanel
        document={doc}
        selection={{ bodyIds: [], featureIds: [], topologies: [] }}
        onApply={vi.fn().mockResolvedValue(true)}
        onPreview={vi.fn().mockResolvedValue({ ok: true })}
        collapsed
        onCollapsedChange={onCollapsedChange}
        confirmDestructive={false}
        effectiveAssistant={configured}
      />
    );
    await act(async () => {});
    let taken = false;
    await act(async () => {
      taken = sendAssistantPromptFiles([
        new File(['not a drawing'], 'notes.txt', { type: 'text/plain' })
      ]);
    });
    expect(taken).toBe(true);
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it('reports a pasted file it cannot attach', async () => {
    window.localStorage.clear();
    render(
      <AssistantPanel
        document={doc}
        selection={{ bodyIds: [], featureIds: [], topologies: [] }}
        onApply={vi.fn().mockResolvedValue(true)}
        onPreview={vi.fn().mockResolvedValue({ ok: true })}
        collapsed={false}
        onCollapsedChange={vi.fn()}
        confirmDestructive={false}
        effectiveAssistant={configured}
      />
    );
    await act(async () => {
      sendAssistantPromptFiles([
        new File(['not a drawing'], 'notes.txt', { type: 'text/plain' })
      ]);
    });
    // The same path a drop takes: an unsupported file is refused by name.
    await waitFor(() =>
      expect(screen.getAllByRole('status').map((el) => el.textContent)).toEqual(
        expect.arrayContaining([expect.stringContaining('notes.txt')])
      )
    );
  });

  it('opens scrollback on the history key, even from a tucked-away stream', async () => {
    const onCollapsedChange = vi.fn();
    render(
      <AssistantPanel
        document={doc}
        selection={{ bodyIds: [], featureIds: [], topologies: [] }}
        onApply={vi.fn().mockResolvedValue(true)}
        onPreview={vi.fn().mockResolvedValue({ ok: true })}
        collapsed
        onCollapsedChange={onCollapsedChange}
        confirmDestructive={false}
      />
    );
    await act(async () => {});
    let taken = false;
    await act(async () => {
      taken = sendAssistantPromptKey('history');
    });
    expect(taken).toBe(true);
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it('comes back up when the prompt line takes focus', async () => {
    const onCollapsedChange = vi.fn();
    const props: ComponentProps<typeof AssistantPanel> = {
      document: doc,
      selection: { bodyIds: [], featureIds: [], topologies: [] },
      onApply: vi.fn().mockResolvedValue(true),
      onPreview: vi.fn().mockResolvedValue({ ok: true }),
      collapsed: true,
      onCollapsedChange,
      confirmDestructive: false,
      prompting: false
    };
    const { rerender } = render(<AssistantPanel {...props} />);
    await act(async () => {});
    expect(onCollapsedChange).not.toHaveBeenCalled();

    rerender(<AssistantPanel {...props} prompting />);
    expect(onCollapsedChange).toHaveBeenCalledWith(false);

    // Tucked away again while the prompt keeps focus: it stays down.
    onCollapsedChange.mockClear();
    rerender(<AssistantPanel {...props} prompting collapsed />);
    rerender(<AssistantPanel {...props} prompting collapsed />);
    expect(onCollapsedChange).not.toHaveBeenCalled();
  });

  it('tucks away on a press outside the stream and the prompt line', async () => {
    const onCollapsedChange = vi.fn();
    const outside = window.document.createElement('button');
    const prompt = window.document.createElement('div');
    prompt.setAttribute('data-assistant-prompt', '');
    const field = window.document.createElement('input');
    prompt.append(field);
    window.document.body.append(outside, prompt);
    try {
      const user = userEvent.setup();
      render(
        <AssistantPanel
          document={doc}
          selection={{ bodyIds: [], featureIds: [], topologies: [] }}
          onApply={vi.fn().mockResolvedValue(true)}
          onPreview={vi.fn().mockResolvedValue({ ok: true })}
          collapsed={false}
          onCollapsedChange={onCollapsedChange}
          confirmDestructive={false}
        />
      );
      const panel = await screen.findByRole('region', {
        name: 'AI modeling assistant'
      });

      await user.click(panel);
      await user.click(field);
      expect(onCollapsedChange).not.toHaveBeenCalled();

      await user.click(outside);
      expect(onCollapsedChange).toHaveBeenCalledWith(true);
    } finally {
      outside.remove();
      prompt.remove();
    }
  });

  it('leaves a hidden stream alone on a press outside it', async () => {
    const onCollapsedChange = vi.fn();
    const outside = window.document.createElement('button');
    window.document.body.append(outside);
    try {
      const user = userEvent.setup();
      render(
        <AssistantPanel
          document={doc}
          selection={{ bodyIds: [], featureIds: [], topologies: [] }}
          onApply={vi.fn().mockResolvedValue(true)}
          onPreview={vi.fn().mockResolvedValue({ ok: true })}
          collapsed={false}
          onCollapsedChange={onCollapsedChange}
          confirmDestructive={false}
          hidden
        />
      );
      await act(async () => {});
      await user.click(outside);
      expect(onCollapsedChange).not.toHaveBeenCalled();
    } finally {
      outside.remove();
    }
  });
});

describe('an assistant with no provider', () => {
  const unconfigured = {
    configured: false,
    provider: 'openrouter',
    model: '',
    reasoningEffort: 'medium'
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('tells a signed-out user what to do rather than how to deploy', async () => {
    vi.stubEnv('DEV', false);
    const onActivity = vi.fn();
    await renderPanel({ effectiveAssistant: unconfigured, onActivity });
    expect(
      screen.getByText(
        'Sign in and add a personal token in Settings → AI Assistant to use the assistant.'
      )
    ).toBeTruthy();
    expect(screen.queryByText(/OPENROUTER_API_KEY|\.dev\.vars/)).toBeNull();
    expect(onActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ unavailable: true })
    );
  });

  it('tells a signed-in user the deployment has no provider', async () => {
    vi.stubEnv('DEV', false);
    await renderPanel({ effectiveAssistant: unconfigured, signedIn: true });
    expect(
      screen.getByText(
        'The assistant is not configured for this deployment. Add a token in Settings → AI Assistant.'
      )
    ).toBeTruthy();
  });

  it('keeps the developer instruction on the dev server', async () => {
    vi.stubEnv('DEV', true);
    await renderPanel({ effectiveAssistant: unconfigured });
    expect(screen.getByText(/OPENROUTER_API_KEY/)).toBeTruthy();
  });

  /*
    With no provider nothing can read a drawing, and Enter on the empty
    prompt never sends one — so a drawing taken into the tray could only
    wait there under "Enter sends without words". None is taken.
  */
  it('takes no drawing it could never send', async () => {
    await renderPanel({ effectiveAssistant: unconfigured });
    expect(
      screen.getByRole('button', { name: 'Attach a drawing' })
    ).toBeDisabled();

    const drawing = new File(['png'], 'drawing.png', { type: 'image/png' });
    let taken = true;
    await act(async () => {
      taken = sendAssistantPromptFiles([drawing]);
    });
    expect(taken).toBe(false);

    const panel = screen.getByRole('region', { name: 'AI modeling assistant' });
    fireEvent.dragOver(panel, { dataTransfer: { files: [drawing] } });
    expect(panel).not.toHaveClass('dragging');
    await act(async () => {
      fireEvent.drop(panel, { dataTransfer: { files: [drawing] } });
    });
    expect(document.querySelector('.assistant-pending')).toBeNull();
    expect(
      screen
        .queryAllByRole('status')
        .some((status) => status.textContent?.includes('drawing.png'))
    ).toBe(false);
  });
});

describe('trying a failed ask again', () => {
  const configured = {
    configured: true,
    provider: 'openai',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium'
  } as const;

  function proposalsCalls() {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([url]) =>
        String(url instanceof Request ? url.url : url).includes(
          '/api/assistant/proposals'
        )
      );
  }

  it('resends a failed answer turn as answers, keeping the original selection intent', async () => {
    window.localStorage.clear();
    const document = allEdgeDocument();
    const bodyId = document.bodyOrder[0]!;
    saveAssistantThread(
      document.projectId,
      [
        {
          kind: 'user',
          id: 'initial_request',
          text: 'Fillet all selected edges',
          attachments: [],
          answers: [],
          at: 1
        },
        {
          kind: 'questions',
          id: 'clarification',
          preamble: 'How large should the fillet be?',
          questions: [
            {
              id: 'radius',
              prompt: 'Fillet size',
              options: [{ label: '5 mm', value: '5 mm' }],
              allowFreeText: true,
              unit: 'mm'
            }
          ],
          answers: { radius: '5 mm' },
          sent: true,
          at: 2
        },
        {
          kind: 'user',
          id: 'answer_turn',
          text: '5 mm',
          attachments: [],
          answers: [
            { questionId: 'radius', prompt: 'Fillet size', value: '5 mm' }
          ],
          at: 3
        },
        {
          kind: 'message',
          id: 'failure',
          text: 'The AI provider is temporarily unavailable.',
          tone: 'error',
          at: 4
        }
      ],
      4
    );
    // The model guesses the wrong part; only the original ask's selection
    // intent ("all selected edges") grounds it back onto the selection.
    const proposal = {
      proposalId: 'retry_wrong_edge_guess',
      summary: 'Fillet the selected edges.',
      assumptions: [],
      operations: [
        {
          kind: 'add_edge_modifier',
          name: 'Selected edge fillets',
          localId: null,
          modifier: 'fillet',
          targetBodyId: 'body_other',
          edgeHashes: [999],
          size: 5
        }
      ]
    };
    const streamBody = `data: ${JSON.stringify({
      type: 'response.output_text.done',
      text: JSON.stringify({
        replyKind: 'patch',
        proposal,
        questions: null,
        message: null,
        readings: null
      })
    })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(streamBody, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
          })
      )
    );
    const onPreview = vi.fn(async (_proposal: CadPatchProposal | null) => ({
      ok: true as const
    }));
    const user = userEvent.setup();
    render(
      <AssistantPanel
        document={document}
        selection={{
          bodyIds: [bodyId],
          featureIds: [],
          topologies: [
            { bodyId, kind: 'edge', topologyId: 'edge:1', hash: 1 },
            { bodyId, kind: 'edge', topologyId: 'edge:2', hash: 2 }
          ]
        }}
        onApply={vi.fn().mockResolvedValue(true)}
        onPreview={onPreview}
        collapsed={false}
        onCollapsedChange={vi.fn()}
        confirmDestructive
        effectiveAssistant={configured}
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    await waitFor(() =>
      expect(onPreview.mock.calls.at(-1)?.[0]).toMatchObject({
        operations: [
          expect.objectContaining({
            targetBodyId: bodyId,
            edgeHashes: [1, 2],
            size: 5
          })
        ]
      })
    );
    const [, init] = proposalsCalls().at(-1)!;
    const body = JSON.parse(init?.body as string) as { prompt: string };
    expect(body.prompt).toBe('5 mm');
    // The resent turn reads as the answer list it was, not as a sentence
    // the user never typed.
    expect(
      window.document.querySelectorAll('.assistant-answer-list')
    ).toHaveLength(2);
    expect(window.document.querySelectorAll('.assistant-ask')).toHaveLength(1);
  });

  it('offers it on the newest failure only, which repeats the newest ask', async () => {
    window.localStorage.clear();
    saveAssistantThread(
      doc.projectId,
      [
        {
          kind: 'user',
          id: 'ask_a',
          text: 'Ask A',
          attachments: [],
          answers: [],
          at: 1
        },
        {
          kind: 'message',
          id: 'failure_a',
          text: 'A failed.',
          tone: 'error',
          at: 2
        },
        {
          kind: 'user',
          id: 'ask_b',
          text: 'Ask B',
          attachments: [],
          answers: [],
          at: 3
        },
        {
          kind: 'message',
          id: 'failure_b',
          text: 'B failed.',
          tone: 'error',
          at: 4
        }
      ],
      4
    );
    await renderPanel({ effectiveAssistant: configured });
    const retries = screen.getAllByRole('button', { name: 'Try again' });
    expect(retries).toHaveLength(1);
    expect(retries[0]!.closest('.assistant-card')).toHaveTextContent(
      'B failed.'
    );
    expect(retries[0]).toHaveAttribute('title', 'Send "Ask B" again');
  });
});

describe('the stream as a record', () => {
  it('stamps each turn with a valid machine-readable time', async () => {
    await renderPanel();
    const times = window.document.querySelectorAll('time');
    expect(times.length).toBeGreaterThan(0);
    for (const time of times) {
      const value = time.getAttribute('datetime') ?? '';
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      expect(Number.isNaN(Date.parse(value))).toBe(false);
    }
  });

  it('adds nothing under an ask that was answered', async () => {
    await renderPanel();
    expect(screen.queryByText(/Stopped before the assistant/)).toBeNull();
  });

  it('marks a trailing ask that never got its answer', async () => {
    window.localStorage.clear();
    saveAssistantThread(
      doc.projectId,
      [
        {
          kind: 'user',
          id: 'unanswered',
          text: 'Make it taller',
          attachments: [],
          answers: [],
          at: 1
        }
      ],
      1
    );
    await renderPanel();
    expect(
      screen.getByText('Stopped before the assistant answered.')
    ).toBeInTheDocument();
  });

  it('names its foot actions by their visible words', async () => {
    await renderPanel();
    expect(
      screen.getByRole('button', { name: 'Hide the assistant' })
    ).toHaveTextContent('hide');
    const history = screen.getByRole('button', { name: 'history' });
    expect(history).toHaveAttribute('aria-pressed', 'false');
    await userEvent.setup().click(history);
    expect(screen.getByRole('button', { name: 'history' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(
      window.document.querySelector('.assistant-model')
    ).not.toHaveAttribute('aria-label');
  });

  it('says plainly when the status check cannot reach the assistant', async () => {
    await renderPanel();
    expect(
      await screen.findByText(
        "The assistant can't be reached right now. Verified recipes still work."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/offline/)).toBeNull();
  });

  it('announces a reply once it lands, from a region that was already there', async () => {
    window.localStorage.clear();
    const reply = `data: ${JSON.stringify({
      type: 'response.output_text.done',
      text: JSON.stringify({
        replyKind: 'message',
        proposal: null,
        questions: null,
        message: 'The wall is 2 mm.',
        readings: null
      })
    })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(reply, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
          })
      )
    );
    const props: ComponentProps<typeof AssistantPanel> = {
      document: doc,
      selection: { bodyIds: [], featureIds: [], topologies: [] },
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
      }
    };
    const view = render(<AssistantPanel {...props} />);
    const region = window.document.querySelector('[aria-live="polite"]');
    expect(region).toHaveTextContent('');
    await act(async () => {
      view.rerender(
        <AssistantPanel {...props} request={{ id: 1, text: 'How thick?' }} />
      );
    });
    await screen.findByText('The wall is 2 mm.');
    // The same node, now carrying the news: nothing streams into it.
    expect(window.document.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region).toHaveTextContent('The assistant replied.');
  });
});
