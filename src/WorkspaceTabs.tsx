import { useEffect } from "react";
import type { PageId, Profile } from "./shell";

interface WorkspaceItem {
  id: PageId;
  label: string;
}

interface WorkspaceSection {
  id: string;
  label: string;
  pages: ReadonlyArray<WorkspaceItem>;
}

export const WORKSPACE_SECTIONS: ReadonlyArray<WorkspaceSection> = [
  {
    id: "command",
    label: "Command",
    pages: [
      { id: "dashboard", label: "Command Overview" },
      { id: "ailayer", label: "AI Command Layer" },
    ],
  },
  {
    id: "intelligence",
    label: "Intelligence",
    pages: [{ id: "intel", label: "Intelligence Feed" }],
  },
  {
    id: "planning",
    label: "Planning",
    pages: [
      { id: "scenario", label: "Scenario Design" },
      { id: "coa", label: "Data & COA Generation" },
      { id: "orders", label: "Orders & Staff Products" },
    ],
  },
  {
    id: "simulation",
    label: "Simulation",
    pages: [
      { id: "rules", label: "Simulation Rules" },
      { id: "deduction", label: "Full-Process Deduction" },
    ],
  },
  {
    id: "assessment",
    label: "Assessment",
    pages: [{ id: "assessment", label: "Assessment & Replay" }],
  },
  {
    id: "platform",
    label: "Platform",
    pages: [
      { id: "foundation", label: "Platform Foundation" },
      { id: "admin", label: "Administration" },
    ],
  },
];

export const WORKSPACE_ITEMS = WORKSPACE_SECTIONS.flatMap((section) => section.pages);

export const WORKSPACE_LABELS = Object.fromEntries(
  WORKSPACE_ITEMS.map((item) => [item.id, item.label])
) as Record<PageId, string>;

export default function WorkspaceTabs({
  profile,
  page,
  goTo,
}: {
  profile: Profile;
  page: PageId;
  goTo: (page: PageId) => void;
}) {
  const allowed = new Set(profile.pages);
  const visibleSections = WORKSPACE_SECTIONS.map((section) => ({
    ...section,
    pages: section.pages.filter((item) => allowed.has(item.id)),
  })).filter((section) => section.pages.length > 0);
  const activeSection = visibleSections.find((section) => section.pages.some((item) => item.id === page)) ?? visibleSections[0];

  useEffect(() => {
    if (!activeSection) return;
    window.localStorage.setItem(`sandtable:last-workspace:${profile.id}:${activeSection.id}`, page);
  }, [activeSection, page, profile.id]);

  function openSection(section: (typeof visibleSections)[number]) {
    const remembered = window.localStorage.getItem(`sandtable:last-workspace:${profile.id}:${section.id}`) as PageId | null;
    const target = section.pages.find((item) => item.id === remembered) ?? section.pages[0];
    if (target) goTo(target.id);
  }

  return (
    <div className="workspace-navigation">
      <nav className="workspace-tabs" aria-label="Product areas">
        {visibleSections.map((section) => {
          const isActive = section.id === activeSection?.id;
          return (
            <button
              key={section.id}
              type="button"
              className={isActive ? "active" : ""}
              aria-expanded={isActive}
              onClick={() => !isActive && openSection(section)}
            >
              {section.label}
            </button>
          );
        })}
      </nav>
      {activeSection && activeSection.pages.length > 1 ? (
        <nav className="workspace-subtabs" aria-label={`${activeSection.label} workspaces`}>
          {activeSection.pages.map((item) => (
            <button
              key={item.id}
              type="button"
              className={page === item.id ? "active" : ""}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => page !== item.id && goTo(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
