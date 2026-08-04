import { describe, expect, it } from 'vitest';
import {
  MAX_ASSISTANT_HISTORY_TURNS,
  type AssistantQuestion,
  type AssistantReply,
  type CadPatchOperation,
  type CadPatchProposal
} from '@openzcad/ai-contracts';
import {
  allQuestionsAnswered,
  assistantReducer,
  collectedAnswers,
  EMPTY_CONVERSATION,
  historyForRequest,
  openProposal,
  type AssistantAction,
  type AssistantConversation,
  type AssistantQuestionsEntry
} from '../apps/web/src/lib/assistant/conversation';
import {
  describeBodyRef,
  describeOperation,
  summarizeOperations
} from '../apps/web/src/lib/assistant/describe';
import { toFeatureId } from '@openzcad/shared';

function run(
  actions: AssistantAction[],
  from: AssistantConversation = EMPTY_CONVERSATION
): AssistantConversation {
  return actions.reduce(assistantReducer, from);
}

const question: AssistantQuestion = {
  id: 'plate_thickness',
  prompt: 'How thick is the plate?',
  options: [{ label: '6 mm', value: '6 mm' }],
  allowFreeText: true,
  unit: 'mm'
};

const proposal: CadPatchProposal = {
  proposalId: 'p1',
  summary: 'Will build an 80 x 60 x 6 mm plate.',
  assumptions: ['Bore centred'],
  operations: [
    { kind: 'set_parameter', name: 'plate_t', expression: '6' },
    {
      kind: 'add_primitive',
      name: 'Plate',
      localId: 'plate',
      primitiveKind: 'box',
      dimensions: {
        width: 80,
        height: 60,
        depth: 'plate_t',
        radius: null,
        bottomRadius: null,
        topRadius: null,
        majorRadius: null,
        minorRadius: null
      }
    }
  ]
};

const questionsReply: AssistantReply = {
  kind: 'questions',
  preamble: 'One dimension is missing.',
  questions: [question]
};
const patchReply: AssistantReply = { kind: 'patch', proposal, readings: [] };

