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
full event assignment roster, but assignment questions must identify exactly
one scout by full name (or clearly ask for the requester's own assignments),
and the response contains only that scout. The assistant can also report the
requester's own Hub roles and permissions. A caller with the same
`VIEW_ADMIN_PANEL` permission used by the Admin page may inspect one named
person's shareable role/profile fields; email addresses, Slack IDs, secrets,
and notification settings are never returned. Names, shifts, and profile data
in these paths are never sent to Gemini. Other questions are answered by Gemini
from the read-only Hub feature catalog, the same route/keyword list the
in-app search box uses (so an answer about any real page, e.g. "what's the
EPA tab", stays in sync with the app automatically instead of drifting from
hand-written prose), and the status snapshot. When the question is not a
Google Search request, Gemini can also call a `query_hub_data` function tool
that runs one read-only, allowlisted Supabase query - a fixed set of tables
(parts, router groups, orders, planner items, match/pit scouting reports,
scouting assignments and rankings, robot ratings, ACE/Pit problem reports,
and builds) and, per table, a fixed set of columns. The tool only accepts
exact-match filters on a table's own listed columns, is capped at 50 rows,
and can be called at most a few times per question. It never runs arbitrary
SQL and its column allowlists exclude email addresses, Slack IDs, auth
identifiers, and any other column that would identify who is assigned to
something - the same restrictions the dedicated assignment/profile handlers
above already enforce. Public
event/current-information questions may use
Gemini's Google Search grounding and include source links; Google Search and
`query_hub_data` are mutually exclusive on a single question so a generated
web-search query can never be built from live Hub data. Ordinary
general-knowledge, math, science, robotics, and programming questions are also
supported; only claims about Hub itself are restricted to live/internal Hub
evidence. The assistant is instructed to never reveal API keys, tokens,
secrets, or setup/install commands, regardless of how the request is phrased.
Mentions using the old `@971app` or
`@971hub` display names continue to work in existing messages because Slack
identifies the app by ID rather than by its visible name.

The assistant responds to direct mentions in every conversation where the bot
is a member. A human can continue the conversation without another mention by
replying inside a thread that began with an app mention. Other ambient messages
and unrelated threads are ignored. Slack membership remains the access
boundary. Replies to a mention in an existing thread remain in that thread;
channel-level mentions start one threaded reply beneath the mention.

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
2. Under **OAuth & Permissions**, add the bot scopes `app_mentions:read` and
   `channels:history`. Add `groups:history` too if the assistant is used in
   private channels. Keep the existing `chat:write` scope used to post replies.
3. Reinstall the app to the workspace if Slack requests it after the scope
   change.
4. Under **Event Subscriptions**, enable events and set the request URL to
   `https://spartanshub.spartanrobotics.org/api/971bot/slack/events`.
5. Subscribe to the bot events `app_mention` and `message.channels`. Subscribe
   to `message.groups` too if private-channel thread follow-ups are required,
   while retaining existing reaction subscriptions.
6. Invite the app to each channel where direct-mention access is wanted.

The endpoint verifies Slack request signatures, ignores bot-authored messages,
and accepts ordinary messages only when their root timestamp matches a durable
assistant mention receipt. This lets thread follow-ups work without allowing
the bot to answer general channel chatter. It
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
