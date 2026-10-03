import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RefreshWhileSending } from "@/components/refresh";
import { ConfirmSubmit, Flash, Pill, SubmitButton } from "@/components/ui";
import {
  activateAutomationAction,
  addDelayStepAction,
  addEmailStepAction,
  deleteAutomationAction,
  moveStepAction,
  pauseAutomationAction,
  removeStepAction,
  saveRulesAction,
  updateAutomationAction,
} from "@/lib/actions/automations";
import {
  describeDelay,
  enrollmentCounts,
  getAutomation,
  getRules,
  latestDeliveries,
  listSteps,
  recentEnrollments,
  stepStats,
} from "@/lib/automations";
import { getDeliverabilitySettings } from "@/lib/deliverability";
import { senderWarnings } from "@/lib/dns-check";
import { listLists, listTemplates } from "@/lib/queries";
import { timeZoneOptions, WEEKDAYS } from "@/lib/send-window";
import { requireUser } from "@/lib/session";
import { formatWhen, percent } from "@/lib/time";

export const metadata: Metadata = { title: "Automation" };

export default async function AutomationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const automation = await getAutomation(user.id, id);
  if (!automation) notFound();
  const [steps, counts, enrollments, deliveries, lists, templates, rules, stats] = await Promise.all([
    listSteps(user.id, id),
    enrollmentCounts(id),
    recentEnrollments(user.id, id),
    latestDeliveries(user.id, id),
    listLists(user.id),
    listTemplates(user.id),
    getRules(user.id, id),
    stepStats(user.id, id),
  ]);
  const zones = timeZoneOptions();
  if (!zones.includes(rules.timezone)) zones.push(rules.timezone);
  const active = automation.status === "active";
  const warnings = active
    ? []
    : await senderWarnings({
        fromEmail: user.fromEmail || user.email,
        selector: (await getDeliverabilitySettings(user.id)).dkimSelector,
        smtpConfigured: user.smtpConfigured,
      });
  return (
    <div className="stack">
      <RefreshWhileSending active={active} />
      <div className="page-header">
        <div>
          <h1>{automation.name}</h1>
          <p className="muted">
            <Pill status={automation.status} />{" "}
            {automation.listName ? `starts when someone joins ${automation.listName}` : "no trigger list yet"}
          </p>
        </div>
        <div className="action-row">
          <Link className="btn btn-ghost" href={`/app/automations/${automation.id}/report`}>
            Report
          </Link>
          {active ? (
            <form action={pauseAutomationAction}>
              <input type="hidden" name="id" value={automation.id} />
              <SubmitButton className="btn btn-ghost">Pause</SubmitButton>
            </form>
          ) : (
            <form action={activateAutomationAction}>
              <input type="hidden" name="id" value={automation.id} />
              <SubmitButton className="btn btn-seal" pendingLabel="Activating…">
                {automation.status === "paused" ? "Resume" : "Activate"}
              </SubmitButton>
            </form>
          )}
        </div>
      </div>
      <Flash error={query.error} notice={query.notice} />
      {!user.smtpConfigured ? (
        <p className="banner warn">
          Capture mode is on. Automation emails are stored in Postroom and not delivered until SMTP is set in{" "}
          <Link href="/app/settings">Settings</Link>.
        </p>
      ) : null}
      {warnings.length > 0 ? (
        <p className="banner warn">
          Before you activate: {warnings.join("; ")}. This will not stop the automation, but mail may land in spam. See{" "}
          <Link href="/app/settings#sender">sender verification in Settings</Link>.
        </p>
      ) : null}
      {active ? (
        <p className="banner good">
          Running. The send worker enrolls people who join the list and sends each step when it is due. Pause to change the steps.
        </p>
      ) : (
        <p className="fine">
          Only people who join the list after you activate are enrolled. Pausing stops enrolling too, so anyone who joins while
          paused is not added when you resume.
        </p>
      )}

      <section className="stats">
        <div className="stat">
          <b>{counts.total}</b>
          <span>Enrolled</span>
        </div>
        <div className="stat">
          <b>{counts.active}</b>
          <span>In progress</span>
        </div>
        <div className="stat">
          <b>{counts.completed}</b>
          <span>Finished · {counts.stopped} stopped</span>
        </div>
        <div className="stat">
          <b>{counts.emailsSent}</b>
          <span>
            Emails sent · {counts.emailsWaiting} waiting · {counts.emailsFailed} failed
          </span>
        </div>
      </section>

      <section className="panel stack">
        <h2>Trigger</h2>
        <form action={updateAutomationAction} className="stack">
          <input type="hidden" name="id" value={automation.id} />
          <div className="two">
            <label className="field">
              <span>Name</span>
              <input name="name" defaultValue={automation.name} required disabled={active} />
            </label>
            <label className="field">
              <span>Starts when someone joins</span>
              <select name="listId" defaultValue={automation.listId ?? ""} disabled={active}>
                <option value="">Choose a list</option>
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name} ({list.subscribedCount} subscribed)
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="fine">
            Joining means being added to the list by hand or through a CSV import. Unsubscribed people are never enrolled or sent to,
            and anyone who unsubscribes leaves the series at once. Each person is enrolled once.
          </p>
          {active ? null : (
            <div className="action-row">
              <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
            </div>
          )}
        </form>
      </section>

      <section className="panel stack">
        <h2>Rules</h2>
        <form action={saveRulesAction} className="stack">
          <input type="hidden" name="id" value={automation.id} />
          <h3>Stop early</h3>
          <label className="check">
            <input type="checkbox" name="exitOnClick" defaultChecked={rules.exitOnClick} />
            Stop when the person clicks any link in this series
          </label>
          <label className="field">
            <span>Stop when the person joins this list</span>
            <select name="exitListId" defaultValue={rules.exitListId ?? ""}>
              <option value="">Never</option>
              {lists
                .filter((list) => list.id !== automation.listId)
                .map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
            </select>
          </label>
          <p className="fine">
            Joining the list counts only after the person was enrolled. Link scanners in some mail systems can click links
            automatically, which would also stop the series.
          </p>
          <h3>Send window</h3>
          <label className="check">
            <input type="checkbox" name="windowEnabled" defaultChecked={rules.windowEnabled} />
            Only send emails on these days and hours
          </label>
          <div className="tag-row">
            {WEEKDAYS.map((name, index) => (
              <label key={name} className="check">
                <input type="checkbox" name="days" value={index} defaultChecked={rules.windowDays.includes(index)} />
                {name.slice(0, 3)}
              </label>
            ))}
          </div>
          <div className="two">
            <div className="two">
              <label className="field">
                <span>From</span>
                <select name="startHour" defaultValue={rules.windowStartHour}>
                  {Array.from({ length: 24 }, (_, hour) => (
                    <option key={hour} value={hour}>
                      {String(hour).padStart(2, "0")}:00
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Until</span>
                <select name="endHour" defaultValue={rules.windowEndHour}>
                  {Array.from({ length: 24 }, (_, index) => index + 1).map((hour) => (
                    <option key={hour} value={hour}>
                      {String(hour).padStart(2, "0")}:00
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>Timezone</span>
              <select name="timezone" defaultValue={rules.timezone}>
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="fine">
            An email that comes due outside the window waits for the next opening. Waits are not affected, so a series can
            take a little longer than the sum of its waits. Rules can be changed while the automation is running.
          </p>
          <div className="action-row">
            <SubmitButton pendingLabel="Saving…">Save rules</SubmitButton>
          </div>
        </form>
      </section>

      <section className="panel stack">
        <h2>Steps</h2>
        {steps.length === 0 ? (
          <p className="empty">No steps yet. Add an email to begin.</p>
        ) : (
          <ol className="number-list">
            {steps.map((step, index) => (
              <li key={step.id}>
                <span className="num">{index + 1}</span>
                <div className="split" style={{ justifyContent: "space-between", width: "100%" }}>
                  <div>
                    {step.kind === "email" ? (
                      <>
                        <strong>Send email</strong>{" "}
                        {step.templateId ? (
                          <Link href={`/app/templates/${step.templateId}`}>{step.templateName}</Link>
                        ) : (
                          <span className="pill bad">template deleted</span>
                        )}
                        {(() => {
                          const stat = stats.get(step.id);
                          if (!stat) return <div className="fine">Not sent yet</div>;
                          return (
                            <div className="fine">
                              {stat.sent} sent · {stat.uniqueOpens} opened ({percent(stat.uniqueOpens, stat.sent)}) · {stat.uniqueClicks} clicked (
                              {percent(stat.uniqueClicks, stat.sent)})
                              {stat.waiting ? ` · ${stat.waiting} waiting` : ""}
                              {stat.failed ? ` · ${stat.failed} failed` : ""}
                            </div>
                          );
                        })()}
                      </>
                    ) : (
                      <>
                        <strong>Wait</strong> {describeDelay(step.delayMinutes)}
                      </>
                    )}
                  </div>
                  {active ? null : (
                    <div className="row-actions">
                      <form action={moveStepAction}>
                        <input type="hidden" name="id" value={automation.id} />
                        <input type="hidden" name="stepId" value={step.id} />
                        <input type="hidden" name="direction" value="up" />
                        <button className="btn btn-ghost" type="submit" disabled={index === 0} aria-label={`Move step ${index + 1} up`}>
                          Up
                        </button>
                      </form>
                      <form action={moveStepAction}>
                        <input type="hidden" name="id" value={automation.id} />
                        <input type="hidden" name="stepId" value={step.id} />
                        <input type="hidden" name="direction" value="down" />
                        <button
                          className="btn btn-ghost"
                          type="submit"
                          disabled={index === steps.length - 1}
                          aria-label={`Move step ${index + 1} down`}
                        >
                          Down
                        </button>
                      </form>
                      <form action={removeStepAction}>
                        <input type="hidden" name="id" value={automation.id} />
                        <input type="hidden" name="stepId" value={step.id} />
                        <ConfirmSubmit label="Remove" message="Remove this step?" />
                      </form>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
        {active ? null : (
          <div className="two">
            <form action={addEmailStepAction} className="inline-form">
              <input type="hidden" name="id" value={automation.id} />
              <select name="templateId" aria-label="Template" defaultValue="" required>
                <option value="" disabled>
                  Choose a template
                </option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
              <SubmitButton pendingLabel="Adding…">Add email</SubmitButton>
            </form>
            <form action={addDelayStepAction} className="inline-form">
              <input type="hidden" name="id" value={automation.id} />
              <input name="amount" type="number" min={1} max={525600} defaultValue={1} aria-label="Wait amount" required style={{ maxWidth: 90 }} />
              <select name="unit" defaultValue="days" aria-label="Wait unit" style={{ maxWidth: 120 }}>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
              <SubmitButton className="btn btn-ghost" pendingLabel="Adding…">
                Add wait
              </SubmitButton>
            </form>
          </div>
        )}
        <p className="fine">
          Each email uses the template as it is when the step runs, with the usual unsubscribe link, tracking, and your company
          address. Waits count from when the previous step ran.
        </p>
      </section>

      <section className="stack">
        <h2>People</h2>
        {enrollments.length === 0 ? (
          <p className="empty">Nobody enrolled yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Next step</th>
                  <th>Next run</th>
                </tr>
              </thead>
              <tbody>
                {enrollments.map((row) => (
                  <tr key={row.id}>
                    <td>{row.email}</td>
                    <td>
                      <Pill status={row.status} />
                      {row.stopReason ? <div className="fine">{row.stopReason}</div> : null}
                    </td>
                    <td>{row.status === "active" ? `Step ${row.currentStep + 1} of ${steps.length}` : "—"}</td>
                    <td>{row.status === "active" ? formatWhen(row.nextRunAt) : row.completedAt ? `Finished ${formatWhen(row.completedAt)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {deliveries.length > 0 ? (
        <section className="panel stack">
          <h2>Stored messages</h2>
          <p className="fine">Capture mode keeps every letter. SMTP sends are stored too, so you can read what went out.</p>
          <ul>
            {deliveries.map((delivery) => (
              <li key={delivery.id}>
                <Link href={`/app/campaigns/${automation.campaignId}/outbox/${delivery.id}`}>{delivery.email}</Link>
                <span className="fine"> — {delivery.subject}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <form action={deleteAutomationAction} className="danger-zone">
        <input type="hidden" name="id" value={automation.id} />
        <ConfirmSubmit
          label="Delete automation"
          message="Delete this automation, its enrollments, and the tracking for its emails?"
          className="btn btn-danger"
        />
      </form>
    </div>
  );
}
