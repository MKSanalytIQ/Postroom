# Postroom

Postroom is a small campaign email app. It keeps your lists, templates, and the record of opens and clicks. Your own SMTP server delivers the mail.

Until SMTP is configured, Postroom runs in capture mode: each letter is stored on the campaign so you can click through tracking and unsubscribe without sending anything.

## What it does

- Accounts, contact lists, and CSV import
- Templates with merge tags
- Campaign drafts, a review step, and a background send worker
- Open tracking, signed click tracking, and one-click unsubscribe
- Company name and postal address on every letter
- Automations: drip campaigns and welcome series that start when someone joins a list
- Suppression list: hard bounces, spam complaints, and manual entries are never mailed again
- A token-protected webhook for bounce and complaint events (Amazon SES through SNS, or a plain JSON format)
- Sender verification: SPF, DKIM, and DMARC checks for your From domain
- Campaign and automation reports with a per-day chart, top links, and CSV export
- SMTP retries with exponential backoff for temporary failures
- Password reset and change-password in Settings
- Consent records, attested CSV import, and optional double opt-in subscribe forms

SMS, a drag-and-drop builder, and a shared sending IP are not part of this version.

## Run it

From PowerShell, if `npm` is blocked by the execution policy, call `npm.cmd` instead.

```bash
npm install
npm run dev
```

Open http://localhost:3010. `npm run dev` starts the site and the send worker together.

Create an account, add your company name and postal address in Settings, import a list, and send a campaign. With no SMTP host, open the stored message from the campaign page.

## Automations

An automation is a trigger plus an ordered list of steps. Open Automations, create one, and pick the list that starts it. Then add steps:

- **Email**: sends one of your templates.
- **Wait**: pauses that person for some minutes, hours or days before the next step.

For example: welcome email, wait 2 days, tips email, wait 5 days, offer email. Activate it when the steps are ready.

How it behaves:

- The trigger is "added to the list", whether by hand, from the Contacts page, or through a CSV import into that list. Only people who join after you activate are enrolled; people already on the list are not.
- Each person is enrolled once per automation, even if they leave and rejoin the list.
- Emails go through the normal send path, so they get click and open tracking, the unsubscribe link and header, and your company name and address. Capture mode works the same as for campaigns: messages are stored and listed on the automation page.
- Unsubscribed people are never enrolled or sent to. Someone who unsubscribes part-way leaves the series straight away.
- The automation page shows how many people are enrolled, in progress, finished or stopped, plus emails sent, waiting and failed.
- Steps can only be changed while the automation is paused or still a draft. Pausing also stops new enrollments, so people who join the list while it is paused are not added when you resume. Resuming only enrolls people who join from then on.
- A template that an automation uses cannot be deleted until the step is removed. An email step uses the template as it is at the moment the step runs.

Rules, set in the Rules panel on the automation page (they can be changed while it runs):

- **Stop when someone clicks a link**: the first click on any link in the series ends that person's series. Some mail systems scan links automatically, and such a scan counts as a click.
- **Stop when someone joins another list**: for example a Customers list. It applies to people who join that list after they were enrolled; people already on it when they joined the trigger list carry on. Emails already queued for a stopped person are skipped.
- **Send window**: pick the days of the week, a start and end hour (the end hour is exclusive, so 09:00 to 17:00 sends up to 16:59), and a timezone (UTC by default). An email that comes due outside the window waits for the next opening. Waits are not shifted. A window cannot run past midnight, so the end hour must be later than the start hour.
- **Per-step stats**: each email step shows how many were sent, opened and clicked (unique people, with the share of sent), plus any still waiting or failed. Opens rely on the tracking pixel, so they undercount where images are blocked.

Rules live in their own table (`automation_settings`), created automatically on first start, so existing databases upgrade without any manual step. An automation with no rules row behaves exactly as before.

The send worker (`npm run worker`, started by `npm run dev`) moves automations forward as well as sending queued mail, so it must be running. A step is claimed in a single database transaction, so running two workers at once does not send anything twice.

## Deliverability

### Suppressions

