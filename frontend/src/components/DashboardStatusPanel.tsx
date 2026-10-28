import Link from "next/link";
import type { DashboardStatus } from "@/lib/dashboard-status";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Lead of the dashboard: answers "is anything wrong or running right now". */
export function StatusPanel({ status, deployCount }: { status: DashboardStatus; deployCount: number }) {
  const { level, issues, running, serversOnline, serversTotal } = status;

  let title: string;
  let sub: string | null = null;
  let dot: string | null;
  if (level === "attention") {
    title = issues.length === 1 ? "1 item needs attention" : `${issues.length} items need attention`;
    dot = issues.some((i) => i.tone === "offline" || i.tone === "failed") ? "failed" : "no-relay";
  } else if (level === "running") {
    title = `${plural(running.length, "deploy", "deploys")} running`;
    dot = "running";
  } else if (level === "ok") {
    title = "All systems operational";
    sub =
      `${serversOnline} of ${plural(serversTotal, "server", "servers")} online. ` +
      (deployCount === 0 ? "No deploys yet." : "The latest deploy of each app succeeded.");
    dot = "online";
  } else {
    title = "Nothing to monitor yet";
    sub = "Add a server to see its status here.";
    dot = null;
  }

  return (
    <section className="card status-panel" aria-labelledby="dashboard-status-title" data-level={level}>
      <div className="status-panel-head">
        {dot && <span className={`status-dot status-dot-${dot}`} aria-hidden="true" />}
        <h2 id="dashboard-status-title" className="status-panel-title">{title}</h2>
      </div>
      {sub && <p className="status-panel-sub">{sub}</p>}
      {issues.length > 0 && (
        <ul className="status-list">
          {issues.map((i) => (
            <li key={i.key}>
              <Link href={i.href} className="status-row">
                <span className={`status-dot status-dot-${i.tone}`} aria-hidden="true" />
                <span className="status-row-subject">{i.subject}</span>{" "}
                <span>{i.detail}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {running.length > 0 && (
        <>
          {level === "attention" && <div className="status-list-label">Running now</div>}
          <ul className="status-list">
            {running.map((r) => (
              <li key={r.key}>
                <Link href="/deploys" className="status-row">
                  <span className="status-dot status-dot-running" aria-hidden="true" />
                  <span className="status-row-subject">{r.subject}</span>{" "}
                  <span>deploying</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
