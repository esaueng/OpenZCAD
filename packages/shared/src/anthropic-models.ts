/** Models predating adaptive thinking use an explicit extended-thinking budget. */
export function anthropicUsesLegacyThinking(model: string): boolean {
  return [
    'claude-opus-4-5',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
    'claude-opus-4-1',
    'claude-opus-4',
    'claude-sonnet-4',
    'claude-3-7-sonnet',
    'claude-3-7-sonnet-latest'
  ].includes(model.trim().replace(/-\d{8}$/, ''));
}

/** Native way to turn thinking off, when a documented model supports it. */
export function anthropicThinkingOffType(
  model: string
): 'disabled' | 'between_tools' | undefined {
  const alias = model.trim().replace(/-\d{8}$/, '');
  if (anthropicUsesLegacyThinking(model)) return 'disabled';
  if (alias === 'claude-sonnet-5-5') return 'between_tools';
  if (
    [
      'claude-haiku-5-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5'
    ].includes(alias)
  )
    return 'disabled';
  // Always-thinking and unknown models must not receive an unsupported Off.
  return undefined;
}
