import { Check } from 'lucide-react';
import type { ReadinessItem } from '../lib/workflow';

interface ValidationChecklistProps {
  items: ReadinessItem[];
}

export function ValidationChecklist({ items }: ValidationChecklistProps) {
  return (
    <div className="checklist" role="list" aria-label="Setup checklist">
      {items.map((item) => (
        <div key={item.id} role="listitem" className={`check ${item.done ? 'done' : ''}`}>
          <span aria-hidden="true">{item.done ? <Check size={12} /> : null}</span>
          {item.label}
        </div>
      ))}
    </div>
  );
}