describe('assistant conversation', () => {
  it('tracks a question, its answer, and the resulting patch', () => {
    const asked = run([
      { type: 'submit', id: 'u1', text: 'Model this drawing' },
      { type: 'reply', id: 'a1', reply: questionsReply }
    ]);
    expect(asked.status).toBe('idle');
    const card = asked.entries[1] as AssistantQuestionsEntry;
    expect(card.kind).toBe('questions');
    expect(allQuestionsAnswered(card)).toBe(false);

    const answered = run(
      [
        {
          type: 'answer',
          entryId: 'a1',
          questionId: 'plate_thickness',
          value: '6 mm'
        }
      ],
      asked
    );
    const filled = answered.entries[1] as AssistantQuestionsEntry;
    expect(allQuestionsAnswered(filled)).toBe(true);
    expect(collectedAnswers(filled)).toEqual([
      {
        questionId: 'plate_thickness',
        prompt: 'How thick is the plate?',
        value: '6 mm'
      }
    ]);

    // Sending the answers marks the card as history and starts a new turn.
    const sent = run(
      [
        {
          type: 'submit',
          id: 'u2',
          text: '6 mm',
          answers: collectedAnswers(filled),
          answeredEntryId: 'a1'
        },
        { type: 'reply', id: 'a2', reply: patchReply }
      ],
      answered
    );
    expect((sent.entries[1] as AssistantQuestionsEntry).sent).toBe(true);
    expect(sent.status).toBe('idle');
    expect(openProposal(sent)?.id).toBe('a2');
  });

  it('sends one history turn per answered question, bound to its id', () => {
    const conversation = run([
      { type: 'submit', id: 'u1', text: 'Model this drawing' },
      {
        type: 'reply',
        id: 'a1',
        reply: {
          kind: 'questions',
          preamble: 'Two dimensions are missing.',
          questions: [question, { ...question, id: 'bore', prompt: 'Bore?' }]
        }
      },
      {
        type: 'submit',
        id: 'u2',
        text: '6 mm; 12 mm',
        answeredEntryId: 'a1',
        answers: [
          {
            questionId: 'plate_thickness',
            prompt: 'How thick is the plate?',
            value: '6 mm'
          },
          { questionId: 'bore', prompt: 'Bore?', value: '12 mm' }
        ]
      }
    ]);

    expect(historyForRequest(conversation)).toEqual([
      { role: 'user', text: 'Model this drawing' },
      {
        role: 'assistant',
        text: 'Two dimensions are missing. How thick is the plate? Bore?'
      },
      { role: 'user', text: '6 mm', answeredQuestionId: 'plate_thickness' },
      { role: 'user', text: '12 mm', answeredQuestionId: 'bore' }
    ]);
  });

  it('tells the model when a proposal was rejected or applied', () => {
    const base = run([
      { type: 'submit', id: 'u1', text: 'Make a bracket' },
      { type: 'reply', id: 'a1', reply: patchReply }
    ]);

    expect(historyForRequest(base)[1]?.text).toBe(proposal.summary);

    const rejected = run(
      [{ type: 'resolve-proposal', entryId: 'a1', status: 'rejected' }],
      base
    );
    // Without this the next turn happily re-proposes what the user just refused.
    expect(historyForRequest(rejected)[1]?.text).toContain(
      'the user rejected this'
    );
    expect(openProposal(rejected)).toBeNull();

    const applied = run(
      [{ type: 'resolve-proposal', entryId: 'a1', status: 'applied' }],
      base
    );
    expect(historyForRequest(applied)[1]?.text).toContain(
      'the user applied this'
    );
  });

  it('drops a resolved proposal from the live preview', () => {
    const previewing = run([
      { type: 'submit', id: 'u1', text: 'Make a bracket' },
      { type: 'reply', id: 'a1', reply: patchReply },
      { type: 'preview', entryId: 'a1' }
    ]);
    expect(previewing.previewEntryId).toBe('a1');

    expect(
      run(
        [{ type: 'resolve-proposal', entryId: 'a1', status: 'applied' }],
        previewing
      ).previewEntryId
    ).toBeNull();
    // A different proposal resolving must not clear someone else's preview.
    expect(
      run(
        [{ type: 'resolve-proposal', entryId: 'other', status: 'applied' }],
        previewing
      ).previewEntryId
    ).toBe('a1');
  });

  it('keeps client-side failures out of the history it sends', () => {
    const failed = run([
      { type: 'submit', id: 'u1', text: 'Make a bracket' },
      { type: 'fail', id: 'e1', message: 'The connection ended.' },
      { type: 'submit', id: 'u2', text: 'Try again' }
    ]);
    expect(failed.entries[1]).toMatchObject({ kind: 'message', tone: 'error' });
    // A transport error is noise to the model, not part of the conversation.
    expect(historyForRequest(failed)).toEqual([
      { role: 'user', text: 'Make a bracket' },
      { role: 'user', text: 'Try again' }
    ]);
  });

  it('bounds history by turn count and character budget', () => {
    const many = run(
      Array.from({ length: 20 }, (_unused, index) => ({
        type: 'submit' as const,
        id: `u${index}`,
        text: `turn ${index}`
      }))
    );
    const bounded = historyForRequest(many);
    expect(bounded).toHaveLength(MAX_ASSISTANT_HISTORY_TURNS);
    // The most recent turns are the ones kept.
    expect(bounded.at(-1)?.text).toBe('turn 19');

    const wordy = run([
      { type: 'submit', id: 'u1', text: 'x'.repeat(7_000) },
      { type: 'submit', id: 'u2', text: 'y'.repeat(7_000) }
    ]);
    const trimmed = historyForRequest(wordy);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]?.text.startsWith('y')).toBe(true);
  });

  it('cancels and resets without leaving a stuck spinner', () => {
    const thinking = run([{ type: 'submit', id: 'u1', text: 'Make a bracket' }]);
    expect(thinking.status).toBe('thinking');
    expect(run([{ type: 'cancel' }], thinking).status).toBe('idle');
    expect(run([{ type: 'reset' }], thinking)).toEqual(EMPTY_CONVERSATION);
  });

  it('stamps a turn with the clock the caller passed, and only then', () => {
    const stamped = run([
      { type: 'submit', id: 'u1', text: 'Make a bracket', at: 1_700_000_000_000 }
    ]);
    expect(stamped.entries[0]).toMatchObject({ at: 1_700_000_000_000 });
    // A turn from a build that had no timestamps must still be a valid turn.
    expect(run([{ type: 'submit', id: 'u1', text: 'x' }]).entries[0]).not.toHaveProperty(
      'at'
    );
  });

  it('swaps in a stored thread without inheriting a live turn', () => {
    const thinking = run([
      { type: 'submit', id: 'u1', text: 'Make a bracket' },
      { type: 'reply', id: 'a1', reply: patchReply },
      { type: 'preview', entryId: 'a1' },
      { type: 'submit', id: 'u2', text: 'and fillet it' }
    ]);
    expect(thinking.status).toBe('thinking');

    const restored = run(
      [
        {
          type: 'restore',
          entries: [
            {
              kind: 'message',
              id: 'm1',
              text: 'From another project.',
              tone: 'info'
            }
          ]
        }
      ],
      thinking
    );
    expect(restored.entries).toHaveLength(1);
    expect(restored.status).toBe('idle');
    // Nothing restored is the viewport preview: that belonged to the document
    // the panel just left.
    expect(restored.previewEntryId).toBeNull();
  });

  it('returns only the most recent still-open proposal', () => {
    const two = run([
      { type: 'submit', id: 'u1', text: 'a' },
      { type: 'reply', id: 'a1', reply: patchReply },
      { type: 'submit', id: 'u2', text: 'b' },
      { type: 'reply', id: 'a2', reply: patchReply }
    ]);
    expect(openProposal(two)?.id).toBe('a2');
    expect(
      openProposal(
        run([{ type: 'resolve-proposal', entryId: 'a2', status: 'applied' }], two)
      )?.id
    ).toBe('a1');
  });
});

