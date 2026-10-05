import type { Metadata } from "next";
import { ConfirmSubmit, Flash, PageHeader, Pill, SubmitButton } from "@/components/ui";
import { deleteAccountAction } from "@/lib/actions/auth";
import { checkSenderAction, clearWebhookTokenAction } from "@/lib/actions/deliverability";
import { saveSettingsAction, testSmtpAction } from "@/lib/actions/settings";
import { getDeliverabilitySettings } from "@/lib/deliverability";
import { checkSender } from "@/lib/dns-check";
import { requireUser } from "@/lib/session";
import { WebhookTokenForm } from "@/components/webhook-token";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; check?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const deliverability = await getDeliverabilitySettings(user.id);
  const dkimSelector = deliverability.dkimSelector;
  const senderAddress = user.fromEmail || user.email;
  const sender = params.check ? await checkSender(senderAddress, dkimSelector) : null;
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <PageHeader
        title="Settings"
        lede="The postal address is printed on every campaign. SMTP is how the mail actually leaves."
      />
      <Flash error={params.error} notice={params.notice} />
      <form action={saveSettingsAction} className="stack">
        <label className="field">
          <span>Your name</span>
          <input name="name" defaultValue={user.name} required />
        </label>
        <label className="field">
          <span>Company name</span>
          <input name="companyName" defaultValue={user.companyName} />
        </label>
        <label className="field">
          <span>Postal address</span>
          <textarea name="postalAddress" defaultValue={user.postalAddress} style={{ minHeight: 110 }} placeholder={"1 Market Street\nAustin, TX 78701"} />
        </label>
        <div className="two">
          <label className="field">
            <span>Default from name</span>
            <input name="fromName" defaultValue={user.fromName} />
          </label>
          <label className="field">
            <span>Default from email</span>
            <input name="fromEmail" type="email" defaultValue={user.fromEmail} />
          </label>
        </div>
        <label className="field">
          <span>Reply-to</span>
          <input name="replyTo" type="email" defaultValue={user.replyTo} placeholder="Optional" />
        </label>
        <h2>SMTP</h2>
        <p className="fine">
          Port 587 usually leaves Secure unchecked, because the server upgrades with STARTTLS. Port 465 usually needs Secure
          checked. Leave the host empty to keep capture mode.
        </p>
        <div className="two">
          <label className="field">
            <span>Host</span>
            <input name="smtpHost" defaultValue={user.smtpHost} placeholder="email-smtp.us-east-1.amazonaws.com" />
          </label>
          <label className="field">
            <span>Port</span>
            <input name="smtpPort" type="number" defaultValue={user.smtpPort} min={1} max={65535} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" name="smtpSecure" value="1" defaultChecked={user.smtpSecure} />
          Secure (implicit TLS)
        </label>
        <label className="field">
          <span>Username</span>
          <input name="smtpUser" defaultValue={user.smtpUser} autoComplete="off" />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            name="smtpPass"
            type="password"
            autoComplete="new-password"
            placeholder={user.hasSmtpPassword ? "Saved. Leave blank to keep it." : "SMTP password"}
          />
        </label>
        <div className="action-row">
          <SubmitButton>Save settings</SubmitButton>
          <SubmitButton className="btn btn-ghost" pendingLabel="Testing…" formAction={testSmtpAction}>
            Test connection
          </SubmitButton>
        </div>
      </form>
      <section id="sender" className="panel stack">
        <h2>Sender verification</h2>
        <p className="fine">
          Mailbox providers trust mail more when the domain of your from address (<strong>{senderAddress}</strong>) publishes SPF,
          DKIM, and DMARC records. This looks them up in DNS. Missing records do not stop you sending, but mail is more likely to
          land in spam.
        </p>
        <form action={checkSenderAction} className="inline-form">
          <label className="field" style={{ maxWidth: 260 }}>
            <span>DKIM selector</span>
            <input name="selector" defaultValue={dkimSelector} placeholder="default" />
          </label>
          <SubmitButton className="btn btn-ghost" pendingLabel="Checking…">
            Check DNS
          </SubmitButton>
        </form>
        {params.check && !sender ? <p className="banner bad">Add a valid from email above, save, and check again.</p> : null}
        {sender
          ? (
              [
                ["SPF", sender.spf],
                ["DKIM", sender.dkim],
                ["DMARC", sender.dmarc],
              ] as const
            ).map(([label, result]) => (
              <div key={label} className="stack" style={{ gap: 4 }}>
                <p>
                  <strong>{label}</strong> <Pill status={result.status} />
                </p>
                <p className="fine">{result.message}</p>
                {result.record ? (
                  <p className="fine" style={{ wordBreak: "break-all", fontFamily: "ui-monospace, monospace" }}>
                    {result.record}
                  </p>
                ) : null}
              </div>
            ))
          : null}
        {sender ? (
          <p className="fine">
            DNS changes can take a while to spread. Checked {sender.domain} with selector &quot;{sender.selector}&quot;.
          </p>
        ) : null}
      </section>
      <section id="bounces" className="panel stack">
        <h2>Bounces and complaints</h2>
        <p className="fine">
          Hard bounces seen while sending are suppressed automatically. To also catch bounces and spam complaints that arrive
          later, point your provider at the webhook. Anyone with the token can add to your suppression list, so keep it
          private. Postroom stores only a hash of it, which is why a token is shown once, when you make it.
        </p>
        {deliverability.hasWebhookToken ? (
          <p className="fine">
            Webhook is on. Active token ends in <code>{deliverability.webhookTokenHint ?? "????"}</code>
            {deliverability.webhookTokenLastUsedAt ? `, last used ${deliverability.webhookTokenLastUsedAt.slice(0, 16).replace("T", " ")} UTC` : ", not used yet"}.
            Endpoint: <code>POST /api/webhooks/deliverability</code> with <code>Authorization: Bearer &lt;token&gt;</code>.
          </p>
        ) : null}
        <WebhookTokenForm hasToken={deliverability.hasWebhookToken} />
        <p className="fine">
          Amazon SES: create an SNS topic for bounce and complaint notifications and add an HTTPS subscription to the URL
          with the token in it (SNS cannot send headers). Postroom checks the SNS signature on every message and confirms
          the subscription for you. Other providers can POST JSON such as{" "}
          <code>{`{"type":"bounce","email":"a@example.com"}`}</code> (types: bounce, complaint, delivery; add{" "}
          <code>{`"permanent":false`}</code> for a soft bounce). Prefer the Bearer header where you can: a token in the URL
          can end up in server logs and proxies.
        </p>
        {deliverability.hasWebhookToken ? (
          <form action={clearWebhookTokenAction}>
            <ConfirmSubmit label="Turn off" message="Turn the webhook off? Bounce reports will stop being accepted." />
          </form>
        ) : null}
      </section>
      <form action={deleteAccountAction} className="danger-zone">
        <h2>Delete account</h2>
        <p className="fine">This removes your lists, contacts, templates, and campaigns from this Postroom database.</p>
        <ConfirmSubmit label="Delete account" message="Delete your Postroom account and all of its data?" className="btn btn-danger" />
      </form>
    </div>
  );
}
