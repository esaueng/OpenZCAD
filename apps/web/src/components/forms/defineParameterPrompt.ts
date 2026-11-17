import { useEffect, useState, type ComponentType } from 'react';
import type { FieldQuantity } from '@openzcad/document-core';
import { previewExpression } from '../../lib/model';
import type { DefineParameterPrompt as DefineParameterPromptComponent } from '../DefineParameterPrompt';
import type { ParameterDefinition } from './parameterDefinition';

// The define prompt is off the entry chunk: the fields that offer it (an
// expression field, the keypad, a command's Options row) are in it, and the
// prompt only appears once someone types a name that is not a parameter yet.
// It is fetched when a field that could offer it mounts, and rendered only
// once loaded — never behind a Suspense fallback, which Tab would skip past,
// and never by swapping a lazy wrapper for the loaded component, which would
// remount it and drop a value being typed. Until then, or if the chunk will
// not load, the field shows the plain error it always did.
type PromptComponent = ComponentType<
  Parameters<typeof DefineParameterPromptComponent>[0]
>;
let loadedPrompt: PromptComponent | null = null;
let promptLoad: Promise<void> | null = null;

function loadDefineParameterPrompt(): Promise<void> {
  promptLoad ??= import('../DefineParameterPrompt').then(
    (module) => {
      loadedPrompt = module.DefineParameterPrompt;
    },
    () => {
      // A field mounted later tries again.
      promptLoad = null;
    }
  );
  return promptLoad;
}

/**
 * The loaded prompt component while `wanted`. Loading starts as soon as a
 * field that could offer it mounts (`available`): a card's fields mount when
 * it opens, well before a name can be typed into one and Tab pressed after it.
 */
export function useDefineParameterPrompt(
  available: boolean,
  wanted: boolean
): PromptComponent | null {
  const [, setLoaded] = useState(false);
  useEffect(() => {
    if (!available || loadedPrompt) return;
    let live = true;
    void loadDefineParameterPrompt().then(() => {
      if (live && loadedPrompt) setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [available]);
  return wanted ? loadedPrompt : null;
}

/**
 * The name a field's text reads that no parameter defines yet, when
 * defining it is all the text needs; null otherwise, and null where no
 * document can take a parameter. A parameter whose own expression is broken
 * is absent from the scope yet present in the table: it is not offered,
 * since defining it again would overwrite it.
 */
export function undefinedParameterName(
  text: string,
  scope: Record<string, number>,
  definition: ParameterDefinition | null,
  quantity?: FieldQuantity
): string | null {
  if (!definition) return null;
  const name = previewExpression(text, scope, quantity).undefinedParameter;
  return name && !definition.has(name) ? name : null;
}
