import { BotMessageSquare, FileText, LockKeyhole, RotateCcw, ShieldCheck, UserCog, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import "./admin.css";
import { ApiError, appendAudit, fetchAudit, fetchGovernance, fetchUsers, resetDemoData, setGovernanceAutonomy, updateUser } from "../api";
import {
  Button,
  CompactTable,
  Detail,
  DetailGrid,
  EmptyState,
  Field,
  Metric,
  MetricGrid,
  Panel,
  Segmented,
  StatusPill,
  Tag,
  plural,
  timeAgo,
} from "../components";
import { statusTone } from "../data";
import type { PageProps } from "../shell";
import type { AuditLogEntry, GovernancePolicy, HandoffAutonomy, User } from "../types";

const errMsg = (error: unknown) => (error instanceof ApiError ? error.message : "Backend unreachable");

const PAGE_IDS = ["dashboard", "scenario", "coa", "rules", "deduction", "assessment", "ailayer", "foundation", "admin"];
const PAGE_SHORT: Record<string, string> = {
  dashboard: "Ovw",
  scenario: "Scn",
  coa: "COA",
  rules: "Rul",
  deduction: "Ded",
  assessment: "Asm",
  ailayer: "AI",
  foundation: "Fnd",
  admin: "Adm",
};

export default function Admin({ notify, profile }: PageProps) {
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  // What the machine is allowed to do on its own. Editing this changes what the
  // API will execute, not what a badge reports.
  const [governance, setGovernance] = useState<GovernancePolicy | null>(null);
  const [policyBusy, setPolicyBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchUsers(), fetchAudit(), fetchGovernance()])
      .then(([u, a, g]) => {
        if (!alive) return;
        setUsers(u);
        setAudit(a);
        setGovernance(g);
        setLoading(false);
      })
      .catch((error) => {
        if (alive) {
          setLoading(false);
          notify(errMsg(error));
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredAudit = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return audit;
    return audit.filter((entry) =>
      [entry.user, entry.action, entry.target, entry.detail].some((v) => v.toLowerCase().includes(q))
    );
  }, [audit, filter]);

  async function setAutonomy(actionId: string, autonomy: HandoffAutonomy) {
    setPolicyBusy(actionId);
    try {
      const next = await setGovernanceAutonomy(actionId, autonomy, profile.name);
      setGovernance(next);
      const action = next.actions.find((a) => a.id === actionId);
      notify(
        autonomy === "auto"
          ? `"${action?.label ?? actionId}" now runs without a named human`
          : `"${action?.label ?? actionId}" now refuses to run without a named human`
      );
      setAudit(await fetchAudit());
    } catch (error) {
      notify(errMsg(error));
    } finally {
      setPolicyBusy(null);
    }
  }

  async function toggleUser(user: User) {
    const status = user.status === "active" ? "suspended" : "active";
    try {
      const updated = await updateUser(user.id, { status });
      setUsers((list) => list.map((u) => (u.id === updated.id ? updated : u)));
      notify(`${updated.name} ${status === "active" ? "reactivated" : "suspended"}`);
      const entry = await appendAudit({
        user: profile.name,
        action: "user-status",
        target: updated.name,
        detail: `Account ${status} from the administration workspace.`,
      });
      setAudit((list) => [entry, ...list]);
    } catch (error) {
      notify(errMsg(error));
    }
  }

  if (loading) {
    return (
      <div className="page-body">
        <EmptyState icon={ShieldCheck} title="Loading administration data" hint="Fetching users, permissions and audit logs." />
      </div>
    );
  }

  return (
    <div className="page-body">
      <div className="adm-banner">EXERCISE USE ONLY | ALL DATA FICTIONAL | Unified user, permission and log management</div>

      <MetricGrid>
        <Metric label="Users" value={String(users.length)} helper={`${users.filter((u) => u.status === "active").length} active`} tone="info" />
        <Metric label="Roles" value={String(new Set(users.map((u) => u.role)).size)} helper="Distinct duty positions" tone="neutral" />
        <Metric label="Audit entries" value={String(audit.length)} helper="Retained 400 days" tone="neutral" />
        <Metric label="Session policy" value="MFA | 12h" helper="Hardware token + revalidation" tone="good" />
      </MetricGrid>

      <Panel icon={BotMessageSquare} title="Autonomy policy">
        <div className="detail-stack">
          <p className="adm-policy-lead">
            What the platform may do on its own, per action. This is the control, not a description of one: an action set to human
            required refuses to execute unless the request names the person accountable for it, and the hand-off record on every cue
            reads its autonomy from here rather than from whichever call site wrote it.
          </p>
          {governance ? (
            <>
              <CompactTable
                columns={["Action", "What it does", "Autonomy", "Refused", ""]}
                rows={governance.actions.map((action) => [
                  <span key="l" className="adm-policy-name">
                    <strong>{action.label}</strong>
                    <small>{action.group}</small>
                  </span>,
                  <span key="d" className="adm-policy-detail">
                    {action.detail}
                  </span>,
                  <StatusPill
                    key="a"
                    label={action.autonomy === "auto" ? "autonomous" : "human required"}
                    tone={action.autonomy === "auto" ? "info" : "warn"}
                  />,
                  <span key="r" className={`adm-policy-refusals${action.refusals ? " hit" : ""}`}>
                    {action.refusals ? plural(action.refusals, "call") : "none"}
                  </span>,
                  <Segmented
                    key="s"
                    value={action.autonomy}
                    onChange={(v) => {
                      if (policyBusy) return;
                      setAutonomy(action.id, v as HandoffAutonomy);
                    }}
                    items={[
                      { id: "auto", label: "Auto" },
                      { id: "human-required", label: "Human" },
                    ]}
                  />,
                ])}
              />
              <small className="adm-policy-foot">
                Last changed {timeAgo(governance.updatedAt)} by {governance.updatedBy}. Every change is signed and lands in the audit
                log below.
              </small>
            </>
          ) : (
            <EmptyState
              icon={BotMessageSquare}
              title="Policy unavailable"
              hint="The autonomy policy could not be read from the platform. Refresh to try again."
            />
          )}
        </div>
      </Panel>

      <Panel icon={Users} title="Users">
        <CompactTable
          columns={["Name", "Role", "Organization", "Last active", "Status", "Permissions", ""]}
          rows={users.map((user) => [
            user.name,
            user.role,
            user.org,
            timeAgo(user.lastActive),
            <StatusPill key="s" label={user.status} tone={statusTone(user.status)} />,
            <span key="p" className="adm-tags">
              {user.permissions.slice(0, 4).map((p) => (
                <Tag key={p} label={PAGE_SHORT[p] ?? p} />
              ))}
              {user.permissions.length > 4 ? <Tag label={`+${user.permissions.length - 4}`} /> : null}
            </span>,
            <Button key="a" icon={UserCog} variant={user.status === "active" ? "secondary" : "primary"} onClick={() => toggleUser(user)}>
              {user.status === "active" ? "Suspend" : "Activate"}
            </Button>,
          ])}
        />
      </Panel>

      <div className="split-grid equal">
        <Panel icon={LockKeyhole} title="Permission matrix">
          <CompactTable
            columns={["User", ...PAGE_IDS.map((p) => PAGE_SHORT[p])]}
            rows={users.map((user) => [
              user.name,
              ...PAGE_IDS.map((page) => (
                <span key={page} className={`adm-perm-cell${user.permissions.includes(page) ? "" : " off"}`}>
                  {user.permissions.includes(page) ? "✓" : "-"}
                </span>
              )),
            ])}
          />
        </Panel>
        <Panel icon={ShieldCheck} title="System parameters">
          <div className="detail-stack">
            <DetailGrid>
              <Detail label="Classification" value="EXERCISE / FICTIONAL" />
              <Detail label="Data retention" value="Runs 180d | Audit 400d" />
              <Detail label="Engine limit" value="8 concurrent branches" />
              <Detail label="API rate limit" value="600 calls/min/agent" />
              <Detail label="Backups" value="Hourly snapshot | offsite daily" />
              <Detail label="Identity" value="CAC + MFA, 12h session" />
              <Detail label="Log shipping" value="SIEM stream enabled" />
              <Detail label="Model registry" value="12 agents | signed builds" />
            </DetailGrid>
            <div>
              <Button
                icon={RotateCcw}
                variant="danger"
                disabled={resetting}
                onClick={async () => {
                  if (
                    !window.confirm(
                      "Reset demo data? All runs, custom rules, COAs and scenario edits will be wiped; seed data and the historical rehearsal are rebuilt."
                    )
                  )
                    return;
                  setResetting(true);
                  try {
                    const result = await resetDemoData();
                    notify(`Demo data reset, ${result.scenarios} scenarios and ${result.runs} rehearsal run rebuilt`);
                    const [u, a] = await Promise.all([fetchUsers(), fetchAudit()]);
                    setUsers(u);
                    setAudit(a);
                  } catch (error) {
                    notify(errMsg(error));
                  }
                  setResetting(false);
                }}
              >
                {resetting ? "Reseeding & re-running rehearsal…" : "Reset demo data"}
              </Button>
              <p className="adm-reset-note">
                Wipes <code>state.json</code> and reseeds the platform for a clean client demo. Takes a few seconds, the
                historical rehearsal deduction is recomputed live.
              </p>
            </div>
          </div>
        </Panel>
      </div>

      <Panel
        icon={FileText}
        title="Audit log"
        action={
          <Field label="">
            <input className="adm-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by user, action, target…" />
          </Field>
        }
      >
        <CompactTable
          columns={["When", "User", "Action", "Target", "Detail"]}
          rows={filteredAudit.slice(0, 40).map((entry) => [
            timeAgo(entry.at),
            entry.user,
            <Tag key="a" label={entry.action} />,
            entry.target,
            entry.detail,
          ])}
        />
      </Panel>
    </div>
  );
}
