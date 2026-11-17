/**
 * L15 history text: tokens and the syntax tree.
 *
 * The grammar is newline-insensitive. A document is a header followed by
 * statements; every value is a literal, an id, an expression or a topology
 * reference. Nothing here knows about feature kinds: the reader maps the tree
 * onto the document model and the checker types it.
 *
 * ```text
 * document  := 'openzcad' 'history' INT 'units' IDENT statement*
 * statement := 'param' ID NAME [':' IDENT] '=' value [record]
 *            | KIND ID STRING ['->' ID] record
 * value     := NUMBER | STRING | 'true' | 'false' | 'null' | EXPR | ID
 *            | list | record | ref | node
 * EXPR      := '`' text '`' | 'expr' '(' STRING ')'
 * ref       := ('face' | 'edge') '(' ID ',' STRING ')'
 * node      := KIND ID STRING record          (a sketch object)
 * record    := '{' [key ':' value (',' key ':' value)* [',']] '}'
 * key       := IDENT | '@' IDENT | STRING
 * ```
 */

/** A position in the text: 1-based line and column, 0-based offset. */
export interface TextPosition {
  line: number;
  column: number;
  offset: number;
}

export interface TextSpan {
  start: TextPosition;
  end: TextPosition;
}

export type HistoryTextSeverity = 'error' | 'warning';

/** One problem found in a history text, pointing at where it is. */
export interface HistoryTextDiagnostic {
  severity: HistoryTextSeverity;
  message: string;
  span: TextSpan;
}

/** Thrown by the parser on the first syntax error. */
export class HistoryTextSyntaxError extends Error {
  constructor(
    message: string,
    readonly span: TextSpan
  ) {
    super(`${span.start.line}:${span.start.column}: ${message}`);
    this.name = 'HistoryTextSyntaxError';
  }

  get diagnostic(): HistoryTextDiagnostic {
    return {
      severity: 'error',
      message: this.message.replace(/^\d+:\d+: /, ''),
      span: this.span
    };
  }
}

type TokenType =
  | 'ident'
  | 'id'
  | 'string'
  | 'number'
  | 'expression'
  | 'at-key'
  | 'punct'
  | 'eof';

interface Token {
  type: TokenType;
  /** Decoded value: the string's contents, the id without `#`, the punct. */
  text: string;
  span: TextSpan;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;
/** Characters an id may hold after `#`. */
export const ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
const ID_PART = /[A-Za-z0-9_.:-]/;
const NUMBER_PATTERN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  let line = 1;
  let column = 1;
  const position = (): TextPosition => ({ line, column, offset });
  const advance = (count: number) => {
    for (let index = 0; index < count; index += 1) {
      if (source[offset] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      offset += 1;
    }
  };
  const fail = (message: string, start: TextPosition): never => {
    throw new HistoryTextSyntaxError(message, { start, end: position() });
  };

  while (offset < source.length) {
    const char = source[offset]!;
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      advance(1);
      continue;
    }
    if (char === '/' && source[offset + 1] === '/') {
      while (offset < source.length && source[offset] !== '\n') advance(1);
      continue;
    }
    const start = position();
    const push = (type: TokenType, text: string, length: number) => {
      advance(length);
      tokens.push({ type, text, span: { start, end: position() } });
    };
    if (char === '-' && source[offset + 1] === '>') {
      push('punct', '->', 2);
      continue;
    }
    if ('{}[]():,='.includes(char)) {
      push('punct', char, 1);
      continue;
    }
    if (char === '"') {
      let end = offset + 1;
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\n') fail('Unterminated string.', start);
        end += source[end] === '\\' ? 2 : 1;
      }
      if (end >= source.length) fail('Unterminated string.', start);
      const raw = source.slice(offset, end + 1);
      let decoded: string;
      try {
        decoded = JSON.parse(raw) as string;
      } catch {
        return fail('Invalid string escape.', start);
      }
      push('string', decoded, raw.length);
      continue;
    }
    if (char === '`') {
      const end = source.indexOf('`', offset + 1);
      if (end < 0)
        fail('Unterminated expression: a closing ` is missing.', start);
      const text = source.slice(offset + 1, end);
      push('expression', text, end + 1 - offset);
      continue;
    }
    if (char === '#') {
      let end = offset + 1;
      while (end < source.length && ID_PART.test(source[end]!)) end += 1;
      const text = source.slice(offset + 1, end);
      if (!ID_PATTERN.test(text)) fail('An id follows `#`.', start);
      push('id', text, end - offset);
      continue;
    }
    if (char === '@') {
      let end = offset + 1;
      while (end < source.length && IDENT_PART.test(source[end]!)) end += 1;
      if (end === offset + 1) fail('A field name follows `@`.', start);
      push('at-key', source.slice(offset, end), end - offset);
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      NUMBER_PATTERN.lastIndex = offset;
      const match = NUMBER_PATTERN.exec(source);
      if (!match) fail('Invalid number.', start);
      const text = match![0];
      const next = source[offset + text.length];
      if (next !== undefined && IDENT_PART.test(next) && next !== '-') {
        fail(
          'A number cannot carry units here; write an expression such as `5 mm`.',
          start
        );
      }
      push('number', text, text.length);
      continue;
    }
    if (IDENT_START.test(char)) {
      let end = offset + 1;
      while (end < source.length && IDENT_PART.test(source[end]!)) end += 1;
      push('ident', source.slice(offset, end), end - offset);
      continue;
    }
    fail(`Unexpected character ${JSON.stringify(char)}.`, start);
  }
  const end = position();
  tokens.push({ type: 'eof', text: '', span: { start: end, end } });
  return tokens;
}

