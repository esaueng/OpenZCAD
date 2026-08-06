import { describe, expect, it } from 'vitest';
import {
  parseInlineSpans,
  parseRichText
} from '../apps/web/src/lib/assistant/richText';
import {
  formatDayLabel,
  formatEntryTime,
  groupThreadByDay,
  summarizeThread
} from '../apps/web/src/lib/assistant/timeline';
import {
  describeProgress,
  readAssistantProgress
} from '../apps/web/src/lib/assistant/progress';
import { assistantSuggestions } from '../apps/web/src/lib/assistant/suggestions';
import type { AssistantEntry } from '../apps/web/src/lib/assistant/conversation';

describe('assistant rich text', () => {
  it('renders bold, italic and code as spans', () => {
    expect(
      parseInlineSpans('Set **plate_t** to `6` for a *thin* plate')
    ).toEqual([
      { text: 'Set ' },
      { text: 'plate_t', bold: true },
      { text: ' to ' },
      { text: '6', code: true },
      { text: ' for a ' },
      { text: 'thin', italic: true },
      { text: ' plate' }
    ]);
  });

  it('leaves a lone asterisk alone rather than eating the rest of the line', () => {
    expect(parseInlineSpans('80 * 60 mm')).toEqual([{ text: '80 * 60 mm' }]);
  });

  it('does not read emphasis inside a code span', () => {
    expect(parseInlineSpans('`a ** b`')).toEqual([
      { text: 'a ** b', code: true }
    ]);
  });

  it('splits paragraphs, bullets and numbered steps', () => {
    const blocks = parseRichText(
      'Here is the plan:\n\n- Cut the bore\n- Chamfer it\n\n1. Set the parameter\n2. Rebuild'
    );
    expect(blocks).toEqual([
      { kind: 'paragraph', spans: [{ text: 'Here is the plan:' }] },
      {
        kind: 'list',
        ordered: false,
        items: [[{ text: 'Cut the bore' }], [{ text: 'Chamfer it' }]]
      },
      {
        kind: 'list',
        ordered: true,
        items: [[{ text: 'Set the parameter' }], [{ text: 'Rebuild' }]]
      }
    ]);
  });

  it('keeps a fenced block verbatim, closed or not', () => {
    expect(parseRichText('```\nplate_t = 6\n```')).toEqual([
      { kind: 'code', text: 'plate_t = 6' }
    ]);
    expect(parseRichText('```\nplate_t = 6')).toEqual([
      { kind: 'code', text: 'plate_t = 6' }
    ]);
  });

  it('joins a wrapped paragraph into one block', () => {
    expect(parseRichText('The plate is\n80 mm wide.')).toEqual([
      { kind: 'paragraph', spans: [{ text: 'The plate is 80 mm wide.' }] }
    ]);
  });
});

describe('assistant thread timeline', () => {
  const noon = new Date(2026, 6, 31, 12, 0, 0).getTime();
  const yesterday = noon - 24 * 60 * 60 * 1000;
  const lastMonth = new Date(2026, 5, 2, 9, 30, 0).getTime();

  function ask(
    id: string,
    at: number | undefined,
    text = 'Fillet it'
  ): AssistantEntry {
    return {
      kind: 'user',
      id,
      text,
      attachments: [],
      answers: [],
      ...(at ? { at } : {})
    };
  }

  it('names today and yesterday, and dates anything older', () => {
    expect(formatDayLabel(noon, noon)).toBe('Today');
    expect(formatDayLabel(yesterday, noon)).toBe('Yesterday');
    expect(formatDayLabel(lastMonth, noon)).not.toMatch(/Today|Yesterday/);
  });

  it('groups consecutive turns from the same day', () => {
    const groups = groupThreadByDay(
      [
        ask('u1', lastMonth),
        ask('u2', yesterday),
        ask('u3', yesterday),
        ask('u4', noon)
      ],
      noon
    );
    expect(groups.map((group) => group.label)).toEqual([
      formatDayLabel(lastMonth, noon),
      'Yesterday',
      'Today'
    ]);
    expect(groups[1]?.entries).toHaveLength(2);
  });

  it('keeps undated turns at the front under their own heading', () => {
    const groups = groupThreadByDay(
      [ask('u0', undefined), ask('u1', noon)],
      noon
    );
    expect(groups[0]?.label).toBe('Earlier');
    expect(groups[0]?.key).toBe('undated');
    expect(groups[1]?.label).toBe('Today');
  });

  it('has no time to show for an entry that carries none', () => {
    expect(formatEntryTime(undefined)).toBe('');
    expect(formatEntryTime(noon)).not.toBe('');
  });

  it('summarizes a thread by its last substantive turn', () => {
    expect(
      summarizeThread([
        ask('u1', noon, 'Make a plate'),
        {
          kind: 'message',
          id: 'm1',
          text: 'The plate is already 6 mm thick.',
          tone: 'info',
          at: noon
        }
      ])
    ).toBe('The plate is already 6 mm thick.');
    expect(summarizeThread([])).toBe('');
  });
});

describe('assistant streaming progress', () => {
  it('says it is still reading before the reply names its kind', () => {
    expect(readAssistantProgress('{"repl')).toEqual({
      stage: 'reading',
      text: ''
    });
  });

  it('reads the summary a patch is part way through writing', () => {
    expect(
      readAssistantProgress(
        '{"replyKind":"patch","proposal":{"proposalId":"p1","summary":"Will build an 80 x 60'
      )
    ).toEqual({ stage: 'drafting', text: 'Will build an 80 x 60' });
  });

  it('decodes escapes and stops at a half-written one', () => {
    expect(
      readAssistantProgress(
        '{"replyKind":"message","message":"A \\"tight\\" fit'
      )
    ).toEqual({ stage: 'answering', text: 'A "tight" fit' });
    expect(
      readAssistantProgress('{"replyKind":"message","message":"Bore \\u00d')
    ).toEqual({ stage: 'answering', text: 'Bore' });
  });

  it('recognises a question turn', () => {
    expect(
      readAssistantProgress(
        '{"replyKind":"questions","message":"Two dimensions are missing.","questions":[{'
      )
    ).toEqual({ stage: 'asking', text: 'Two dimensions are missing.' });
  });

  it('folds the selection into the copy only while it is still reading', () => {
    expect(
      describeProgress({ stage: 'reading', text: '' }, '3 selected edges')
    ).toBe('Reading 3 selected edges and the feature history');
    expect(
      describeProgress({ stage: 'drafting', text: 'x' }, '3 selected edges')
    ).toBe('Drafting a change');
  });
});

describe('assistant openers', () => {
  it('offers edge work when edges are selected', () => {
    const suggestions = assistantSuggestions({
      bodyCount: 2,
      topologyKind: 'edge',
      selectedBodyCount: 0
    });
    expect(suggestions[0]?.label).toMatch(/edge/i);
  });

  it('offers something to build when the document is empty', () => {
    const suggestions = assistantSuggestions({
      bodyCount: 0,
      topologyKind: null,
      selectedBodyCount: 0
    });
    expect(suggestions).toHaveLength(3);
    expect(suggestions.map((suggestion) => suggestion.label).join(' ')).toMatch(
      /mm/
    );
    expect(suggestions.every((suggestion) => suggestion.proposal)).toBe(true);
  });
});
