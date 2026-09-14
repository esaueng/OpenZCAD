import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  loadAssistantThread,
  saveAssistantThread
} from '../../lib/assistant/history';
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
