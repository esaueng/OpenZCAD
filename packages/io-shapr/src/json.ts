import type { ShaprImportLimits } from './limits';

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateNestingBeforeParse(
  text: string,
  label: string,
  maxDepth: number
): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{' || character === '[') {
      depth += 1;
      if (depth > maxDepth) {
        throw new Error(`${label} exceeds the JSON nesting-depth limit.`);
      }
    } else if (character === '}' || character === ']') {
      depth -= 1;
    }
  }
}

export function decodeSqlText(value: unknown, label: string): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(value);
    } catch {
      throw new Error(`${label} is not valid UTF-8.`);
    }
  }
  if (value instanceof ArrayBuffer) {
    return decodeSqlText(new Uint8Array(value), label);
  }
  throw new Error(`${label} is not text.`);
}

export function parseBoundedJson(
  value: unknown,
  label: string,
  limits: ShaprImportLimits
): unknown {
  const text = decodeSqlText(value, label);
  if (byteLength(text) > limits.maxJsonBytes) {
    throw new Error(`${label} exceeds the JSON size limit.`);
  }
  // JSON.parse has no depth option. Reject excessive nesting lexically before
  // handing untrusted text to it, then perform the full iterative type walk.
  validateNestingBeforeParse(text, label, limits.maxValueDepth);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }

  const stack: Array<{ value: unknown; depth: number }> = [
    { value: parsed, depth: 0 }
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > limits.maxValueNodes) {
      throw new Error(`${label} exceeds the JSON node-count limit.`);
    }
    if (current.depth > limits.maxValueDepth) {
      throw new Error(`${label} exceeds the JSON nesting-depth limit.`);
    }
    if (typeof current.value === 'number' && !Number.isFinite(current.value)) {
      throw new Error(`${label} contains a non-finite number.`);
    }
    if (
      typeof current.value === 'string' &&
      byteLength(current.value) > limits.maxStringBytes
    ) {
      throw new Error(`${label} contains an oversized string.`);
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > limits.maxArrayItems) {
        throw new Error(`${label} contains an oversized array.`);
      }
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else if (current.value && typeof current.value === 'object') {
      const entries = Object.entries(current.value);
      if (entries.length > limits.maxArrayItems) {
        throw new Error(`${label} contains an oversized object.`);
      }
      for (const [key, child] of entries) {
        if (byteLength(key) > limits.maxStringBytes) {
          throw new Error(`${label} contains an oversized property name.`);
        }
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return parsed;
}
