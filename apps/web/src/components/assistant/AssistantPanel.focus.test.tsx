import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { saveAssistantThread } from '../../lib/assistant/history';
import { sendAssistantPromptFiles } from '../../lib/assistant/promptKeys';
import type * as Attachments from '../../lib/assistant/attachments';
import { AssistantPanel } from './AssistantPanel';

// happy-dom cannot decode an image; a drawing here only has to reach the tray.
vi.mock('../../lib/assistant/attachments', async (importOriginal) => {
  const actual = await importOriginal<typeof Attachments>();
  return {
    ...actual,
    attachmentsFromFile: vi.fn(async (file: File, id: string) => [
      {
        id,
        label: file.name,
        mediaType: 'image/png' as const,
        dataBase64: 'iVBORw0KGgo='
      }
    ])
  };
});

/**
 * Most controls in the stream go away with what they did — the stop link
 * when the turn ends, a chip when it becomes the answer, Apply and Reject
 * once the proposal is decided, "hide" with the stream itself. Focus has to
 * land somewhere that makes sense, or keyboard and screen-reader users are
 * thrown back to the top of the page.
 */

const doc = createProjectDocument('Bracket', toUserId('user_a'));
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
    confirmDestructive: false,
    effectiveAssistant: configured,
    ...overrides
  };
}