Open **Suppressions** in the sidebar. Every account has its own list of addresses that must not be mailed, each with a reason: `hard bounce`, `complaint`, or `manual`. You can add addresses by hand (one or many), remove one, search, and download the list as CSV.

- Campaigns and automations never send to a suppressed address. They are left out when a campaign is queued, skipped again at send time if they were suppressed after queueing (the recipient shows "Suppressed"), and automations stop an enrollment for that address.
- CSV import skips suppressed addresses and says how many it skipped. Adding a single contact by hand with a suppressed address is refused too.
- A complaint also unsubscribes the contact. Removing an address from the list does not resubscribe anyone.
- The first reason stays: an address that is already listed keeps its original reason.

### Hard bounces from the send worker

When the SMTP server refuses a recipient permanently during sending, the recipient is marked `bounced`, a bounce event is recorded, and the address is suppressed. This only happens for a clear permanent (5xx) refusal of the recipient: an enhanced status such as 5.1.x (bad mailbox or domain), 5.2.1, or 5.4.1, or a refused `RCPT TO` with code 550, 551, or 553. Temporary (4xx) errors, connection problems, authentication failures, and policy, spam, relay, or "sender not verified" refusals are not treated as bounces; those recipients fail as before and can be retried.

### Bounce and complaint webhook

Most bounces and complaints arrive later, from your sending provider. In **Settings, Bounces and complaints**, create a token. It is shown **once**, right after you create it, so copy it then. Postroom keeps only a SHA-256 hash, so a lost token cannot be recovered: make a new one (the old one stops working at once). Settings shows just the last four characters and when it was last used.

```
POST https://your-host/api/webhooks/deliverability
Authorization: Bearer <token>
```

Send the token in the `Authorization: Bearer` header wherever your sender allows it. `?token=<token>` on the URL also works, for senders that cannot set headers (Amazon SNS is one), but it is **less safe**: URLs are written to access logs, proxies, and monitoring tools, so a token in a URL leaks more easily. Turning the webhook off makes the endpoint answer 401.

Limits: bodies over 512 KB get 413, and each client address (from `X-Real-IP` or `X-Forwarded-For`) may make 300 requests a minute. After 10 failed authentications in a minute that address gets 429 with `Retry-After` until the minute is up, even with a correct token. These limits live in each server process's memory, so with several instances each keeps its own count.

**Amazon SES.** Send SES bounce, complaint, and delivery notifications (or an SES event destination) to an SNS topic, then add an HTTPS subscription to the URL with the token in `?token=`. Postroom verifies the signature of every SNS message (SignatureVersion 1 and 2, using the canonical string to sign from the AWS documentation). The signing certificate must come from an `https://sns.<region>.amazonaws.com/...pem` URL, is fetched with a 5 second timeout, and is cached for an hour. A message with a missing, malformed, or wrong signature is rejected with 403 and nothing in it is applied; one bad message in a batch rejects the whole request. A subscription is only confirmed after its signature checks out, and only `https://sns.<region>.amazonaws.com` confirmation links are followed. Permanent bounces are suppressed; transient (soft) bounces are recorded but not suppressed. Complaints are suppressed and unsubscribe the contact. Delivery events mark mail as delivered in reports.

**Generic JSON.** Post one object, an array, or `{"events": [...]}`:

```json
{ "type": "bounce", "email": "someone@example.com", "permanent": true, "reason": "mailbox full" }
{ "type": "complaint", "email": "someone@example.com" }
{ "type": "delivery", "email": "someone@example.com" }
```

`type` is one of `bounce`, `hard_bounce`, `soft_bounce`, `complaint` (or `spam`), and `delivery` (or `delivered`). A plain `bounce` counts as permanent unless `"permanent": false` is given. The generic format and raw SES notifications (not wrapped in SNS) rely on the token alone, since they carry no signature.

Events are matched to the most recent message sent to that address and counted once per message and type. There is no message-id correlation, so an event for an address you never mailed is still suppressed but does not show in any report.

### Sender verification

