import type { QualificationReceipt } from './ci-qualification-report.mjs';

export const TRACKING_MARKER: string;
export const TRACKING_TITLE: string;

export interface TrackingMeta {
  server: string;
  repository: string;
}

export interface TrackingIssue {
  number: number;
  html_url?: string;
  body?: string | null;
  user?: { login: string } | null;
  pull_request?: unknown;
}

export type TrackingPlan =
  | { action: 'none' }
  | { action: 'create'; title: string; body: string }
  | { action: 'update'; body: string; comment: string }
  | { action: 'close'; comment: string };

export function runUrl(
  receipt: QualificationReceipt,
  meta: TrackingMeta
): string;

export function issueBody(
  receipt: QualificationReceipt,
  meta: TrackingMeta
): string;

export function trackingPlan(
  receipt: QualificationReceipt,
  openIssue: TrackingIssue | null,
  meta: TrackingMeta
): TrackingPlan;

export function findTrackingIssue(
  issues: TrackingIssue[]
): TrackingIssue | null;
