# Slack Hub assistant

`@971app` questions are handled by the signed Slack Events endpoint at
`/api/971bot/slack/events`. `@971app status` is deterministic and reports
Supabase reachability, the active scouting event, open assignments, open
ACE/Pit issues, stored match-report count, and curated recent changes. Other
questions are answered by Groq from a bounded, read-only Hub context.

## Required runtime configuration

- `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` remain in Secret Manager.
- `GROQ_API_KEY` must be a server-only environment secret. Never prefix it
  with `PUBLIC_` or `VITE_`.
- `GROQ_MODEL` is optional and defaults to `openai/gpt-oss-20b`.

For the primary Cloud Run deployment, create a `GROQ_API_KEY` Secret Manager
secret, grant the runtime service account Secret Accessor, and add
`GROQ_API_KEY=GROQ_API_KEY:latest` to the deploy step's `--set-secrets` list.

## Required Slack app configuration

In the 971app configuration at `api.slack.com/apps`:

1. Under **OAuth & Permissions**, add the bot scope `app_mentions:read`.
   Keep the existing `chat:write` scope used to post replies.
2. Reinstall the app to the workspace if Slack requests it after the scope
   change.
3. Under **Event Subscriptions**, enable events and set the request URL to
   `https://spartanshub.spartanrobotics.org/api/971bot/slack/events`.
4. Subscribe to the bot event `app_mention` while retaining existing reaction
   subscriptions.

The endpoint verifies Slack request signatures, ignores bot-authored mentions,
deduplicates Slack retries through the service-role-only
`slack_event_receipts` table, and replies in the mention thread. Failed
deliveries are marked retryable; completed or in-progress event IDs cannot
double-post from another Cloud Run instance. Groq has a short request timeout
so the complete event callback normally stays within Slack's acknowledgement
window. The model has no mutation tools and cannot change Hub data.
