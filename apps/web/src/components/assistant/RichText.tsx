import { Fragment, useMemo } from 'react';
import { parseRichText, type RichTextSpan } from '../../lib/assistant/richText';

interface RichTextProps {
  text: string;
  /** Extra class on the wrapper, so a card can tune its own spacing. */
  className?: string;
}

function Spans({ spans }: { spans: RichTextSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        const key = `${index}-${span.text}`;
        if (span.code) {
          return <code key={key}>{span.text}</code>;
        }
        if (span.bold) {
          return <strong key={key}>{span.text}</strong>;
        }
        if (span.italic) {
          return <em key={key}>{span.text}</em>;
        }
        return <Fragment key={key}>{span.text}</Fragment>;
      })}
    </>
  );
}

/**
 * Assistant prose as elements rather than a paragraph of raw Markdown.
 *
 * Rendered through the token tree, never as HTML: a reply is model output, and
 * the workspace it lands in is a live document.
 */
export function RichText({ text, className }: RichTextProps) {
  const blocks = useMemo(() => parseRichText(text), [text]);
  return (
    <div
      className={className ? `assistant-prose ${className}` : 'assistant-prose'}
    >
      {blocks.map((block, index) => {
        if (block.kind === 'code') {
          return (
            <pre key={index}>
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.kind === 'list') {
          const items = block.items.map((spans, itemIndex) => (
            <li key={itemIndex}>
              <Spans spans={spans} />
            </li>
          ));
          return block.ordered ? (
            <ol key={index}>{items}</ol>
          ) : (
            <ul key={index}>{items}</ul>
          );
        }
        return (
          <p key={index}>
            <Spans spans={block.spans} />
          </p>
        );
      })}
    </div>
  );
}
