import type { ReactNode } from "react";

// Shell contract shared by App.tsx and every page in src/pages/.

export type PageId =
  | "dashboard"
  | "intel"
  | "scenario"
  | "coa"
  | "orders"
  | "rules"
  | "deduction"
  | "assessment"
  | "ailayer"
  | "foundation"
  | "admin";

export type WorkspaceMode = "standard" | "focus";

export interface Profile {
  id: "commander" | "planner" | "operator" | "analyst" | "admin";
  name: string;
  role: string;
  organization: string;
  pages: PageId[];
}

export interface PageProps {
  notify: (message: string) => void;
  goTo: (page: PageId) => void;
  profile: Profile;
  classificationMarking: string;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
  workspaceNavigation?: ReactNode;
}
