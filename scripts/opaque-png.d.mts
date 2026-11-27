import type { Buffer } from 'node:buffer';

export function readPngChunks(png: Buffer): { type: string; data: Buffer }[];
export function pngColorType(png: Buffer): number;
export function removePngAlpha(png: Buffer): Buffer;
