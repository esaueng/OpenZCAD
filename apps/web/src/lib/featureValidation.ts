/** Returns a kernel warning attributed to one named feature, without its prefix. */
export function warningForFeature(
  featureName: string,
  warnings: readonly string[]
): string | null {
  const prefix = `Feature "${featureName}":`;
  const match = warnings.find((warning) => warning.startsWith(prefix));
  return match ? match.replace(/^Feature "[^"]+":\s*/, '') : null;
}

export interface ValidatedFeatureVerdictInput {
  featureName: string;
  warnings: readonly string[];
  bodyPresent: boolean;
  documentMoved: boolean;
}

export function validatedFeatureRejection(
  input: ValidatedFeatureVerdictInput
): string | null {
  const warning = warningForFeature(input.featureName, input.warnings);
  if (warning) {
    return warning;
  }
  if (!input.bodyPresent) {
    return 'The operation did not produce its result body.';
  }
  if (input.documentMoved) {
    return 'The document changed while the operation validated.';
  }
  return null;
}
