# Slack Hub assistant

`@Spartans Hub` questions are handled by the signed Slack Events endpoint at
`/api/971bot/slack/events`. `@Spartans Hub /status` is deterministic and reports
database reachability, the active scouting event, open assignments, open
ACE/Pit issues, stored match-report count, and curated recent changes. Team
report-completion questions are answered directly from live assignment and
report rows. Questions about scout assignments are also answered directly from
Supabase: users linked by `user_profiles.slack_user_id` can see their own rows;
if that ID is absent, the bot resolves the Slack account email through the
already-approved `users:read.email` scope and matches the Hub profile without
persisting a new identifier. Hub admins and users holding the `Scouting Admin`
roster key can see the
full event assignment roster. Names and shifts in this path are never sent to
Gemini. Other questions are answered by Gemini from the read-only Hub feature
catalog and status snapshot. Public event/current-information questions may use
Gemini's Google Search grounding and include source links. Ordinary
general-knowledge, math, science, robotics, and programming questions are also
supported; only claims about Hub itself are restricted to live/internal Hub
evidence. Mentions using the old `@971app` or
`@971hub` display names continue to work in existing messages because Slack
identifies the app by ID rather than by its visible name.

The assistant responds to direct mentions in every conversation where the bot
is a member. Slack membership is the access boundary: the app does not read
ambient channel messages, and Slack does not deliver ordinary `app_mention`
events from conversations the app has not joined. Replies to a mention in an
existing thread remain in that thread; channel-level mentions start one
threaded reply beneath the mention.

## Required runtime configuration

- `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` must be available to the server.
- `GEMINI_API_KEY` is a normal server-side process environment variable. For
  local development, place it in the gitignored `.env` file. For a deployed
  runtime, set it in that runtime's private environment-variable settings.
  Never prefix it with `PUBLIC_` or `VITE_`.
- `GEMINI_MODEL` is optional and defaults to `gemini-3.5-flash-lite`. Google
  limits Gemini 2.5 model access for new projects, so do not switch the default
  back merely because the older model name is still documented.
- No channel allowlist or channel environment variable is required. Add or
  remove the app from a Slack conversation to grant or revoke mention access.

## Required Slack app configuration

In the Slack app configuration at `api.slack.com/apps`:

1. Set the app and bot display name to `Spartans Hub`.
2. Under **OAuth & Permissions**, add the bot scope `app_mentions:read`.
   Keep the existing `chat:write` scope used to post replies.
3. Reinstall the app to the workspace if Slack requests it after the scope
   change.
4. Under **Event Subscriptions**, enable events and set the request URL to
   `https://spartanshub.spartanrobotics.org/api/971bot/slack/events`.
5. Subscribe to the bot event `app_mention` while retaining existing reaction
   subscriptions.
6. Invite the app to each channel where direct-mention access is wanted.

The endpoint verifies Slack request signatures, ignores bot-authored mentions,
deduplicates Slack retries through the service-role-only
`slack_event_receipts` table, and replies in the mention thread. Failed
deliveries are marked retryable; completed or in-progress event IDs cannot
double-post from another server instance. Gemini has a 15-second request
timeout; if Slack retries while a reply is still processing, the durable
receipt acknowledges the duplicate without posting again. Credential, model,
quota, and timeout failures produce distinct safe replies without including a
secret or raw provider response. The model has no mutation tools and cannot
change Hub data. Google Search is disabled for assignment questions so internal
scouting data cannot become part of a generated web-search query.
