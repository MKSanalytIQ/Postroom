import { buildChart } from "@/lib/chart";
import { formatRate, type Report } from "@/lib/reports";

function shortDate(date: string): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00.000Z`));
}

const SERIES = [
  { key: "sent", label: "Sent", color: "#231f1a" },
  { key: "opens", label: "Opened", color: "#215c32" },
  { key: "clicks", label: "Clicked", color: "#d23b2a" },
  { key: "bounces", label: "Bounced", color: "#8a5a12" },
] as const;

function DailyChart({ report }: { report: Report }) {
  const chart = buildChart(
    report.days.map((day) => shortDate(day.date)),
    SERIES.map((item) => ({ ...item, values: report.days.map((day) => day[item.key]) })),
  );
  const summary = `Per-day chart of ${SERIES.map((item) => item.label.toLowerCase()).join(", ")} over ${report.days.length} ${report.days.length === 1 ? "day" : "days"}.`;
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={summary} style={{ width: "100%", height: "auto", display: "block" }}>
        <title>{summary}</title>
        {chart.yTicks.map((tick) => (
          <g key={`y${tick.y}`}>
            <line x1={chart.plot.left} x2={chart.plot.right} y1={tick.y} y2={tick.y} stroke="#e0d5c4" strokeWidth={1} />
            <text x={chart.plot.left - 8} y={tick.y + 4} textAnchor="end" fontSize={11} fill="#746b60">
              {tick.label}
            </text>
          </g>
        ))}
        {chart.xTicks.map((tick) => (
          <text key={`x${tick.x}`} x={tick.x} y={chart.plot.bottom + 20} textAnchor="middle" fontSize={11} fill="#746b60">
            {tick.label}
          </text>
        ))}
        {chart.lines.map((line) => (
          <g key={line.key}>
            {line.dots.length > 1 ? <polyline points={line.points} fill="none" stroke={line.color} strokeWidth={2} strokeLinejoin="round" /> : null}
            {line.dots.map((dot) => (
              <circle key={`${line.key}${dot.x}`} cx={dot.x} cy={dot.y} r={line.dots.length > 20 ? 1.5 : 3} fill={line.color}>
                <title>{`${line.label}, ${dot.label}: ${dot.value}`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <figcaption className="tag-row" style={{ marginTop: 6 }}>
        {SERIES.map((item) => (
          <span key={item.key} className="fine" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span aria-hidden style={{ width: 12, height: 3, background: item.color, display: "inline-block", borderRadius: 2 }} />
            {item.label}
          </span>
        ))}
        <span className="fine">Opens and clicks are unique people, counted on the day of their first one. Days are UTC.</span>
      </figcaption>
    </figure>
  );
}

/** The shared body of the campaign and automation report pages. */
export function ReportView({ report, exportBase }: { report: Report; exportBase: string }) {
  const { totals, rates } = report;
  const cards: { value: string; label: string }[] = [
    { value: String(totals.sent), label: "Sent" },
    {
      value: totals.delivered === null ? "—" : String(totals.delivered),
      label: totals.delivered === null ? "Delivered (not reported)" : `Delivered · ${formatRate(rates.delivered ?? 0)}`,
    },
    { value: formatRate(rates.open), label: `${totals.uniqueOpens} opened` },
    { value: formatRate(rates.click), label: `${totals.uniqueClicks} clicked` },
    { value: String(totals.bounces), label: `Bounced · ${formatRate(rates.bounce)}` },
    { value: String(totals.complaints), label: `Complaints · ${formatRate(rates.complaint)}` },
    { value: String(totals.unsubscribes), label: `Unsubscribed · ${formatRate(rates.unsubscribe)}` },
  ];
  return (
    <div className="stack">
      <section className="stats" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        {cards.map((card) => (
          <div key={card.label} className="stat">
            <b>{card.value}</b>
            <span>{card.label}</span>
          </div>
        ))}
      </section>
      <p className="fine">
        {totals.recipients} {totals.recipients === 1 ? "recipient" : "recipients"}
        {totals.failed ? ` · ${totals.failed} failed` : ""}
        {totals.skipped ? ` · ${totals.skipped} skipped` : ""}
        {totals.waiting ? ` · ${totals.waiting} still waiting` : ""}. Open, click, complaint, and unsubscribe rates are shares of sent
        messages; the bounce rate is a share of messages tried. Delivery confirmations only appear if your provider reports them to the
        webhook in Settings.
      </p>
      <section className="panel stack">
        <h2>By day</h2>
        {report.days.length === 0 ? <p className="empty">Nothing has been sent yet.</p> : <DailyChart report={report} />}
      </section>
      <section className="panel stack">
        <h2>Top clicked links</h2>
        {report.links.length === 0 ? (
          <p className="fine">No clicks yet.</p>
        ) : (
          <ul className="number-list">
            {report.links.map((link) => (
              <li key={link.url}>
                <span className="num">{link.clicks}</span>
                <span style={{ wordBreak: "break-all" }}>
                  {link.url}
                  <span className="fine"> · {link.people} {link.people === 1 ? "person" : "people"}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel stack">
        <h2>Export</h2>
        <div className="action-row">
          <a className="btn btn-ghost" href={`${exportBase}?kind=summary`}>
            Summary CSV
          </a>
          <a className="btn btn-ghost" href={`${exportBase}?kind=daily`}>
            By day CSV
          </a>
          <a className="btn btn-ghost" href={`${exportBase}?kind=links`}>
            Links CSV
          </a>
          <a className="btn btn-ghost" href={`${exportBase}?kind=recipients`}>
            Recipients CSV
          </a>
        </div>
      </section>
    </div>
  );
}
