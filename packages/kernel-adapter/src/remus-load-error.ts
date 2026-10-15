/** Loading the runtime failed before any source file could be parsed. */
export class RemusTranslatorLoadError extends Error {
  readonly category = 'environment-load';

  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : 'The Remus file-format translators failed to load.',
      { cause }
    );
    this.name = 'RemusTranslatorLoadError';
  }
}
