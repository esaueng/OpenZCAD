import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
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
    // The draft is handed back on mount; the status line only follows once
    // the model-status request has failed, so it is awaited, not read.
    expect((await screen.findAllByRole('status')).length).toBeGreaterThan(0);
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
      context: '2 selected edges'
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
