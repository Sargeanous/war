// Classification markings.
//
// Nothing in SANDTABLE carried a classification, which is a hard blocker for any
// real deployment and an obvious gap to anyone who has worked in a headquarters.
// Every document the platform emits is marked, every marking inherits by high
// water from what it was built from, and paragraphs carry portion marks so a
// reader can see which part of a document earned the overall marking.
//
// The data is fictional, so every marking here also carries the EXERCISE caveat.
// Nothing produced by this platform is a real classified product.

export const CLASSIFICATION_LEVELS = [
  { id: "unclassified", label: "UNCLASSIFIED", portion: "U", rank: 0 },
  { id: "restricted", label: "RESTRICTED", portion: "R", rank: 1 },
  { id: "confidential", label: "CONFIDENTIAL", portion: "C", rank: 2 },
  { id: "secret", label: "SECRET", portion: "S", rank: 3 },
];

const BY_ID = new Map(CLASSIFICATION_LEVELS.map((l) => [l.id, l]));

// Caveats a marking may carry. EXERCISE is not optional on this platform.
export const CLASSIFICATION_CAVEATS = [
  { id: "exercise", label: "EXERCISE", locked: true, detail: "Everything in this platform is exercise material. The caveat cannot be removed." },
  { id: "fictional", label: "FICTIONAL DATA", locked: true, detail: "Forces, places and events are invented. The caveat cannot be removed." },
  { id: "noforn", label: "NOFORN", locked: false, detail: "Not releasable to foreign nationals." },
  { id: "orcon", label: "ORCON", locked: false, detail: "Dissemination and extraction controlled by the originator." },
];

const CAVEAT_BY_ID = new Map(CLASSIFICATION_CAVEATS.map((c) => [c.id, c]));
const LOCKED_CAVEATS = CLASSIFICATION_CAVEATS.filter((c) => c.locked).map((c) => c.id);

export function levelFor(id) {
  return BY_ID.get(String(id)) || BY_ID.get("restricted");
}

export function defaultClassification() {
  return {
    level: "restricted",
    caveats: [...LOCKED_CAVEATS],
    releasableTo: "COALITION TASK FORCE",
    updatedAt: null,
    updatedBy: "platform default",
  };
}

/** Normalise a stored or submitted classification, keeping the locked caveats. */
export function normalizeClassification(value) {
  const base = defaultClassification();
  if (!value || typeof value !== "object") return base;
  const level = BY_ID.has(String(value.level)) ? String(value.level) : base.level;
  const requested = Array.isArray(value.caveats) ? value.caveats.map(String).filter((c) => CAVEAT_BY_ID.has(c)) : [];
  const caveats = [...new Set([...LOCKED_CAVEATS, ...requested])];
  const releasableTo =
    typeof value.releasableTo === "string" && value.releasableTo.trim() ? value.releasableTo.trim().slice(0, 60).toUpperCase() : base.releasableTo;
  return {
    level,
    caveats,
    releasableTo,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : base.updatedAt,
    updatedBy: typeof value.updatedBy === "string" ? value.updatedBy : base.updatedBy,
  };
}

/** The single line that goes at the head and foot of a document. */
export function markingLine(classification) {
  const c = normalizeClassification(classification);
  const parts = [levelFor(c.level).label];
  for (const id of c.caveats) {
    const caveat = CAVEAT_BY_ID.get(id);
    if (caveat) parts.push(caveat.label);
  }
  if (c.releasableTo && !c.caveats.includes("noforn")) parts.push(`REL ${c.releasableTo}`);
  return parts.join(" // ");
}

/** The bracketed mark that opens a paragraph, e.g. "(R//EX)". */
export function portionMark(classification) {
  const c = normalizeClassification(classification);
  const bits = [levelFor(c.level).portion];
  if (c.caveats.includes("exercise")) bits.push("EX");
  if (c.caveats.includes("noforn")) bits.push("NF");
  return `(${bits.join("//")})`;
}

/**
 * High water mark: a document built from several sources is marked at the
 * highest of them, and carries the union of their caveats. This is the rule that
 * stops a SECRET annex quietly riding inside a RESTRICTED order.
 */
export function highWater(...classifications) {
  const inputs = classifications.filter(Boolean).map(normalizeClassification);
  if (!inputs.length) return defaultClassification();
  let level = inputs[0].level;
  for (const input of inputs) {
    if (levelFor(input.level).rank > levelFor(level).rank) level = input.level;
  }
  const caveats = [...new Set(inputs.flatMap((i) => i.caveats))];
  // The narrowest release statement wins, and NOFORN removes it entirely.
  const releasable = caveats.includes("noforn") ? "" : inputs.map((i) => i.releasableTo).filter(Boolean).sort((a, b) => a.length - b.length)[0] || "";
  return {
    level,
    caveats,
    releasableTo: releasable,
    updatedAt: null,
    updatedBy: "derived by high water mark",
  };
}

/** Catalogue for the Admin console. */
export function classificationCatalogue() {
  return {
    levels: CLASSIFICATION_LEVELS.map((l) => ({ id: l.id, label: l.label, portion: l.portion, rank: l.rank })),
    caveats: CLASSIFICATION_CAVEATS.map((c) => ({ id: c.id, label: c.label, locked: c.locked, detail: c.detail })),
  };
}
