"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/ui";
import { rotateWebhookTokenAction, type WebhookTokenState } from "@/lib/actions/deliverability";

const EMPTY: WebhookTokenState = { token: null, webhookUrl: "", endpoint: "" };

/** Create or replace the webhook token. The new token appears here once and is gone after a reload. */
export function WebhookTokenForm({ hasToken }: { hasToken: boolean }) {
  const [state, action] = useActionState(rotateWebhookTokenAction, EMPTY);
  return (
    <div className="stack">
      <form action={action}>
        <SubmitButton className={hasToken ? "btn btn-ghost" : "btn"}>{hasToken ? "Make a new token" : "Create webhook token"}</SubmitButton>
      </form>
      {state.token ? (
        <div className="banner good stack" role="status">
          <strong>Copy your token now. It will not be shown again.</strong>
          <label className="field">
            <span>Token</span>
            <input readOnly value={state.token} aria-label="Webhook token" onFocus={(event) => event.currentTarget.select()} />
          </label>
          <label className="field">
            <span>Endpoint (send the token as a Bearer header)</span>
            <input readOnly value={state.endpoint} aria-label="Webhook endpoint" onFocus={(event) => event.currentTarget.select()} />
          </label>
          <label className="field">
            <span>URL with the token in it (for Amazon SNS and other senders that cannot set headers; less safe)</span>
            <input readOnly value={state.webhookUrl} aria-label="Webhook URL with token" onFocus={(event) => event.currentTarget.select()} />
          </label>
          <p className="fine">Any earlier token no longer works. Postroom keeps only a hash, so a lost token cannot be recovered: make a new one.</p>
        </div>
      ) : null}
    </div>
  );
}
