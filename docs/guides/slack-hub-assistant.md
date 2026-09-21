# Slack Hub assistant

`@971hub` questions are handled by the signed Slack Events endpoint at
`/api/971bot/slack/events`. `@971hub /status` is deterministic and reports
database reachability, the active scouting event, open assignments, open
ACE/Pit issues, stored match-report count, and curated recent changes. Team
report-completion questions are answered directly from live assignment and
report rows. Other questions are answered by Groq from the read-only Hub
feature catalog and status snapshot.

## Required runtime configuration

- `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` must be available to the server.
- `GROQ_API_KEY` is a normal server-side process environment variable. For
  local development, place it in the gitignored `.env` file. For a deployed
  runtime, set it in that runtime's private environment-variable settings.
  Never prefix it with `PUBLIC_` or `VITE_`.
- `GROQ_MODEL` is optional and defaults to `openai/gpt-oss-20b`.

## Required Slack app configuration

In the Slack app configuration at `api.slack.com/apps`:

1. Set the app and bot display name to `971hub`.
2. Under **OAuth & Permissions**, add the bot scope `app_mentions:read`.
   Keep the existing `chat:write` scope used to post replies.
3. Reinstall the app to the workspace if Slack requests it after the scope
   change.
4. Under **Event Subscriptions**, enable events and set the request URL to
   `https://spartanshub.spartanrobotics.org/api/971bot/slack/events`.
5. Subscribe to the bot event `app_mention` while retaining existing reaction
   subscriptions.

The endpoint verifies Slack request signatures, ignores bot-authored mentions,
deduplicates Slack retries through the service-role-only
`slack_event_receipts` table, and replies in the mention thread. Failed
deliveries are marked retryable; completed or in-progress event IDs cannot
double-post from another server instance. Groq has a short request timeout
so the complete event callback normally stays within Slack's acknowledgement
window. The model has no mutation tools and cannot change Hub data.
