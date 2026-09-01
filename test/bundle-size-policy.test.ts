import { describe, expect, it } from 'vitest';
import {
  evaluateKernelPinGrowth,
  evaluateKernelWasm,
  KERNEL_WASM_POLICY,
  measureKernelWasm
} from '../scripts/bundle-size-policy.mjs';

function metrics(
  overrides: Partial<ReturnType<typeof measureKernelWasm>> = {}
) {
  return {
    rawBytes: 8 * 1024 * 1024,
    gzipBytes: 2_750_000,
    brotliBytes: 2_000_000,
    ...overrides
  };
}

describe('kernel WASM size policy', () => {
  it('warns at the raw review threshold without failing', () => {
    const below = evaluateKernelWasm(
      metrics({ rawBytes: KERNEL_WASM_POLICY.rawReviewBytes - 1 })
    );
    const at = evaluateKernelWasm(
      metrics({ rawBytes: KERNEL_WASM_POLICY.rawReviewBytes })
    );

    expect(below.warnings).toEqual([]);
    expect(at.warnings.map(({ code }) => code)).toContain('kernel-raw-review');
    expect(at.failures).toEqual([]);
  });

  it('allows the exact raw hard limit and refuses one byte more', () => {
    expect(
      evaluateKernelWasm(metrics({ rawBytes: KERNEL_WASM_POLICY.rawHardBytes }))
        .failures
    ).toEqual([]);
    expect(
      evaluateKernelWasm(
        metrics({ rawBytes: KERNEL_WASM_POLICY.rawHardBytes + 1 })
      ).failures.map(({ code }) => code)
    ).toContain('kernel-raw-hard');
  });

  it('allows the exact gzip hard limit and refuses one byte more', () => {
    expect(
      evaluateKernelWasm(
        metrics({ gzipBytes: KERNEL_WASM_POLICY.gzipHardBytes })
      ).failures
    ).toEqual([]);
    expect(
      evaluateKernelWasm(
        metrics({ gzipBytes: KERNEL_WASM_POLICY.gzipHardBytes + 1 })
      ).failures.map(({ code }) => code)
    ).toContain('kernel-gzip-hard');
  });

  it('keeps the Brotli threshold advisory', () => {
    const result = evaluateKernelWasm(
      metrics({ brotliBytes: KERNEL_WASM_POLICY.brotliReviewBytes + 1 })
    );

    expect(result.warnings.map(({ code }) => code)).toContain(
      'kernel-brotli-review'
    );
    expect(result.failures).toEqual([]);
  });

  it('measures compression deterministically for fixed bytes', () => {
    const input = Buffer.concat([
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
      Buffer.from('openzcad-remus-wasm-policy'.repeat(100))
    ]);

    expect(measureKernelWasm(input)).toEqual(measureKernelWasm(input));
  });

  it('refuses non-WASM input', () => {
    expect(() =>
      measureKernelWasm(Buffer.from('{"message":"Not Found"}'))
    ).toThrow('not a version 1 WebAssembly module');
  });
});

describe('kernel pin growth policy', () => {
  it('reviews an absolute increase over 256 KiB', () => {
    const before = metrics({ rawBytes: 10 * 1024 * 1024 });
    const after = metrics({
      rawBytes: before.rawBytes + KERNEL_WASM_POLICY.pinRawGrowthReviewBytes + 1
    });
    const result = evaluateKernelPinGrowth(before, after);

    expect(result.requiresReview).toBe(true);
    expect(result.triggers).toContain('raw growth exceeds 256 KiB');
    expect(result.triggers).not.toContain('raw growth exceeds 3%');
  });

  it('reviews a percentage increase over 3%', () => {
    const before = metrics({ rawBytes: 1024 * 1024 });
    const after = metrics({
      rawBytes:
        before.rawBytes +
        Math.floor(
          before.rawBytes * KERNEL_WASM_POLICY.pinRawGrowthReviewRatio
        ) +
        1
    });
    const result = evaluateKernelPinGrowth(before, after);

    expect(result.requiresReview).toBe(true);
    expect(result.triggers).toContain('raw growth exceeds 3%');
    expect(result.triggers).not.toContain('raw growth exceeds 256 KiB');
  });

  it('does not review exact threshold values', () => {
    const before = metrics({ rawBytes: 20 * 1024 * 1024 });
    const after = metrics({
      rawBytes: before.rawBytes + KERNEL_WASM_POLICY.pinRawGrowthReviewBytes
    });

    expect(evaluateKernelPinGrowth(before, after).requiresReview).toBe(false);
  });
});
