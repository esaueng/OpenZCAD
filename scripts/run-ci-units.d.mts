export function relatedFiles(
  project: 'root' | 'web',
  data: unknown,
  cwd: string
): string[];
export function selectedFiles(
  project: 'root' | 'web',
  related: string[],
  env?: Record<string, string | undefined>
): string[];
export function runUnits(
  args: string[],
  env: Record<string, string | undefined>,
  execute: (
    file: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      stdio: string;
    }
  ) => { status: number | null; error?: Error }
): number;
