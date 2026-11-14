import { useMemo, useState } from 'react';
import { Pin } from 'lucide-react';
import { commandFactories } from '@openzcad/command-system';
import {
  ownEntry,
  createId,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
import type { AssemblyExecute } from '../../lib/assembly/assembleWorkspace';
import { assemblyName } from '../../lib/assembly/assemblyUi';

export interface AssemblyFirstRunCardProps {
  document: ProjectDocument;
  execute: AssemblyExecute;
  /** A notice after the components are made (the toast). */
  onAnnounce(message: string): void;
}

/** Bodies a component can be made from: shown, not consumed by a feature. */
export function assemblyCandidateBodies(
  document: ProjectDocument
): { bodyId: BodyId; name: string }[] {
  return document.bodyOrder.flatMap((bodyId) => {
    const body = ownEntry(document.derived.bodyRepresentations, bodyId);
    if (!body || body.consumed) return [];
    return [{ bodyId, name: assemblyName(body.name, 'Body') }];
  });
}

/**
 * Assemble's first run (AS01): no components yet, so the workspace offers to
 * make one per body, every body checked and the first one grounded. One
 * command, so a single undo takes the whole assembly back out.
 */
export function AssemblyFirstRunCard({
  document,
  execute,
  onAnnounce
}: AssemblyFirstRunCardProps) {
  const bodies = useMemo(() => assemblyCandidateBodies(document), [document]);
  const [excluded, setExcluded] = useState<ReadonlySet<BodyId>>(new Set());
  const [grounded, setGrounded] = useState<ReadonlySet<BodyId> | null>(null);
  // Grounds the first body until the user chooses otherwise.
  const groundedIds = grounded ?? new Set(bodies[0] ? [bodies[0].bodyId] : []);
  const chosen = bodies.filter((body) => !excluded.has(body.bodyId));
  const count = chosen.length;

  const toggle = (
    set: ReadonlySet<BodyId>,
    bodyId: BodyId
  ): ReadonlySet<BodyId> => {
    const next = new Set(set);
    if (next.has(bodyId)) next.delete(bodyId);
    else next.add(bodyId);
    return next;
  };

  const create = () => {
    if (count === 0) return;
    const components = chosen.map((body) => ({
      componentId: createId<'AssemblyComponent'>('comp'),
      name: body.name,
      bodyId: body.bodyId,
      grounded: groundedIds.has(body.bodyId)
    }));
    if (!execute(commandFactories.addAssemblyComponents({ components })))
      return;
    const groundedCount = components.filter((c) => c.grounded).length;
    onAnnounce(
      `${count} ${count === 1 ? 'part' : 'parts'} · ${groundedCount} fixed. Next: press J to join two parts`
    );
  };

  return (
    <section
      className="assembly-first-run"
      aria-labelledby="assembly-first-run-title"
    >
      <h2 id="assembly-first-run-title" className="assembly-first-run-title">
        Start an assembly
      </h2>
      {bodies.length === 0 ? (
        <p className="assembly-muted">
          This document has no bodies yet. Model one in Build, then come back to
          join and move them here.
        </p>
      ) : (
        <>
          <p className="assembly-muted">
            Tick the bodies that are parts. A fixed part stays where you
            modelled it; joints move the rest. You can add more later.
          </p>
          <ul className="assembly-first-run-list" aria-label="Bodies">
            {bodies.map((body) => {
              const included = !excluded.has(body.bodyId);
              const isGrounded = groundedIds.has(body.bodyId);
              return (
                <li key={body.bodyId} className="assembly-first-run-row">
                  <label className="assembly-check">
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={() =>
                        setExcluded((current) => toggle(current, body.bodyId))
                      }
                    />
                    <span className="assembly-row-name">{body.name}</span>
                  </label>
                  <button
                    type="button"
                    className={`assembly-pin${isGrounded ? ' is-on' : ''}`}
                    aria-pressed={isGrounded}
                    aria-label={`Fix ${body.name} in place`}
                    title={isGrounded ? 'Fixed in place' : 'Fix in place'}
                    disabled={!included}
                    onClick={() =>
                      setGrounded(toggle(groundedIds, body.bodyId))
                    }
                  >
                    <Pin size={13} aria-hidden="true" />
                    <span>{isGrounded ? 'Fixed' : 'Fix'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <div className="assembly-actions">
        <button
          type="button"
          className="primary"
          disabled={count === 0}
          onClick={create}
        >
          Add {count} {count === 1 ? 'part' : 'parts'}
        </button>
      </div>
    </section>
  );
}
