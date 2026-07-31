import { describe, expect, it } from 'vitest';
import type { CadPatchProposal } from '@openzcad/ai-contracts';
import type { AssistantEntry } from '../apps/web/src/lib/assistant/conversation';
import {
  ASSISTANT_HISTORY_STORAGE_KEY,
  clearAssistantThread,
  loadAssistantThread,
  MAX_STORED_CHARS,
  MAX_STORED_ENTRIES,
  MAX_STORED_PROJECTS,
  parseStoredEntry,
  saveAssistantThread
} from '../apps/web/src/lib/assistant/history';

function fakeStorage(seed?: string) {
  const entries = new Map<string, string>();
  if (seed !== undefined) {
    entries.set(ASSISTANT_HISTORY_STORAGE_KEY, seed);
  }
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value)
  };
}

const proposal: CadPatchProposal = {
  proposalId: 'p1',
  summary: 'Will build an 80 x 60 x 6 mm plate.',
  assumptions: ['Bore centred'],
  operations: [{ kind: 'set_parameter', name: 'plate_t', expression: '6' }]
};

function userEntry(id: string, text: string, at = 1_700_000_000_000) {
  return {
    kind: 'user' as const,
    id,
    text,
    attachments: [],
    answers: [],
    at
  };
}

function drawingEntry(id: string, bytes: number) {
  return {
    kind: 'user' as const,
    id,
    text: 'Model this',
    attachments: [
      {
        id: `${id}_att`,
        label: 'sheet 1',
        mediaType: 'image/png' as const,
        dataBase64: 'A'.repeat(bytes)
      }
    ],
    answers: [],
    at: 1_700_000_000_000
  };
}

