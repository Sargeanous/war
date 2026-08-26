// Static frontend vocabulary: colors, labels, icon hints. Domain data lives on
// the backend (server/data.mjs); this file only holds presentation constants.

import type { Domain, DriveMode, SideId, Tone } from "./types";

export const sideColors: Record<SideId, string> = {
  blue: "#1f5f99",
  red: "#b42318",
  neutral: "#667570",
};

export const sideLabels: Record<SideId, string> = {
  blue: "BLUE - Coalition Task Force",
  red: "RED - Opposing Force",
  neutral: "Neutral",
};

export const domainLabels: Record<Domain, string> = {
  land: "Land",
  sea: "Maritime",
  air: "Air",
  cyber: "Cyber",
  space: "Space",
};

export const domainGlyphs: Record<Domain, string> = {
  land: "L",
  sea: "M",
  air: "A",
  cyber: "C",
  space: "S",
};

export const driveModeLabels: Record<DriveMode, string> = {
  "knowledge-reasoning": "Knowledge reasoning",
  "data-learning": "Data learning",
  "operations-research": "Operations research",
  "large-model": "Large model",
  hybrid: "Hybrid-driven",
};

export const driveModeHints: Record<DriveMode, string> = {
  "knowledge-reasoning": "Rules | behavior trees",
  "data-learning": "Deep / reinforcement",
  "operations-research": "Models | optimization",
  "large-model": "Pre-trained reasoning",
  hybrid: "Composed mission agent",
};

export const eventTones: Record<string, Tone> = {
  detection: "info",
  engagement: "warn",
  damage: "warn",
  destroyed: "danger",
  move: "neutral",
  phase: "info",
  decision: "warn",
  intervention: "info",
  logistics: "neutral",
  cyber: "warn",
  info: "neutral",
  victory: "good",
};

export function statusTone(status: string): Tone {
  switch (status) {
    case "active":
    case "ready":
    case "online":
    case "completed":
    case "complete":
    case "healthy":
    case "success":
    case "decisive-success":
    case "achieved":
      return "good";
    case "running":
    case "executing":
    case "selected":
    case "simulated":
    case "syncing":
      return "info";
    case "awaiting-decision":
    case "paused":
    case "damaged":
    case "training":
    case "draft":
    case "marginal":
    case "degraded":
    case "elevated":
      return "warn";
    case "destroyed":
    case "failed":
    case "failure":
    case "aborted":
    case "offline":
    case "rejected":
    case "suspended":
    case "severe":
      return "danger";
    default:
      return "neutral";
  }
}
