import {
  ChartNoAxesCombined,
  ChevronRight,
  Map,
  MessageSquare,
  Moon,
  Radar,
  Send,
  ServerCog,
  ShieldCheck,
  Sun,
  X,
  type LucideIcon,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { askCopilot, fetchBootstrap, fetchClassification, CLASSIFICATION_CHANGED } from "./api";
import BrandMark from "./BrandMark";
import { Toast } from "./components";
import type { PageId, PageProps, Profile, WorkspaceMode } from "./shell";
import type { Bootstrap } from "./types";
import WorkspaceTabs, { WORKSPACE_LABELS } from "./WorkspaceTabs";
import CommandDashboard from "./pages/CommandDashboard";
import Intel from "./pages/Intel";
import ScenarioDesign from "./pages/ScenarioDesign";
import CoaGeneration from "./pages/CoaGeneration";
import RuleConfig from "./pages/RuleConfig";
import Deduction from "./pages/Deduction";
import Orders from "./pages/Orders";
import Assessment from "./pages/Assessment";
import AiLayer from "./pages/AiLayer";
import Foundation from "./pages/Foundation";
import Admin from "./pages/Admin";

const profiles: Profile[] = [
  {
    id: "commander",
    name: "Joint Force Commander",
    role: "Command decision authority",
    organization: "Exercise AZURE HORIZON",
    pages: ["dashboard", "intel", "deduction", "orders", "assessment", "ailayer"],
  },
  {
    id: "planner",
    name: "Plans Cell (J5)",
    role: "Scenario & COA planner",
    organization: "Exercise AZURE HORIZON",
    pages: ["dashboard", "intel", "scenario", "coa", "orders", "rules"],
  },
  {
    id: "operator",
    name: "Simulation Control",
    role: "Exercise control / umpire",
    organization: "Wargame Center",
    pages: ["dashboard", "deduction", "orders", "rules", "assessment", "foundation"],
  },
  {
    id: "analyst",
    name: "Analysis Cell (J8)",
    role: "Assessment analyst",
    organization: "Wargame Center",
    pages: ["dashboard", "intel", "assessment", "orders", "ailayer", "foundation"],
  },
  {
    id: "admin",
    name: "Platform Admin",
    role: "Users, permissions, engines and data",
    organization: "Wargame Center",
    pages: ["dashboard", "intel", "scenario", "coa", "orders", "rules", "deduction", "assessment", "ailayer", "foundation", "admin"],
  },
];

const PROFILE_META: Record<string, { description: string; scope: string }> = {
  commander: {
    description: "Review the operational picture and decide when command input is required.",
    scope: "Decision points & issued orders",
  },
  planner: {
    description: "Build scenarios, compare COAs and prepare the execution package.",
    scope: "Scenario through rule package",
  },
  operator: {
    description: "Launch runs, control exercise state and apply umpire interventions.",
    scope: "Authorized runs & interventions",
  },
  analyst: {
    description: "Compare outcomes and turn run evidence into after-action findings.",
    scope: "Replay, scoring & AAR",
  },
  admin: {
    description: "Manage access, engines, data health and audit records.",
    scope: "Users, services & audit",
  },
};

const PROFILE_ICONS: Record<string, LucideIcon> = {
  commander: ShieldCheck,
  planner: Map,
  operator: Radar,
  analyst: ChartNoAxesCombined,
  admin: ServerCog,
};

const pageComponents: Record<PageId, (props: PageProps) => JSX.Element> = {
  dashboard: CommandDashboard,
  intel: Intel,
  scenario: ScenarioDesign,
  coa: CoaGeneration,
  orders: Orders,
  rules: RuleConfig,
  deduction: Deduction,
  assessment: Assessment,
  ailayer: AiLayer,
  foundation: Foundation,
  admin: Admin,
};

type Theme = "light" | "dark";

function routeState() {
  const params = new URLSearchParams(window.location.search);
  const profile = profiles.find((item) => item.id === params.get("profile")) ?? null;
  const requested = params.get("workspace") as PageId | null;
  const page = profile && requested && profile.pages.includes(requested) ? requested : profile?.pages[0] ?? "dashboard";
  return { profile, page };
}

function writeRoute(profile: Profile | null, page?: PageId, mode: "push" | "replace" = "push") {
  const url = new URL(window.location.href);
  url.searchParams.delete("profile");
  url.searchParams.delete("workspace");
  if (page !== "deduction" && page !== "assessment") {
    url.searchParams.delete("run");
    url.searchParams.delete("branch");
  }
  if (profile) {
    url.searchParams.set("profile", profile.id);
    url.searchParams.set("workspace", page ?? profile.pages[0]);
  }
  window.history[mode === "push" ? "pushState" : "replaceState"]({}, "", url);
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button className="icon-button theme-toggle" type="button" onClick={onToggle} aria-label={label} title={label}>
      {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}

export default function App() {
  const initialRoute = useMemo(routeState, []);
  const [profile, setProfile] = useState<Profile | null>(initialRoute.profile);
  const [page, setPage] = useState<PageId>(initialRoute.page);
  const [toast, setToast] = useState("");
  const [marking, setMarking] = useState("");
  const [operationalData, setOperationalData] = useState<Bootstrap | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("standard");
  const [theme, setTheme] = useState<Theme>(() => (window.localStorage.getItem("sandtable-theme") === "light" ? "light" : "dark"));
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("sandtable-theme", theme);
  }, [theme]);

  useEffect(() => {
    const onHistory = () => {
      const next = routeState();
      setWorkspaceMode("standard");
      setProfile(next.profile);
      setPage(next.page);
    };
    window.addEventListener("popstate", onHistory);
    return () => window.removeEventListener("popstate", onHistory);
  }, []);

  useEffect(() => {
    const workspaceTitle = profile ? WORKSPACE_LABELS[page] : "Access Profile";
    document.title = `${workspaceTitle} | SANDTABLE`;
  }, [page, profile]);

  useEffect(() => {
    let alive = true;
    fetchClassification()
      .then((result) => alive && setMarking(result.marking))
      .catch(() => undefined);
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<{ marking?: string }>).detail;
      if (alive && next?.marking) setMarking(next.marking);
    };
    window.addEventListener(CLASSIFICATION_CHANGED, onChanged);
    return () => {
      alive = false;
      window.removeEventListener(CLASSIFICATION_CHANGED, onChanged);
    };
  }, [profile]);

  useEffect(() => {
    if (!profile) {
      setOperationalData(null);
      return;
    }
    let alive = true;
    const refreshOperationalData = () => {
      fetchBootstrap()
        .then((boot) => alive && setOperationalData(boot))
        .catch(() => undefined);
    };
    refreshOperationalData();
    const refreshTimer = window.setInterval(refreshOperationalData, page === "deduction" ? 1800 : 5000);
    return () => {
      alive = false;
      window.clearInterval(refreshTimer);
    };
  }, [page, profile]);

  const toggleTheme = useCallback(() => setTheme((current) => (current === "dark" ? "light" : "dark")), []);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2800);
  }, []);

  function chooseProfile(next: Profile) {
    setWorkspaceMode("standard");
    setProfile(next);
    setPage(next.pages[0]);
    writeRoute(next, next.pages[0]);
  }

  const goTo = useCallback(
    (next: PageId) => {
      if (!profile?.pages.includes(next)) {
        notify("This workspace is not available for the active profile");
        return;
      }
      setWorkspaceMode("standard");
      setPage(next);
      writeRoute(profile, next);
    },
    [profile, notify]
  );

  if (!profile) {
    return <LoginScreen profiles={profiles} onChoose={chooseProfile} theme={theme} onToggleTheme={toggleTheme} />;
  }

  const Page = pageComponents[page];
  const isWorkspaceFocus = workspaceMode === "focus";

  const switchProfile = () => {
    setWorkspaceMode("standard");
    setProfile(null);
    setOperationalData(null);
    writeRoute(null);
  };

  const productNavigation = <WorkspaceTabs profile={profile} page={page} goTo={goTo} />;

  return (
    <div className={`app command-shell${isWorkspaceFocus ? " workspace-focus" : ""}`}>
      <main className="workspace">
        {!isWorkspaceFocus ? (
          <>
            <Topbar
              profile={profile}
              page={page}
              theme={theme}
              marking={marking}
              onToggleTheme={toggleTheme}
              onSwitch={switchProfile}
            />
            {productNavigation}
          </>
        ) : null}
        <Page
          notify={notify}
          goTo={goTo}
          profile={profile}
          classificationMarking={marking}
          setWorkspaceMode={setWorkspaceMode}
          workspaceNavigation={productNavigation}
        />
      </main>
      {!isWorkspaceFocus ? <Copilot page={page} boot={operationalData} /> : null}
      {toast ? <Toast>{toast}</Toast> : null}
    </div>
  );
}

