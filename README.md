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

The send worker (`npm run worker`, started by `npm run dev`) moves automations forward as well as sending queued mail, so it must be running. A step is claimed in a single database transaction, so running two workers at once does not send anything twice.

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