export type ValueNode =
  | { type: 'number'; value: number; span: TextSpan }
  | { type: 'string'; value: string; span: TextSpan }
  | { type: 'boolean'; value: boolean; span: TextSpan }
  | { type: 'null'; span: TextSpan }
  /** A `ParamValue` expression the F05 evaluator reads. */
  | { type: 'expression'; value: string; span: TextSpan }
  | { type: 'id'; value: string; span: TextSpan }
  | { type: 'list'; items: ValueNode[]; span: TextSpan }
  | RecordNode
  | ReferenceNode
  | ObjectNode;

export interface RecordEntry {
  key: string;
  keySpan: TextSpan;
  value: ValueNode;
}

export interface RecordNode {
  type: 'record';
  entries: RecordEntry[];
  span: TextSpan;
}

/** `face(#feature, "lineage")` or `edge(…)`: a verified topology reference. */
export interface ReferenceNode {
  type: 'reference';
  referenceKind: 'face' | 'edge';
  feature: string;
  lineage: string;
  span: TextSpan;
}

/** `circle #id "name" { … }`: a node literal, used for sketch objects. */
export interface ObjectNode {
  type: 'node';
  head: string;
  headSpan: TextSpan;
  id: string;
  name: string;
  body: RecordNode;
  span: TextSpan;
}

export interface ParameterStatement {
  type: 'param';
  id: string;
  name: string;
  quantity: string | null;
  quantitySpan: TextSpan | null;
  value: ValueNode;
  extra: RecordNode | null;
  span: TextSpan;
}

export interface FeatureStatement {
  type: 'feature';
  kind: string;
  kindSpan: TextSpan;
  id: string;
  idSpan: TextSpan;
  name: string;
  bodyId: string | null;
  body: RecordNode;
  span: TextSpan;
}

export type Statement = ParameterStatement | FeatureStatement;

export interface HistoryTextTree {
  version: number;
  versionSpan: TextSpan;
  units: string;
  unitsSpan: TextSpan;
  statements: Statement[];
}