describe('assistant thread storage', () => {
  it('reads back a thread it wrote', () => {
    const storage = fakeStorage();
    const entries: AssistantEntry[] = [
      userEntry('u1', 'Fillet every edge by 2 mm'),
      {
        kind: 'proposal',
        id: 'r1',
        proposal,
        readings: [
          {
            label: '⌀12 bore',
            value: '12',
            source: 'front view',
            confidence: 'read'
          }
        ],
        status: 'applied',
        at: 1_700_000_000_100
      }
    ];

    expect(saveAssistantThread('proj_a', entries, 1, storage)).toBe(true);
    expect(loadAssistantThread('proj_a', storage)).toEqual(entries);
  });

  it('keeps one project thread out of another', () => {
    const storage = fakeStorage();
    saveAssistantThread('proj_a', [userEntry('u1', 'Plate')], 1, storage);
    saveAssistantThread('proj_b', [userEntry('u2', 'Shaft')], 2, storage);

    expect(loadAssistantThread('proj_a', storage)[0]).toMatchObject({
      text: 'Plate'
    });
    expect(loadAssistantThread('proj_b', storage)[0]).toMatchObject({
      text: 'Shaft'
    });
    expect(loadAssistantThread('proj_missing', storage)).toEqual([]);
  });

  it('returns an empty thread rather than throwing on corrupt storage', () => {
    expect(loadAssistantThread('proj_a', fakeStorage('{not json'))).toEqual([]);
    expect(loadAssistantThread('proj_a', fakeStorage('null'))).toEqual([]);
    expect(loadAssistantThread('proj_a', null)).toEqual([]);
  });

  it('drops entries it cannot trust instead of loading half of one', () => {
    expect(parseStoredEntry({ kind: 'user' })).toBeNull();
    expect(parseStoredEntry({ kind: 'nonsense', id: 'x' })).toBeNull();
    expect(parseStoredEntry({ kind: 'message', id: 'm', text: '' })).toBeNull();
    // A proposal that no longer satisfies the patch contract must never reach
    // the apply path.
    expect(
      parseStoredEntry({
        kind: 'proposal',
        id: 'p',
        status: 'open',
        proposal: { proposalId: 'p1', summary: 'x' },
        readings: []
      })
    ).toBeNull();
  });

  it('restores a question card mid-answer', () => {
    const restored = parseStoredEntry({
      kind: 'questions',
      id: 'q1',
      preamble: 'Two dimensions are missing.',
      questions: [
        {
          id: 'thickness',
          prompt: 'How thick is the plate?',
          options: [{ label: '6 mm', value: '6 mm' }],
          allowFreeText: true,
          unit: 'mm'
        }
      ],
      answers: { thickness: '6 mm', bogus: 4 },
      sent: false,
      at: 1_700_000_000_000
    });

    expect(restored).toMatchObject({
      kind: 'questions',
      sent: false,
      answers: { thickness: '6 mm' }
    });
  });

  it('keeps only the newest turns', () => {
    const storage = fakeStorage();
    const many = Array.from({ length: MAX_STORED_ENTRIES + 20 }, (_, index) =>
      userEntry(`u${index}`, `turn ${index}`)
    );
    saveAssistantThread('proj_a', many, 1, storage);

    const loaded = loadAssistantThread('proj_a', storage);
    expect(loaded).toHaveLength(MAX_STORED_ENTRIES);
    expect(loaded[0]).toMatchObject({ text: 'turn 20' });
    expect(loaded[loaded.length - 1]).toMatchObject({
      text: `turn ${MAX_STORED_ENTRIES + 19}`
    });
  });

  it('evicts the least recently used project', () => {
    const storage = fakeStorage();
    for (let index = 0; index <= MAX_STORED_PROJECTS; index += 1) {
      saveAssistantThread(
        `proj_${index}`,
        [userEntry(`u${index}`, `turn ${index}`)],
        index + 1,
        storage
      );
    }

    expect(loadAssistantThread('proj_0', storage)).toEqual([]);
    expect(loadAssistantThread('proj_1', storage)).not.toEqual([]);
    expect(
      loadAssistantThread(`proj_${MAX_STORED_PROJECTS}`, storage)
    ).not.toEqual([]);
  });

  it('gives up drawings before it gives up words', () => {
    const storage = fakeStorage();
    // One oversized drawing per turn: the words are a rounding error next to it.
    const entries = [
      drawingEntry('u1', MAX_STORED_CHARS),
      userEntry('u2', 'and chamfer the top edge 1 mm')
    ];
    saveAssistantThread('proj_a', entries, 1, storage);

    const loaded = loadAssistantThread('proj_a', storage);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({
      attachments: [{ label: 'sheet 1', dataBase64: '' }]
    });
    expect(loaded[1]).toMatchObject({ text: 'and chamfer the top edge 1 mm' });
    expect(
      (storage.getItem(ASSISTANT_HISTORY_STORAGE_KEY) ?? '').length
    ).toBeLessThanOrEqual(MAX_STORED_CHARS);
  });

  it('drops the oldest turns when the words alone will not fit', () => {
    const storage = fakeStorage();
    const long = 'x'.repeat(Math.ceil(MAX_STORED_CHARS / 3));
    saveAssistantThread(
      'proj_a',
      [
        userEntry('u1', `first ${long}`),
        userEntry('u2', `second ${long}`),
        userEntry('u3', `third ${long}`),
        userEntry('u4', `fourth ${long}`)
      ],
      1,
      storage
    );

    const loaded = loadAssistantThread('proj_a', storage);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded[loaded.length - 1]?.id).toBe('u4');
    expect(loaded.some((entry) => entry.id === 'u1')).toBe(false);
    expect(
      (storage.getItem(ASSISTANT_HISTORY_STORAGE_KEY) ?? '').length
    ).toBeLessThanOrEqual(MAX_STORED_CHARS);
  });

  it('clears one project without touching another', () => {
    const storage = fakeStorage();
    saveAssistantThread('proj_a', [userEntry('u1', 'Plate')], 1, storage);
    saveAssistantThread('proj_b', [userEntry('u2', 'Shaft')], 2, storage);

    clearAssistantThread('proj_a', storage);

    expect(loadAssistantThread('proj_a', storage)).toEqual([]);
    expect(loadAssistantThread('proj_b', storage)).not.toEqual([]);
  });

  it('reports a refused write rather than throwing', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      }
    };
    expect(
      saveAssistantThread('proj_a', [userEntry('u1', 'Plate')], 1, storage)
    ).toBe(false);
  });
});
