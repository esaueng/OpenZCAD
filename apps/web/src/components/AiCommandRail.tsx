import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, Eye, Sparkles, X } from 'lucide-react';
import {
  createCadDocumentDigest,
  type CadSelectionContext,
  type CadPatchProposal
} from '@openzcad/ai-contracts';
import type { ProjectDocument } from '@openzcad/shared';
import {
  loadAssistantStatus,
  streamCadPatchProposal,
  type AssistantStatus
} from '../lib/assistantStream';

interface AiCommandRailProps {
  document: ProjectDocument;
  selection: CadSelectionContext;
  /** Returns false when the patch could not be applied, so the rail can say so. */
  onApply(proposal: CadPatchProposal): boolean;
  /** Returns false when the patch could not be previewed. */
  onPreview(proposal: CadPatchProposal | null): boolean;
}

export function AiCommandRail({
  document,
  selection,
  onApply,
  onPreview
}: AiCommandRailProps) {
  const [prompt, setPrompt] = useState('');
  const [proposal, setProposal] = useState<CadPatchProposal | null>(null);
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'ready' | 'error'>(
    'idle'
  );
  const [message, setMessage] = useState('Describe a precise modeling change.');
  const [previewing, setPreviewing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [assistantStatus, setAssistantStatus] =
    useState<AssistantStatus | null>(null);

  const selectionSummary = (() => {
    const topologyKind = selection.topologies[0]?.kind;
    if (
      topologyKind &&
      selection.topologies.every((topology) => topology.kind === topologyKind)
    ) {
      const count = selection.topologies.length;
      return `${count} selected ${topologyKind}${count === 1 ? '' : 's'}`;
    }
    if (selection.bodyIds.length > 0) {
      const count = selection.bodyIds.length;
      return `${count} selected bod${count === 1 ? 'y' : 'ies'}`;
    }
    if (selection.featureIds.length > 0) {
      const count = selection.featureIds.length;
      return `${count} selected feature${count === 1 ? '' : 's'}`;
    }
    return null;
  })();

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    void loadAssistantStatus(controller.signal)
      .then((status) => {
        setAssistantStatus(status);
        if (status.configured) {
          setPhase('idle');
          setMessage(
            `Ready · ${status.model} · ${status.reasoningEffort} reasoning.`
          );
        } else {
          setPhase('error');
          setMessage(
            status.provider === 'openrouter'
              ? 'Set OPENROUTER_API_KEY in your shell or apps/web/.dev.vars (or as a beta Worker secret), then restart the app.'
              : 'Add AI_API_KEY to apps/web/.dev.vars (or a beta Worker secret), then restart the app.'
          );
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setPhase('error');
          setMessage(
            error instanceof Error
              ? error.message
              : 'Assistant status is unavailable.'
          );
        }
      });
    return () => controller.abort();
  }, []);

  async function propose() {
    const request = prompt.trim();
    if (!request || phase === 'thinking' || !assistantStatus?.configured) {
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setProposal(null);
    setPreviewing(false);
    onPreview(null);
    setPhase('thinking');
    setMessage(
      selectionSummary
        ? `Reasoning over ${selectionSummary} and the feature history…`
        : 'Reasoning over the feature history…'
    );
    try {
      // Capture one immutable context snapshot. If the user changes selection
      // while the provider is thinking, this proposal still names the exact
      // entities they meant when they submitted it.
      const digest = createCadDocumentDigest(document, selection);
      const next = await streamCadPatchProposal(
        request,
        digest,
        { signal: controller.signal }
      );
      setProposal(next);
      setPhase('ready');
      setMessage(next.summary);
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setPhase('error');
      setMessage(
        error instanceof Error ? error.message : 'Proposal generation failed.'
      );
    }
  }

  function reject() {
    setProposal(null);
    setPreviewing(false);
    onPreview(null);
    setPhase('idle');
    setMessage('Proposal rejected. Describe another change.');
  }

  return (
    <section className="ai-rail" aria-label="AI modeling assistant">
      <div className="ai-prompt-wrap">
        <Sparkles size={15} aria-hidden="true" />
        <textarea
          value={prompt}
          rows={1}
          placeholder={
            selectionSummary
              ? `Ask OpenZCAD to change ${selectionSummary}…`
              : 'Ask OpenZCAD to change the model…'
          }
          aria-label="CAD change request"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void propose();
            }
          }}
        />
        <button
          type="button"
          className="ai-submit"
          disabled={
            !prompt.trim() ||
            phase === 'thinking' ||
            !assistantStatus?.configured
          }
          onClick={() => void propose()}
          aria-label="Generate CAD patch"
          title="Generate proposal (Enter)"
        >
          <ArrowUp size={15} aria-hidden="true" />
        </button>
      </div>
      <div className={`ai-proposal ${phase}`} aria-live="polite">
        <span className="ai-proposal-label">
          {phase === 'thinking'
            ? 'Reasoning'
            : phase === 'ready'
              ? 'Proposed patch'
              : 'Assistant'}
        </span>
        <span className="ai-proposal-copy">{message}</span>
        {proposal && (
          <div className="ai-actions">
            <button
              type="button"
              className={previewing ? 'active' : ''}
              onClick={() => {
                if (previewing) {
                  onPreview(null);
                  setPreviewing(false);
                  return;
                }
                // Leave the toggle off when the preview could not be built, so
                // the button never claims to be showing something it is not.
                if (!onPreview(proposal)) {
                  setMessage(
                    'That patch could not be previewed. See the status bar for details.'
                  );
                  return;
                }
                setPreviewing(true);
              }}
            >
              <Eye size={13} aria-hidden="true" />
              {previewing ? 'Hide preview' : 'Preview'}
            </button>
            <button
              type="button"
              className="apply"
              onClick={() => {
                onPreview(null);
                setPreviewing(false);
                // A patch can still fail at apply — an expression that will not
                // evaluate, or a body an earlier operation consumed. Keep the
                // proposal on screen when that happens instead of reporting a
                // success that did not occur.
                if (!onApply(proposal)) {
                  setMessage(
                    'That patch could not be applied. See the status bar for details.'
                  );
                  return;
                }
                setProposal(null);
                setPrompt('');
                setPhase('idle');
                setMessage('Patch applied as one undoable edit.');
              }}
            >
              <Check size={13} aria-hidden="true" />
              Apply patch
            </button>
            <button type="button" onClick={reject}>
              <X size={13} aria-hidden="true" />
              Reject
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
