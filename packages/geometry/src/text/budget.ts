import { textObjectBudgetError } from '@openzcad/shared';
import { TextGeometryError } from './types';

export function requireTextBudget(text: unknown): void {
  const error = textObjectBudgetError(text);
  if (error) throw new TextGeometryError(error);
}
