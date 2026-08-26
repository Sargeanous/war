// SANDTABLE's mark, drawn from the platform's own vocabulary rather than
// generic military insignia: the hex is the board cell the engine reasons in,
// the ridge is the terrain model the name refers to, and the delta is a piece
// standing on it. Strokes use currentColor so the mark inherits whatever
// surface it sits on; only the piece carries the brand accent.

interface BrandMarkProps {
  size?: number;
  title?: string;
}

export default function BrandMark({ size = 34, title = "SANDTABLE" }: BrandMarkProps) {
  return (
    <svg
      className="brand-glyph"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label={title}
    >
      <path
        d="M23 3.9 L30 16 L23 28.1 L9 28.1 L2 16 L9 3.9 Z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        d="M6.4 26.2 L10.6 21.4 L13.6 24 L18 17.6 L21.8 21.4 L25.6 18"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.42"
      />
      <path
        d="M6.4 22.6 L10.6 17.8 L13.6 20.4 L18 14 L21.8 17.8 L25.6 14.4"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M18 6.2 L21.1 11.6 L14.9 11.6 Z" fill="var(--primary, #35c26e)" />
    </svg>
  );
}
