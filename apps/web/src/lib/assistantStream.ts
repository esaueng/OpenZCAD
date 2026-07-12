import {
  parseCadPatchProposal,
  type CadPatchProposal
} from '@openzcad/ai-contracts';

interface AssistantStreamOptions {
  signal?: AbortSignal;
  onDelta?(text: string): void;
}

export function readAssistantEvent(
  event: unknown,
  currentText: string
): { text: string; done: boolean } {
  if (!event || typeof event !== 'object') {
    return { text: currentText, done: false };
  }
  const value = event as Record<string, unknown>;
  if (
    value.type === 'response.output_text.delta' &&
    typeof value.delta === 'string'
  ) {
    return { text: currentText + value.delta, done: false };
  }
  if (
    value.type === 'response.output_text.done' &&
    typeof value.text === 'string'
  ) {
    return { text: value.text, done: true };
  }
  if (value.type === 'response.failed' || value.type === 'error') {
    throw new Error('The modeling assistant could not complete the proposal.');
  }
  return { text: currentText, done: value.type === 'response.completed' };
}

export async function streamCadPatchProposal(
  prompt: string,
  digest: unknown,
  options: AssistantStreamOptions = {}
): Promise<CadPatchProposal> {
  const response = await fetch('/api/assistant/proposals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, digest }),
    signal: options.signal
  });
  if (!response.ok || !response.body) {
    const error = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      error?.error ?? `Assistant request failed (${response.status}).`
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') {
        continue;
      }
      const next = readAssistantEvent(JSON.parse(data), output);
      output = next.text;
      options.onDelta?.(output);
    }
    if (done) {
      break;
    }
  }

  if (!output.trim()) {
    throw new Error('The modeling assistant returned an empty proposal.');
  }
  return parseCadPatchProposal(JSON.parse(output));
}