In **Settings, Sender verification**, enter your DKIM selector (default `default`; your provider tells you the real one, for example `s1` or `selector1`) and press Check. Postroom looks up DNS for the domain of your From email with Node's resolver:

- **SPF**: a TXT record starting `v=spf1`, and whether it ends in a strict or permissive default.
- **DKIM**: a TXT record at `<selector>._domainkey.<domain>` containing a public key (`p=`).
- **DMARC**: a TXT record at `_dmarc.<domain>`, looking at the policy (`none` is a warning; `quarantine` or `reject` pass). If the domain has none, the organisation's parent domains are tried, but never the top-level domain.

Each shows pass, warn, or missing, with plain-language guidance. The campaign review page and the automation page (before you activate it) show a short warning when something is missing. It never blocks sending or activating. Warnings are skipped in capture mode, and results are cached for five minutes per process. Lookups have a 4 second timeout, and a lookup failure shows as a warning rather than a failure.

### Reports

Open **Full report** on a sent campaign, or **Report** on an automation (it covers every email in the series together; step-by-step numbers remain on the automation page). A report shows:

- sent, delivered (shown as a dash unless your provider reports deliveries to the webhook), opens, clicks, bounces, complaints, and unsubscribes, with rates
- a per-day line chart (sent, opened, clicked, bounced) drawn as inline SVG, with no chart library
- the ten most clicked links, with total clicks and distinct people
- CSV downloads: summary, by day, links, and one row per recipient

Open, click, complaint, and unsubscribe rates are shares of sent messages. The bounce rate is a share of messages tried (sent plus refused at send time). Opens and clicks in the chart are distinct people on the day of their first one, and days are UTC (the most recent 90 are shown).

Limits to know about: bounces that arrive by webhook are counted as bounce events and suppress the address, but the recipient's own status stays `sent`; only refusals during sending set it to `bounced`. Opens are an estimate, because mail apps preload images.

### Storage and security notes

Additive tables (created automatically on first start): `suppressed_addresses`, `deliverability_settings`, `webhook_tokens`, `recipient_attempts`, `password_reset_tokens`, `contact_consent`, `list_settings`, `subscribe_confirmations`, plus indexes. Nothing existing is altered. Nothing existing is altered.

Webhook tokens are 192 random bits and are stored only as a SHA-256 hash, looked up by hash and compared in constant time. If you upgraded from a version that stored the token as plain text (`deliverability_settings.webhook_token`), the first webhook request or Settings visit after the upgrade hashes it into `webhook_tokens` and erases the plaintext. The URL you already gave your provider keeps working. The token is still the only authentication for non-SNS senders, so use HTTPS, prefer the Bearer header, and make a new token if one leaks. Database backups taken before the upgrade still contain the old plaintext token.

## Password reset

From the sign-in page, **Forgot password** asks for an email and always shows the same confirmation (it does not say whether the account exists). If the account is real, Postroom emails a one-hour, single-use link. The token is stored only as a SHA-256 hash. Using it sets the new password and signs out every other session. Rate limits apply per email and per client address.

In **Settings → Change password**, enter the current password and a new one (also signs out other sessions).

Reset and confirmation mail use the **system SMTP** env vars above, not each account's campaign SMTP. Without `SYSTEM_SMTP_HOST`, the message is logged to the console so local development still works.

## Consent and double opt-in

Every contact can carry a consent record: source (`manual`, `import`, `form`, or `api`), timestamps, and optional IP / user-agent.

- Adding a person in the app records source `manual`.
- CSV import requires a checkbox attesting that everyone consented; the import is refused without it, and source `import` is stored.
- Each list has a **public subscribe URL** (`/s/<token>`). Submissions record source `form`. Turn on **double opt-in** on the list to keep new people `pending` until they confirm via email (`confirmed_at`). Pending contacts are not mailed by campaigns or automations.
- The contacts table and CSV export include consent columns.

## SMTP retries

Temporary SMTP problems (4xx replies, timeouts, connection errors) put the recipient back on the queue with exponential backoff (see `POSTROOM_RETRY_BASE_MS`), up to five attempts. Permanent recipient refusals (hard bounces) still suppress immediately. Other permanent errors (for example authentication failure) mark the recipient failed without suppressing.

