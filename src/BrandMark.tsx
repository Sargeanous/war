import { useState } from "react";

// The platform mark. Where a customer emblem is supplied it takes the mark
// position; the asset lives outside the repo, so the platform's own glyph
// stands in until the file is present and the shell never shows a broken
// image. Drop the emblem at public/mod-emblem.png (or .svg) to use it.
const EMBLEM_SRC = "/mod-emblem.png";

interface BrandMarkProps {
  size?: number;
  title?: string;
}

export default function BrandMark({ size = 34, title = "SANDTABLE" }: BrandMarkProps) {
  const [emblemFailed, setEmblemFailed] = useState(false);

  if (!emblemFailed) {
    return (
      <img
        className="brand-emblem"
        src={EMBLEM_SRC}
        width={size}
        height={size}
        alt={title}
        onError={() => setEmblemFailed(true)}
      />
    );
  }

  return <SandtableGlyph size={size} title={title} />;
}

// Drawn from the platform's own vocabulary rather than generic military
// insignia: the hexagon is the board cell the engine reasons in, the ridge is
// the terrain model the name refers to, and the delta is a piece standing on
// it. Strokes use currentColor so the mark inherits whatever surface it sits
// on; only the piece carries the brand accent.
function SandtableGlyph({ size, title }: { size: number; title: string }) {
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
