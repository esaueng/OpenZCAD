import type { ShaprImportLimits } from './limits';

interface DecodeState {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly limits: ShaprImportLimits;
  offset: number;
  nodes: number;
}

function ensure(state: DecodeState, count: number): void {
  if (count < 0 || state.offset + count > state.bytes.byteLength) {
    throw new Error('MessagePack value is truncated.');
  }
}

function readString(state: DecodeState, length: number): string {
  if (length > state.limits.maxStringBytes) {
    throw new Error('MessagePack string exceeds the import limit.');
  }
  ensure(state, length);
  const bytes = state.bytes.subarray(state.offset, state.offset + length);
  state.offset += length;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('MessagePack string is not valid UTF-8.');
  }
}

function readArray(
  state: DecodeState,
  length: number,
  depth: number
): unknown[] {
  if (length > state.limits.maxArrayItems) {
    throw new Error('MessagePack array exceeds the import limit.');
  }
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    values.push(readValue(state, depth + 1));
  }
  return values;
}

function safeBigInt(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw new Error(
      'MessagePack integer exceeds JavaScript safe-integer range.'
    );
  }
  return converted;
}

function readValue(state: DecodeState, depth: number): unknown {
  if (depth > state.limits.maxValueDepth) {
    throw new Error('MessagePack value exceeds the nesting-depth limit.');
  }
  state.nodes += 1;
  if (state.nodes > state.limits.maxValueNodes) {
    throw new Error('MessagePack value exceeds the node-count limit.');
  }
  ensure(state, 1);
  const prefix = state.bytes[state.offset++]!;
  if (prefix <= 0x7f) {
    return prefix;
  }
  if (prefix >= 0xe0) {
    return prefix - 0x100;
  }
  if ((prefix & 0xe0) === 0xa0) {
    return readString(state, prefix & 0x1f);
  }
  if ((prefix & 0xf0) === 0x90) {
    return readArray(state, prefix & 0x0f, depth);
  }
  switch (prefix) {
    case 0xc0:
      return null;
    case 0xc2:
      return false;
    case 0xc3:
      return true;
    case 0xca: {
      ensure(state, 4);
      const value = state.view.getFloat32(state.offset, false);
      state.offset += 4;
      if (!Number.isFinite(value)) {
        throw new Error('MessagePack contains a non-finite number.');
      }
      return value;
    }
    case 0xcb: {
      ensure(state, 8);
      const value = state.view.getFloat64(state.offset, false);
      state.offset += 8;
      if (!Number.isFinite(value)) {
        throw new Error('MessagePack contains a non-finite number.');
      }
      return value;
    }
    case 0xcc:
      ensure(state, 1);
      return state.bytes[state.offset++]!;
    case 0xcd: {
      ensure(state, 2);
      const value = state.view.getUint16(state.offset, false);
      state.offset += 2;
      return value;
    }
    case 0xce: {
      ensure(state, 4);
      const value = state.view.getUint32(state.offset, false);
      state.offset += 4;
      return value;
    }
    case 0xcf: {
      ensure(state, 8);
      const value = safeBigInt(state.view.getBigUint64(state.offset, false));
      state.offset += 8;
      return value;
    }
    case 0xd0:
      ensure(state, 1);
      return state.view.getInt8(state.offset++);
    case 0xd1: {
      ensure(state, 2);
      const value = state.view.getInt16(state.offset, false);
      state.offset += 2;
      return value;
    }
    case 0xd2: {
      ensure(state, 4);
      const value = state.view.getInt32(state.offset, false);
      state.offset += 4;
      return value;
    }
    case 0xd3: {
      ensure(state, 8);
      const value = safeBigInt(state.view.getBigInt64(state.offset, false));
      state.offset += 8;
      return value;
    }
    case 0xd9:
      ensure(state, 1);
      return readString(state, state.bytes[state.offset++]!);
    case 0xda: {
      ensure(state, 2);
      const length = state.view.getUint16(state.offset, false);
      state.offset += 2;
      return readString(state, length);
    }
    case 0xdb: {
      ensure(state, 4);
      const length = state.view.getUint32(state.offset, false);
      state.offset += 4;
      return readString(state, length);
    }
    case 0xdc: {
      ensure(state, 2);
      const length = state.view.getUint16(state.offset, false);
      state.offset += 2;
      return readArray(state, length, depth);
    }
    case 0xdd: {
      ensure(state, 4);
      const length = state.view.getUint32(state.offset, false);
      state.offset += 4;
      return readArray(state, length, depth);
    }
    default:
      throw new Error(
        `MessagePack type 0x${prefix.toString(16).padStart(2, '0')} is unsupported.`
      );
  }
}

export function decodeShaprMessagePack(
  bytes: Uint8Array,
  limits: ShaprImportLimits
): unknown {
  if (bytes.byteLength > limits.maxMessagePackBytes) {
    throw new Error('MessagePack property exceeds the import limit.');
  }
  const state: DecodeState = {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    limits,
    offset: 0,
    nodes: 0
  };
  const value = readValue(state, 0);
  if (state.offset !== bytes.byteLength) {
    throw new Error('MessagePack property contains trailing bytes.');
  }
  return value;
}
