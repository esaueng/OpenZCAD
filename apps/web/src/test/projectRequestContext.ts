/**
 * Asserts that requests carrying a project's content declared their
 * request-local context (`projectWriteGate.ts`): the project they write
 * and whether their payload is plaintext or encrypted. The gate refuses
 * an undeclared one at its send, so a path that forgets fails closed;
 * this helper lets each path's own tests say it declares the right thing.
 */
import { expect } from 'vitest';
import {
  carriesProjectContent,
  declaredProjectContext,
  type ProjectRequestContext
} from '../lib/projectWriteGate';

/** A request as a stubbed `fetch` saw it: `mock.calls` works as is. */
export type SentRequest = readonly [
  input: RequestInfo | URL | string,
  init?: RequestInit
];

function describeRequest([input, init]: SentRequest): string {
  const path =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  return `${(init?.method ?? 'GET').toUpperCase()} ${path}`;
}

/**
 * Every content-bearing request in `sent` declared `expected` (at least
 * one must be there). Returns those requests, for further checks.
 */
export function expectDeclaredProjectContext(
  sent: readonly SentRequest[],
  expected: ProjectRequestContext
): SentRequest[] {
  const content = sent.filter(([input, init]) =>
    carriesProjectContent(input, init)
  );
  expect(
    content.length,
    'no request carrying project content was sent'
  ).toBeGreaterThan(0);
  for (const request of content) {
    expect(
      declaredProjectContext(request[1]),
      `${describeRequest(request)} declared no or another context`
    ).toEqual(expected);
  }
  return content;
}