/** Deeper nesting than any stored document holds is refused, not recursed. */
export const MAX_HISTORY_TEXT_DEPTH = 64;

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  private get current(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    const token = this.current;
    if (token.type !== 'eof') this.index += 1;
    return token;
  }

  private fail(message: string, token = this.current): never {
    throw new HistoryTextSyntaxError(message, token.span);
  }

  private describe(token: Token): string {
    if (token.type === 'eof') return 'the end of the text';
    if (token.type === 'string') return 'a string';
    if (token.type === 'expression') return 'an expression';
    if (token.type === 'id') return `#${token.text}`;
    return `\`${token.text}\``;
  }

  private expectPunct(text: string): Token {
    const token = this.current;
    if (token.type !== 'punct' || token.text !== text) {
      this.fail(`Expected \`${text}\` but found ${this.describe(token)}.`);
    }
    return this.next();
  }

  private expectWord(word: string): Token {
    const token = this.current;
    if (token.type !== 'ident' || token.text !== word) {
      this.fail(`Expected \`${word}\` but found ${this.describe(token)}.`);
    }
    return this.next();
  }

  private expect(type: TokenType, what: string): Token {
    const token = this.current;
    if (token.type !== type) {
      this.fail(`Expected ${what} but found ${this.describe(token)}.`);
    }
    return this.next();
  }

  private isPunct(text: string): boolean {
    return this.current.type === 'punct' && this.current.text === text;
  }

  parseDocument(): HistoryTextTree {
    this.expectWord('openzcad');
    this.expectWord('history');
    const versionToken = this.expect('number', 'the history text version');
    const version = Number(versionToken.text);
    if (!Number.isInteger(version) || version < 1) {
      this.fail('The history text version is a whole number.', versionToken);
    }
    this.expectWord('units');
    const unitsToken = this.expect('ident', 'the document units');
    const statements: Statement[] = [];
    while (this.current.type !== 'eof') statements.push(this.parseStatement());
    return {
      version,
      versionSpan: versionToken.span,
      units: unitsToken.text,
      unitsSpan: unitsToken.span,
      statements
    };
  }

  private parseStatement(): Statement {
    const head = this.expect(
      'ident',
      'a statement such as `param` or a feature kind'
    );
    if (head.text === 'param') {
      const id = this.expect('id', 'the parameter id (`#…`)');
      const name = this.expect('ident', 'the parameter name');
      let quantity: Token | null = null;
      if (this.isPunct(':')) {
        this.next();
        quantity = this.expect('ident', 'the parameter quantity');
      }
      this.expectPunct('=');
      const value = this.parseValue();
      const extra = this.isPunct('{') ? this.parseRecord() : null;
      return {
        type: 'param',
        id: id.text,
        name: name.text,
        quantity: quantity?.text ?? null,
        quantitySpan: quantity?.span ?? null,
        value,
        extra,
        span: { start: head.span.start, end: this.previousEnd() }
      };
    }
    const id = this.expect('id', 'the feature id (`#…`)');
    const name = this.expect('string', 'the feature name in quotes');
    let bodyId: string | null = null;
    if (this.isPunct('->')) {
      this.next();
      bodyId = this.expect('id', 'the result body id (`#…`)').text;
    }
    const body = this.parseRecord();
    return {
      type: 'feature',
      kind: head.text,
      kindSpan: head.span,
      id: id.text,
      idSpan: id.span,
      name: name.text,
      bodyId,
      body,
      span: { start: head.span.start, end: body.span.end }
    };
  }

  private previousEnd(): TextPosition {
    return this.tokens[Math.max(0, this.index - 1)]!.span.end;
  }

  private parseRecord(): RecordNode {
    const open = this.expectPunct('{');
    const entries: RecordEntry[] = [];
    const seen = new Set<string>();
    while (!this.isPunct('}')) {
      const keyToken = this.current;
      let key: string;
      if (keyToken.type === 'ident' || keyToken.type === 'string') {
        key = keyToken.text;
      } else if (keyToken.type === 'at-key') {
        key = keyToken.text;
      } else {
        this.fail(
          `Expected a field name but found ${this.describe(keyToken)}.`
        );
      }
      this.next();
      if (seen.has(key)) this.fail(`Field \`${key}\` appears twice.`, keyToken);
      seen.add(key);
      this.expectPunct(':');
      const value = this.parseValue();
      entries.push({ key, keySpan: keyToken.span, value });
      if (this.isPunct(',')) this.next();
      else if (!this.isPunct('}')) this.failAfter(value, '}');
    }
    const close = this.next();
    return {
      type: 'record',
      entries,
      span: { start: open.span.start, end: close.span.end }
    };
  }

  private parseList(): ValueNode {
    const open = this.expectPunct('[');
    const items: ValueNode[] = [];
    while (!this.isPunct(']')) {
      const value = this.parseValue();
      items.push(value);
      if (this.isPunct(',')) this.next();
      else if (!this.isPunct(']')) this.failAfter(value, ']');
    }
    const close = this.next();
    return {
      type: 'list',
      items,
      span: { start: open.span.start, end: close.span.end }
    };
  }

  /** A missing separator; a unit word after a number gets its own advice. */
  private failAfter(value: ValueNode, close: string): never {
    if (value.type === 'number' && this.current.type === 'ident') {
      this.fail(
        'A number cannot carry units here; write an expression such as `5 mm`.'
      );
    }
    this.fail(
      `Expected \`,\` or \`${close}\` but found ${this.describe(this.current)}.`
    );
  }

  private parseValue(): ValueNode {
    const token = this.current;
    if (this.depth >= MAX_HISTORY_TEXT_DEPTH) {
      this.fail(
        `Values nest more than ${MAX_HISTORY_TEXT_DEPTH} levels deep.`,
        token
      );
    }
    this.depth += 1;
    try {
      return this.parseValueAt(token);
    } finally {
      this.depth -= 1;
    }
  }

  private parseValueAt(token: Token): ValueNode {
    switch (token.type) {
      case 'number': {
        this.next();
        const value = Number(token.text);
        if (!Number.isFinite(value)) this.fail('Number out of range.', token);
        return { type: 'number', value, span: token.span };
      }
      case 'string':
        this.next();
        return { type: 'string', value: token.text, span: token.span };
      case 'expression':
        this.next();
        return { type: 'expression', value: token.text, span: token.span };
      case 'id':
        this.next();
        return { type: 'id', value: token.text, span: token.span };
      case 'punct':
        if (token.text === '{') return this.parseRecord();
        if (token.text === '[') return this.parseList();
        return this.fail(`Expected a value but found ${this.describe(token)}.`);
      case 'ident':
        return this.parseWordValue(token);
      default:
        return this.fail(`Expected a value but found ${this.describe(token)}.`);
    }
  }

  private parseWordValue(token: Token): ValueNode {
    this.next();
    if (token.text === 'true' || token.text === 'false') {
      return {
        type: 'boolean',
        value: token.text === 'true',
        span: token.span
      };
    }
    if (token.text === 'null') return { type: 'null', span: token.span };
    if (token.text === 'expr' && this.isPunct('(')) {
      this.next();
      const text = this.expect('string', 'the expression in quotes');
      const close = this.expectPunct(')');
      return {
        type: 'expression',
        value: text.text,
        span: { start: token.span.start, end: close.span.end }
      };
    }
    if ((token.text === 'face' || token.text === 'edge') && this.isPunct('(')) {
      this.next();
      const feature = this.expect('id', 'the producing feature id (`#…`)');
      this.expectPunct(',');
      const lineage = this.expect('string', 'the lineage name in quotes');
      const close = this.expectPunct(')');
      return {
        type: 'reference',
        referenceKind: token.text,
        feature: feature.text,
        lineage: lineage.text,
        span: { start: token.span.start, end: close.span.end }
      };
    }
    if (this.current.type === 'id') {
      const id = this.next();
      const name = this.expect('string', 'the name in quotes');
      const body = this.parseRecord();
      return {
        type: 'node',
        head: token.text,
        headSpan: token.span,
        id: id.text,
        name: name.text,
        body,
        span: { start: token.span.start, end: body.span.end }
      };
    }
    return this.fail(
      `\`${token.text}\` is not a value. Quote text ("…") or write an expression in backticks (\`…\`).`,
      token
    );
  }
}

/** Parses a history text into its syntax tree. Throws `HistoryTextSyntaxError`. */
export function parseHistoryText(source: string): HistoryTextTree {
  return new Parser(tokenize(source)).parseDocument();
}
