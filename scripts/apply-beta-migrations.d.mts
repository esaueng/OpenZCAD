export function applyBetaMigrations(options?: {
  run?: () => { status: number; output: string; interrupted?: boolean };
  sleep?: (milliseconds: number) => Promise<unknown>;
  random?: () => number;
  warn?: (message: string) => void;
}): Promise<number>;
