/**
 * The small slice of Markdown an assistant reply actually uses.
 *
 * Models write lists, bold labels and `code` spans whether or not anything asks
 * them to, and a wall of asterisks reads as a bug. This turns a reply into a
 * token tree the panel renders as real elements — never as HTML, so a reply can
 * never inject markup into the workspace.
 *
 * Deliberately not a Markdown implementation: no links, no images, no tables,
 * no nesting. Anything it does not recognise stays visible as plain text rather
 * than disappearing.
 */

export interface RichTextSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export type RichTextBlock =
  | { kind: 'paragraph'; spans: RichTextSpan[] }
  | { kind: 'list'; ordered: boolean; items: RichTextSpan[][] }
  | { kind: 'code'; text: string };

const BULLET = /^\s*([-*•])\s+(.*)$/;
const ORDERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const FENCE = /^\s*```/;

/**
 * Inline spans for one line.
 *
 * Code wins over emphasis: `**` inside a code span is a literal pair of stars,
 * which matters when the assistant quotes an expression.
 */
export function parseInlineSpans(line: string): RichTextSpan[] {
  const spans: RichTextSpan[] = [];
  let plain = '';

  const flush = () => {
    if (plain) {
      spans.push({ text: plain });
      plain = '';
    }
  };

  let index = 0;
  while (index < line.length) {
    const rest = line.slice(index);

    const code = /^`([^`]+)`/.exec(rest);
    if (code?.[1]) {
      flush();
      spans.push({ text: code[1], code: true });
      index += code[0].length;
      continue;
    }

    const bold = /^\*\*([^*]+)\*\*/.exec(rest);
    if (bold?.[1]) {
      flush();
      spans.push({ text: bold[1], bold: true });
      index += bold[0].length;
      continue;
    }

    const italic = /^(?:\*([^*\s][^*]*)\*|_([^_\s][^_]*)_)/.exec(rest);
    const italicText = italic?.[1] ?? italic?.[2];
    if (italic && italicText) {
      flush();
      spans.push({ text: italicText, italic: true });
      index += italic[0].length;
      continue;
    }

    plain += line[index];
    index += 1;
  }
  flush();
  return spans.length > 0 ? spans : [{ text: '' }];
}

/** Reply text as blocks, in order. Blank lines separate paragraphs. */
export function parseRichText(source: string): RichTextBlock[] {
  const blocks: RichTextBlock[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fence: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({
        kind: 'paragraph',
        spans: parseInlineSpans(paragraph.join(' ').trim())
      });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list && list.items.length > 0) {
      blocks.push({
        kind: 'list',
        ordered: list.ordered,
        items: list.items.map((item) => parseInlineSpans(item))
      });
    }
    list = null;
  };

  for (const line of lines) {
    if (FENCE.test(line)) {
      if (fence) {
        blocks.push({ kind: 'code', text: fence.join('\n') });
        fence = null;
      } else {
        flushParagraph();
        flushList();
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const ordered = ORDERED.exec(line);
    const bullet = BULLET.exec(line);
    const itemText = ordered?.[2] ?? bullet?.[2];
    if (itemText !== undefined) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      if (list && list.ordered !== isOrdered) {
        flushList();
      }
      list ??= { ordered: isOrdered, items: [] };
      list.items.push(itemText.trim());
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  // An unterminated fence is still content the user should see.
  if (fence) {
    blocks.push({ kind: 'code', text: fence.join('\n') });
  }
  flushParagraph();
  flushList();
  return blocks;
}