## SMTP

Save this in Settings. For Amazon SES it usually looks like:

- Host: `email-smtp.us-east-1.amazonaws.com`
- Port: `587`
- Secure: off (STARTTLS)
- Username and password: the SES SMTP credentials
- From email: an identity you have verified in SES

Port 465 normally needs Secure checked.

The from address can differ from the SMTP username. Many providers, including SES, authenticate with an access key and send from a verified identity.

## Environment

Copy `.env.example` to `.env.local` if you want to set these. Local use works without them.

- `DATABASE_URL` — Postgres connection string. Set it in production. Leave it unset locally and Postgres is skipped in favour of a SQLite file at `data/postroom.db` (override the path with `POSTROOM_DB`). Tables are created on first use in both cases.
- `DATABASE_SSL` — optional TLS override for Postgres: `disable`, `require`, `prefer`, `allow` or `verify-full`. By default Postgres uses the `sslmode` in `DATABASE_URL` if there is one. Otherwise TLS is off for `localhost` and required for every other host.
- `APP_ORIGIN` — public URL written into tracking and unsubscribe links. Leave unset locally and Postroom uses the request host.
- `APP_SECRET` — encrypts SMTP passwords and signs click links. If unset, a secret is created in `data/app.secret`. Required on Vercel and any other host without a persistent disk.
- `SEND_DELAY_MS` — pause between messages. Default 250.
- `POSTROOM_RETRY_BASE_MS` — base delay for SMTP retry backoff in milliseconds. Default 60000 (doubles each attempt, capped at 30 minutes, up to 5 attempts).
- `SYSTEM_SMTP_HOST` / `SYSTEM_SMTP_PORT` / `SYSTEM_SMTP_SECURE` / `SYSTEM_SMTP_USER` / `SYSTEM_SMTP_PASS` / `SYSTEM_SMTP_FROM` — app-level SMTP for password-reset and double opt-in confirmation mail. When `SYSTEM_SMTP_HOST` is unset, those messages are written to the server console (useful in development).

## Database

Postroom stores everything in Postgres when `DATABASE_URL` is set. Without it, a local SQLite file is used, which needs Node 22.5 or newer. Serverless hosts such as Vercel have no persistent disk, so the SQLite file is lost there. Use Postgres for any deployed copy.

A hosted Postgres works well:

- **Neon via the Vercel Marketplace**: in the Vercel project, open Storage (or Integrations), add Neon, and connect it to the project. `DATABASE_URL` is added to the environment for you. The pooled connection string (host containing `-pooler`) is recommended.
- **Supabase**: create a project, open Connect, and copy a connection string. On Vercel use the transaction pooler (port 6543). Add it as `DATABASE_URL`.
- Any other Postgres 13+ works too.

To use Postgres locally, point `DATABASE_URL` at it, for example `postgres://postroom:postroom@localhost:5432/postroom`. TLS is off for localhost unless you set `DATABASE_SSL` or `sslmode`.

### Deploying on Vercel

1. Create the database as described above so that `DATABASE_URL` is set for Production (and Preview if you use it).
2. Set `APP_SECRET` to a long random string, and `APP_ORIGIN` to the public URL.
3. Redeploy. The tables are created on the first request.

Vercel does not run the background send worker. Run `npm run worker` on a machine that stays on, with the same `DATABASE_URL` and `APP_SECRET`, so that queued campaigns get sent.

## Tests

```bash
npm test
```

This uses a temporary SQLite file. To run the same tests against Postgres, set `DATABASE_URL`. Each run creates its own account and deletes it at the end:

```bash
DATABASE_URL=postgres://postroom:postroom@localhost:5432/postroom_test npm test
```

## Your responsibility

Postroom refuses to queue a campaign until a company name and postal address are saved, and it adds an unsubscribe link plus a `List-Unsubscribe` header. You still need permission to email the list. Do not import addresses you are not allowed to contact.
