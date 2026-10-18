import { GraduationCap } from 'lucide-react';

/**
 * A line drawing of the part each demo builds, so the entry is recognisable
 * before it is read: the bracket's L-plate with its boss, holes and fillet,
 * the flange's bore and bolt circle, the heat sink's fins on their base. An
 * unknown demo keeps the generic tutorial mark.
 */
export function DemoModelIcon({ demoKey }: { demoKey: string }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  };
  switch (demoKey) {
    case 'bracket':
      return (
        <svg {...common}>
          <path d="M4 3.5h5.5v11h11v5.5H4z" />
          <circle cx="6.75" cy="8" r="1.6" />
          <circle cx="13.5" cy="17.25" r="1" />
          <circle cx="17.5" cy="17.25" r="1" />
          <path d="M9.5 12.5c0 1.2.8 2 2 2" />
        </svg>
      );
    case 'flange':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="3.6" />
          <circle cx="18.5" cy="12" r=".9" />
          <circle cx="5.5" cy="12" r=".9" />
          <circle cx="15.25" cy="17.6" r=".9" />
          <circle cx="8.75" cy="17.6" r=".9" />
          <circle cx="15.25" cy="6.4" r=".9" />
          <circle cx="8.75" cy="6.4" r=".9" />
        </svg>
      );
    case 'heatsink':
      return (
        <svg {...common}>
          <path d="M3 16.5h18v3.5H3z" />
          <path d="M4.5 16.5V5h1.6v11.5M8.6 16.5V5h1.6v11.5M12.7 16.5V5h1.6v11.5M16.8 16.5V5h1.6v11.5" />
        </svg>
      );
    default:
      return <GraduationCap size={15} aria-hidden="true" />;
  }
}
