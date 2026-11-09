export interface CapturePair {
  name: string;
  before: boolean;
  after: boolean;
}

export function pairCaptures(
  before: readonly string[],
  after: readonly string[]
): CapturePair[];

export function comparisonPage(options: {
  beforeDir: string;
  afterDir: string;
  out: string;
}): string;
