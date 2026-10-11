import { createContext, useContext } from 'react';

/**
 * Lets an expression field define a parameter it names before the parameter
 * exists. Typing `width` into a Box's Width used to end at "Unknown
 * identifier" and a disabled Create: cancel, open Parameters, add it, start
 * the tool again. The workspace provides this once, and every `ExprInput`
 * under it — create cards, edit panels, sketch fields — offers to define the
 * name in place through the same command the Parameters panel uses.
 *
 * Absent (null) where no document can take a parameter: the field then shows
 * the plain error, as it always did.
 */
export interface ParameterDefinition {
  /**
   * Whether the table already has this name. A parameter whose expression
   * does not evaluate is missing from the scope a field evaluates against,
   * yet defining it again would overwrite it.
   */
  has(name: string): boolean;
  /**
   * Adds the parameter, or resolves to the reason it was refused. It never
   * replaces a parameter that exists by the time it runs.
   */
  define(name: string, expression: string): Promise<string | null>;
}

const ParameterDefinitionContext = createContext<ParameterDefinition | null>(
  null
);

export const ParameterDefinitionProvider = ParameterDefinitionContext.Provider;

export function useParameterDefinition(): ParameterDefinition | null {
  return useContext(ParameterDefinitionContext);
}
