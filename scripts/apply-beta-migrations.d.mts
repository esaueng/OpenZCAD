export function migrationTarget(argv: readonly string[]): {
  database: string;
  config: string;
};

export function applyBetaMigrations(options?: {
  target?: { database: string; config: string };
  run?: () => { status: number; output: string; interrupted?: boolean };
  sleep?: (milliseconds: number) => Promise<unknown>;
  random?: () => number;
  warn?: (message: string) => void;
}): Promise<number>;