describe('patch operation descriptions', () => {
  it('reads a local alias back as a name', () => {
    expect(describeBodyRef('$box_outer')).toBe('Box Outer');
    expect(describeBodyRef('body_17')).toBe('body_17');
  });

  it('summarizes every operation kind in one line', () => {
    const operations: CadPatchOperation[] = [
      { kind: 'set_parameter', name: 'wall', expression: '2.4' },
      {
        kind: 'set_feature_dimension',
        featureId: toFeatureId('feat_1'),
        field: 'depth',
        value: 12
      },
      ...proposal.operations.slice(1),
      {
        kind: 'add_boolean',
        name: 'Box',
        localId: 'box',
        operation: 'subtract',
        targetBodyIds: ['$box_outer', '$box_cavity']
      },
      {
        kind: 'add_transform',
        name: 'Position',
        targetBodyId: '$box_cavity',
        translation: { x: 'wall', y: 'wall', z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      },
      {
        kind: 'add_pattern',
        name: 'Holes',
        localId: null,
        targetBodyId: 'body_1',
        patternKind: 'linear',
        count: 4,
        axis: 'x',
        spacing: 20,
        angleDeg: 0
      }
    ];

    const lines = operations.map(describeOperation);
    expect(lines[0]).toBe('Set wall = 2.4');
    expect(lines[1]).toContain('Set depth = 12');
    expect(lines[2]).toContain('box, width 80 · height 60 · depth plate_t');
    expect(lines[3]).toBe('Box — subtract Box Outer minus Box Cavity');
    // A zero rotation is noise; only the move is worth a reviewer's attention.
    expect(lines[4]).toBe('Position — Box Cavity: move to wall, wall, 0');
    expect(lines[5]).toContain('linear pattern of body_1, 4 along x');
  });

  it('counts what a proposal actually does for the collapsed header', () => {
    expect(summarizeOperations(proposal.operations)).toEqual({
      parameters: 1,
      bodies: 1,
      edits: 0
    });
    expect(
      summarizeOperations([
        { kind: 'delete_feature', featureId: toFeatureId('feat_1') },
        {
          kind: 'rename_feature',
          featureId: toFeatureId('feat_2'),
          name: 'Plate'
        }
      ])
    ).toEqual({ parameters: 0, bodies: 0, edits: 2 });
  });
});
