/**
 * The raw text behind a plain failure message (see `lib/plainFailure.ts`),
 * folded under "Details" so it is there for a bug report without being what
 * the user reads first.
 */
export function FailureDetails({ detail }: { detail: string | undefined }) {
  if (!detail) return null;
  return (
    <details className="failure-details">
      <summary>Details</summary>
      <code>{detail}</code>
    </details>
  );
}