function sse(reply: Record<string, unknown>): Response {
  const body = `data: ${JSON.stringify({
    type: 'response.output_text.done',
    text: JSON.stringify({
      proposal: null,
      questions: null,
      message: null,
      readings: null,
      ...reply
    })
  })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

function seedQuestions() {
  saveAssistantThread(
    doc.projectId,
    [
      {
        kind: 'user',
        id: 'ask',
        text: 'Make a bracket',
        attachments: [],
        answers: [],
        at: 1
      },
      {
        kind: 'questions',
        id: 'card',
        preamble: 'Two things first.',
        questions: [
          {
            id: 'width',
            prompt: 'Width',
            options: [
              { label: '40 mm', value: '40 mm' },
              { label: '60 mm', value: '60 mm' }
            ],
            allowFreeText: true,
            unit: 'mm'
          },
          {
            id: 'holes',
            prompt: 'Hole size',
            options: [{ label: 'M4', value: 'M4' }],
            allowFreeText: false,
            unit: null
          }
        ],
        answers: {},
        sent: false,
        at: 2
      }
    ],
    2
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('focus after "hide"', () => {
  it('waits on the prompt line, and arriving there does not bring the stream back up', async () => {
    const prompt = window.document.createElement('div');
    prompt.setAttribute('data-assistant-prompt', '');
    const field = window.document.createElement('input');
    prompt.append(field);
    window.document.body.append(prompt);
    try {
      const onCollapsedChange = vi.fn();
      const props = panelProps({ onCollapsedChange, prompting: false });
      const user = userEvent.setup();
      const { rerender } = render(<AssistantPanel {...props} />);
      await act(async () => {});

      await user.click(
        screen.getByRole('button', { name: 'Hide the assistant' })
      );
      expect(onCollapsedChange).toHaveBeenLastCalledWith(true);
      expect(window.document.activeElement).toBe(field);

      // The app's next render: tucked away, with the prompt now focused.
      rerender(<AssistantPanel {...props} collapsed prompting />);
      expect(onCollapsedChange).not.toHaveBeenCalledWith(false);

      // A later, real arrival at the prompt still opens it.
      rerender(<AssistantPanel {...props} collapsed prompting={false} />);
      rerender(<AssistantPanel {...props} collapsed prompting />);
      expect(onCollapsedChange).toHaveBeenLastCalledWith(false);
    } finally {
      prompt.remove();
    }
  });
});

describe('focus after the working line ends', () => {
  it('stays in the thread when "stop" goes away', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError'))
            );
          })
      )
    );
    const props = panelProps();
    const user = userEvent.setup();
    const view = render(<AssistantPanel {...props} />);
    await act(async () => {
      view.rerender(
        <AssistantPanel {...props} request={{ id: 1, text: 'Add a cube' }} />
      );
    });

    await user.click(
      await screen.findByRole('button', { name: 'Stop the assistant' })
    );

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Stop the assistant' })
      ).toBeNull()
    );
    expect(window.document.activeElement).toHaveClass('assistant-thread');
    expect(
      screen.getByText('Stopped before the assistant answered.')
    ).toBeInTheDocument();
  });

  it('stays in the thread when "clear" empties it', async () => {
    seedQuestions();
    const user = userEvent.setup();
    render(<AssistantPanel {...panelProps()} />);
    await user.click(
      await screen.findByRole('button', {
        name: "Clear this project's conversation"
      })
    );
    expect(window.document.activeElement).toHaveClass('assistant-thread');
  });
});

describe('focus in a question card', () => {
  it('moves from a chip to its answer, from "change" back to the choices, and from sending to the card', async () => {
    seedQuestions();
    const user = userEvent.setup();
    render(<AssistantPanel {...panelProps()} />);

    await user.click(await screen.findByRole('button', { name: '40 mm' }));
    const change = screen.getByRole('button', {
      name: 'Change answer for Width'
    });
    expect(window.document.activeElement).toBe(change);

    await user.click(change);
    expect(window.document.activeElement).toBe(
      screen.getByRole('button', { name: '40 mm' })
    );

    // The typed answer, sent with Enter, lands on its "change" as well.
    await user.type(
      screen.getByRole('textbox', { name: 'Width' }),
      '55{Enter}'
    );
    expect(window.document.activeElement).toBe(
      screen.getByRole('button', { name: 'Change answer for Width' })
    );

    await user.click(screen.getByRole('button', { name: 'Send 1 of 2' }));
    await waitFor(() =>
      expect(window.document.activeElement).toHaveClass(
        'assistant-card',
        'questions',
        'sent'
      )
    );
  });

  it('names each chip group, and each Use and change, by its question', async () => {
    seedQuestions();
    render(<AssistantPanel {...panelProps()} />);
    expect(
      await screen.findByRole('group', { name: 'Width mm' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Use answer for Width' })
    ).toBeDisabled();
  });
});

describe('focus after a proposal is decided', () => {
  it('lands on the card that records the rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse({
          replyKind: 'patch',
          proposal: {
            proposalId: 'proposal_focus',
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
          }
        })
      )
    );
    const props = panelProps();
    const user = userEvent.setup();
    const view = render(<AssistantPanel {...props} />);
    await act(async () => {
      view.rerender(
        <AssistantPanel {...props} request={{ id: 1, text: 'Add a cube' }} />
      );
    });

    await user.click(await screen.findByRole('button', { name: 'Reject' }));

    const card = screen
      .getByText('Add a 10 mm cube.')
      .closest('.assistant-card');
    await waitFor(() => expect(card).toHaveClass('rejected'));
    expect(window.document.activeElement).toBe(card);
  });
});

describe('focus in the drawing tray', () => {
  it('moves to the next drawing, then to "attach" once the tray is empty', async () => {
    const user = userEvent.setup();
    render(<AssistantPanel {...panelProps()} />);
    await act(async () => {});
    await act(async () => {
      sendAssistantPromptFiles([
        new File(['a'], 'front.png', { type: 'image/png' }),
        new File(['b'], 'side.png', { type: 'image/png' })
      ]);
    });

    await user.click(
      await screen.findByRole('button', { name: 'Remove front.png' })
    );
    expect(window.document.activeElement).toBe(
      screen.getByRole('button', { name: 'Remove side.png' })
    );

    await user.click(screen.getByRole('button', { name: 'Remove side.png' }));
    expect(window.document.activeElement).toBe(
      screen.getByRole('button', { name: 'Attach a drawing' })
    );
  });
});
