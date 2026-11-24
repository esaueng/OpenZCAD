/** Actions offered when the kernel cannot distinguish a chamfer from a draft. */
export function RimChoiceActions({
  choose,
  className
}: {
  choose: (choice: 'chamfer' | 'draft') => void;
  className: string;
}) {
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => choose('chamfer')}
      >
        Carry chamfer
      </button>
      <button
        type="button"
        className={className}
        onClick={() => choose('draft')}
      >
        Extend draft
      </button>
    </>
  );
}