function LoginScreen({
  profiles,
  onChoose,
  theme,
  onToggleTheme,
}: {
  profiles: Profile[];
  onChoose: (profile: Profile) => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  return (
    <main className="login-screen">
      <header className="access-masthead">
        <div className="access-masthead-inner">
          <div className="access-brand-lockup">
            <div className="access-brand-mark">
              <BrandMark size={58} />
            </div>
            <span className="access-brand-divider" aria-hidden="true" />
            <div className="access-brand-copy">
              <strong>SANDTABLE</strong>
              <span>Wargame platform</span>
            </div>
          </div>
          <div className="access-masthead-meta">
            <span className="access-context">Wargame Center</span>
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          </div>
        </div>
      </header>

      <section className="login-panel">
        <section className="access-briefing" aria-labelledby="access-heading">
          <h1 id="access-heading">Choose your duty position</h1>
          <p>Select the workspace that matches the role you are representing in this exercise.</p>
        </section>

        <div className="profile-grid">
          {profiles.map((item) => {
            const meta = PROFILE_META[item.id];
            const ProfileIcon = PROFILE_ICONS[item.id] ?? ShieldCheck;
            return (
              <button
                key={item.id}
                className="profile-card"
                data-profile={item.id}
                type="button"
                aria-label={`Open ${item.name} workspace`}
                onClick={() => onChoose(item)}
              >
                <span className="profile-card-mark" aria-hidden="true">
                  <ProfileIcon size={32} strokeWidth={1.7} />
                </span>
                <span className="profile-card-body">
                  <strong>{item.name}</strong>
                  <span className="profile-card-description">{meta.description}</span>
                </span>
                <span className="profile-card-scope">
                  <span>{meta.scope}</span>
                </span>
                <span className="profile-card-footer">
                  <span className="profile-card-cue">
                    Open workspace <ChevronRight size={15} />
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function Topbar({
  profile,
  page,
  theme,
  marking,
  onToggleTheme,
  onSwitch,
}: {
  profile: Profile;
  page: PageId;
  theme: Theme;
  marking: string;
  onToggleTheme: () => void;
  onSwitch: () => void;
}) {
  const shortMarking = marking.split("//")[0]?.trim();
  return (
    <header className="command-topbar">
      <div className="command-brand">
        <div className="command-brand-mark">
          <BrandMark size={30} />
        </div>
        <div className="command-brand-copy">
          <strong>SANDTABLE</strong>
          <span>Wargame platform</span>
        </div>
      </div>
      <div className="command-context">
        <span>{profile.organization}</span>
        <strong>{WORKSPACE_LABELS[page]}</strong>
      </div>
      <div className="command-identity">
        <span>Active role</span>
        <strong>{profile.name}</strong>
      </div>
      <div className="command-actions">
        {shortMarking ? (
          <span className="command-classification" title={marking}>
            {shortMarking}
          </span>
        ) : null}
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <button type="button" onClick={onSwitch}>Switch profile</button>
      </div>
    </header>
  );
}

interface ChatMessage {
  id: number;
  from: "user" | "sage";
  text: string;
  source?: string;
}

function Copilot({ page, boot }: { page: PageId; boot: Bootstrap | null }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 0,
      from: "sage",
      text: "SAGE online. Ask about the running deduction, COA trade-offs, rule effects or assessment results.",
    },
  ]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const params = new URLSearchParams(window.location.search);
  const requestedRunId = page === "deduction" || page === "assessment" ? params.get("run") : null;
  const run = (requestedRunId ? boot?.runs.find((item) => item.id === requestedRunId) : undefined)
    ?? boot?.runs.find((item) => item.status === "awaiting-decision" || item.status === "running" || item.status === "paused");
  const scenario = (run ? boot?.scenarios.find((item) => item.id === run.scenarioId) : undefined)
    ?? boot?.scenarios.find((item) => item.status === "running")
    ?? boot?.scenarios[0];
  const requestedBranchId = page === "deduction" || page === "assessment" ? params.get("branch") : null;
  const ruleSet = boot?.ruleSets.find((item) => item.status === "active");
  const groundingLabel = run
    ? `${run.label} · T+${run.simTimeH.toFixed(1)}h · ${run.status.replace(/-/g, " ")}`
    : scenario
      ? `${scenario.codename} · ${WORKSPACE_LABELS[page]}`
      : WORKSPACE_LABELS[page];
  const groundingContext = [
    `Workspace: ${WORKSPACE_LABELS[page]}`,
    scenario ? `Scenario: ${scenario.name} (${scenario.id}, ${scenario.status})` : null,
    ruleSet ? `Rule set: ${ruleSet.name} (${ruleSet.id}, ${ruleSet.status}, updated ${ruleSet.updatedAt})` : null,
    run ? `Run: ${run.label} (${run.id}, ${run.status}, T+${run.simTimeH.toFixed(1)}h)` : null,
    requestedBranchId ? `Branch: ${requestedBranchId}` : null,
  ].filter(Boolean).join("\n");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || busy) return;
    setDraft("");
    setMessages((list) => [...list, { id: nextId.current++, from: "user", text: question }]);
    setBusy(true);
    const result = await askCopilot(question, groundingContext);
    setMessages((list) => [
      ...list,
      {
        id: nextId.current++,
        from: "sage",
        text: result.answer ?? "I could not reach the reasoning service, try again shortly.",
        source: result.source,
      },
    ]);
    setBusy(false);
  }

  if (!open) {
    return (
      <button className="chat-fab" type="button" onClick={() => setOpen(true)} aria-expanded="false" title={`Open SAGE · ${groundingLabel}`}>
        <MessageSquare size={19} />
        <span>SAGE</span>
      </button>
    );
  }

  return (
    <section className="chat-panel">
      <header>
        <div>
          <strong>SAGE - Strategy Advisor</strong>
          <small>Grounded in {groundingLabel}</small>
        </div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close SAGE" title="Close SAGE">
          <X size={16} />
        </button>
      </header>
      <div className="chat-log">
        {messages.map((message) => (
          <article key={message.id} className={message.from}>
            <p>{message.text}</p>
            {message.source ? <small>{message.source === "offline" ? "offline knowledge" : `reasoning service (${message.source})`}</small> : null}
          </article>
        ))}
        {busy ? (
          <article className="sage">
            <p>Analyzing…</p>
          </article>
        ) : null}
      </div>
      <div className="chat-grounding">
        <span>CONTEXT SNAPSHOT</span>
        <strong>{scenario?.codename ?? "Platform state"}</strong>
        <small>Current workspace, active rules, run state and available evidence · advisory only</small>
      </div>
      <form className="chat-input" onSubmit={submit}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask about the situation…"
          aria-label="Ask SAGE"
        />
        <button type="submit" disabled={busy || !draft.trim()} aria-label="Send to SAGE" title="Send to SAGE">
          <Send size={16} />
        </button>
      </form>
    </section>
  );
}

export type { PageProps, PageId, Profile, WorkspaceMode } from "./shell";
