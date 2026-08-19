import {
  BarChart3,
  Bot,
  BrainCircuit,
  ChevronRight,
  Database,
  Globe2,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Map as MapIcon,
  MessageSquare,
  Moon,
  Radar,
  Scale,
  Send,
  ShieldCheck,
  Split,
  Sun,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { askCopilot } from "./api";
import { Toast } from "./components";
import type { PageId, PageProps, Profile } from "./shell";
import CommandDashboard from "./pages/CommandDashboard";
import ScenarioDesign from "./pages/ScenarioDesign";
import CoaGeneration from "./pages/CoaGeneration";
import RuleConfig from "./pages/RuleConfig";
import Deduction from "./pages/Deduction";
import Assessment from "./pages/Assessment";
import AiLayer from "./pages/AiLayer";
import Foundation from "./pages/Foundation";
import Admin from "./pages/Admin";

interface NavItem {
  id: PageId;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  pages: PageId[];
}

const profiles: Profile[] = [
  {
    id: "commander",
    name: "Joint Force Commander",
    role: "Command decision authority",
    organization: "Exercise AZURE HORIZON",
    pages: ["dashboard", "deduction", "assessment", "ailayer"],
  },
  {
    id: "planner",
    name: "Plans Cell (J5)",
    role: "Scenario & COA planner",
    organization: "Exercise AZURE HORIZON",
    pages: ["dashboard", "scenario", "coa", "rules"],
  },
  {
    id: "operator",
    name: "Simulation Control",
    role: "Exercise control / umpire",
    organization: "Wargame Center",
    pages: ["dashboard", "deduction", "rules", "foundation"],
  },
  {
    id: "analyst",
    name: "Analysis Cell (J8)",
    role: "Assessment analyst",
    organization: "Wargame Center",
    pages: ["dashboard", "assessment", "ailayer", "foundation"],
  },
  {
    id: "admin",
    name: "Platform Admin",
    role: "Platform governance",
    organization: "Wargame Center",
    pages: ["dashboard", "scenario", "coa", "rules", "deduction", "assessment", "ailayer", "foundation", "admin"],
  },
];

const navItems: Record<PageId, NavItem> = {
  dashboard: { id: "dashboard", label: "Command Overview", icon: LayoutDashboard },
  scenario: { id: "scenario", label: "Scenario Design", icon: MapIcon },
  coa: { id: "coa", label: "Data & COA Generation", icon: Split },
  rules: { id: "rules", label: "Simulation Rules", icon: Scale },
  deduction: { id: "deduction", label: "Full-Process Deduction", icon: Radar },
  assessment: { id: "assessment", label: "Assessment & Replay", icon: BarChart3 },
  ailayer: { id: "ailayer", label: "AI Command Layer", icon: BrainCircuit },
  foundation: { id: "foundation", label: "Platform Foundation", icon: Database },
  admin: { id: "admin", label: "Administration", icon: ShieldCheck },
};

const navGroups: NavGroup[] = [
  { label: "Command", pages: ["dashboard"] },
  { label: "Planning & Simulation", pages: ["scenario", "coa", "rules", "deduction", "assessment"] },
  { label: "Intelligence", pages: ["ailayer"] },
  { label: "Platform", pages: ["foundation", "admin"] },
];

const pageComponents: Record<PageId, (props: PageProps) => JSX.Element> = {
  dashboard: CommandDashboard,
  scenario: ScenarioDesign,
  coa: CoaGeneration,
  rules: RuleConfig,
  deduction: Deduction,
  assessment: Assessment,
  ailayer: AiLayer,
  foundation: Foundation,
  admin: Admin,
};

type Theme = "light" | "dark";

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button className="icon-button" type="button" onClick={onToggle}>
      {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}

export default function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [page, setPage] = useState<PageId>("dashboard");
  const [toast, setToast] = useState("");
  const [theme, setTheme] = useState<Theme>(() => (window.localStorage.getItem("sandtable-theme") === "light" ? "light" : "dark"));
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("sandtable-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((current) => (current === "dark" ? "light" : "dark")), []);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2800);
  }, []);

  function chooseProfile(next: Profile) {
    setProfile(next);
    setPage(next.pages[0]);
  }

  const goTo = useCallback(
    (next: PageId) => {
      if (!profile?.pages.includes(next)) {
        notify("This workspace is not available for the active profile");
        return;
      }
      setPage(next);
    },
    [profile, notify]
  );

  if (!profile) {
    return <LoginScreen profiles={profiles} onChoose={chooseProfile} theme={theme} onToggleTheme={toggleTheme} />;
  }

  const Page = pageComponents[page];

  return (
    <div className="app">
      <Sidebar profile={profile} page={page} goTo={goTo} onSwitch={() => setProfile(null)} />
      <main className="workspace">
        <Topbar profile={profile} page={page} theme={theme} onToggleTheme={toggleTheme} />
        <Page notify={notify} goTo={goTo} profile={profile} />
      </main>
      <Copilot />
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
      <section className="login-panel">
        <div className="login-brand">
          <div className="brand-mark">O</div>
          <div>
            <p>SANDTABLE · Scenario Simulation &amp; Strategic Planning</p>
            <h1>Access profile</h1>
          </div>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
        <p className="login-intro">
          Choose who is using the platform. Workspaces, permissions and the decision workflow are provisioned from
          this point — scenario simulation runs from mission decomposition to assessment, executed by AI agents and
          decided by commanders.
        </p>
        <div className="profile-grid">
          {profiles.map((item) => (
            <button key={item.id} className="profile-card" type="button" onClick={() => onChoose(item)}>
              <span className="profile-icon">
                <UserRound size={20} />
              </span>
              <span>
                <strong>{item.name}</strong>
                <small>{item.role}</small>
                <em>{item.organization}</em>
              </span>
              <ChevronRight size={18} />
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}

function Sidebar({
  profile,
  page,
  goTo,
  onSwitch,
}: {
  profile: Profile;
  page: PageId;
  goTo: (page: PageId) => void;
  onSwitch: () => void;
}) {
  const allowed = new Set(profile.pages);
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">O</div>
        <div>
          <strong>SANDTABLE</strong>
          <span>Wargame Platform</span>
        </div>
      </div>
      <div className="current-profile">
        <small>Access profile</small>
        <strong>{profile.name}</strong>
        <span>{profile.role}</span>
      </div>
      <nav className="nav-groups" aria-label="Primary">
        {navGroups.map((group) => {
          const items = group.pages.filter((id) => allowed.has(id));
          if (!items.length) return null;
          return (
            <section key={group.label} className="nav-group">
              <p>{group.label}</p>
              {items.map((id) => {
                const item = navItems[id];
                const Icon = item.icon;
                return (
                  <button key={id} className={page === id ? "active" : ""} type="button" onClick={() => goTo(id)}>
                    <Icon size={18} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </section>
          );
        })}
      </nav>
      <button className="switch-profile" type="button" onClick={onSwitch}>
        <LogOut size={17} />
        Switch profile
      </button>
    </aside>
  );
}

function Topbar({
  profile,
  page,
  theme,
  onToggleTheme,
}: {
  profile: Profile;
  page: PageId;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const meta = navItems[page];
  return (
    <header className="topbar">
      <div>
        <p>{profile.organization}</p>
        <h1>{meta.label}</h1>
      </div>
      <div className="topbar-actions">
        <span className="session-pill">
          <LockKeyhole size={15} />
          {profile.role}
        </span>
        <span className="session-pill">
          <Globe2 size={15} />
          Meridian Archipelago (fictional)
        </span>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
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

function Copilot() {
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || busy) return;
    setDraft("");
    setMessages((list) => [...list, { id: nextId.current++, from: "user", text: question }]);
    setBusy(true);
    const result = await askCopilot(question);
    setMessages((list) => [
      ...list,
      {
        id: nextId.current++,
        from: "sage",
        text: result.answer ?? "I could not reach the reasoning service — try again shortly.",
        source: result.source,
      },
    ]);
    setBusy(false);
  }

  if (!open) {
    return (
      <button className="chat-fab" type="button" onClick={() => setOpen(true)}>
        <MessageSquare size={19} />
        SAGE
      </button>
    );
  }

  return (
    <section className="chat-panel">
      <header>
        <div>
          <Bot size={18} />
          <strong>SAGE · Strategy Advisor</strong>
        </div>
        <button type="button" onClick={() => setOpen(false)}>
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
      <form className="chat-input" onSubmit={submit}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask about the situation…"
          aria-label="Ask SAGE"
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          <Send size={16} />
        </button>
      </form>
    </section>
  );
}

export type { PageProps, PageId, Profile } from "./shell";
