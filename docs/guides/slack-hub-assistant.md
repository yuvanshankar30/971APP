# Slack Hub assistant

`@Spartans Hub` questions are handled by the signed Slack Events endpoint at
`/api/971bot/slack/events`. Fusion Runner install questions are also answered
deterministically, without going through Gemini at all: the reply always
contains the real, public install command
(`sh -c "$(curl -fsSL <origin>/install/fusion-runner)"`) and @-mentions the
two people who hand out the one-time Runner token, resolved server-side by
their known Hub account email (`yuvan262626@gmail.com`, `arin.rao12@gmail.com`)
so the ping is real and never a name the model guessed. The bot itself never
knows or reveals the token value. `@Spartans Hub /status` is deterministic and reports
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
from a compact read-only Hub summary, the same route/keyword list the
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

Questions that name a Hub tab or ask where to find a page are resolved before
Gemini from `src/lib/server/hub_feature_knowledge.js`. The local catalog covers
default navigation, important hidden/direct routes, feature subtabs, common
workflows, and distinctions such as EPA versus OPR versus Scout Power. These
answers include the exact route and are deterministic; the detailed product map
is never included in a Gemini or Google Search request. Update the catalog in
the same change whenever a user-facing route, subtab, or workflow changes.
Subtab names resolve independently (for example, `Accuracy` resolves to EPA);
generic names shared by multiple parents prompt for the parent tab rather than
guessing. Feature and subtab answers include absolute, clickable Hub links;
EPA subtabs and Fusion AutoCAM subtabs have deep links that open the requested
screen. In an existing assistant thread, a related mention such as “what
subtabs does it have?” resolves the most recently discussed known Hub feature
from private, durable assistant event receipts locally. Other follow-ups send
the original exchange and recent thread turns to Gemini, including the bot's
replies, so references like “it” or “his role” retain their subject even if
Slack's thread-history API is unavailable. The bot records each directed
question before answering and records its reply after Slack accepts it.
Threads started before this storage was deployed still use Slack history as a
fallback. If that older history is unavailable, the bot answers from the
current question or asks which person or topic a reference means; it does not
repeat a fixed history-error reply. Google Search requests do not include earlier
thread turns. The bot checks the Admin-managed people and role rosters before
feature routing, and answers role-holder questions directly from those records.
An explicitly supplied full name wins over roster members who share its first
name; first-name-only questions can still ask for clarification.
Named-person purchasing-history questions also stay local. A linked
user may read their own latest request; reading someone else's requires
`VIEW_PURCHASING_ADMIN`, and rejected rows follow the Purchasing page's
requester/rejector visibility. General live-data tools are not offered to an
unlinked or disabled Slack account.

The assistant responds to direct mentions in every conversation where the bot
is a member. Every follow-up must mention `@Spartans Hub`, including replies
in an existing assistant thread. Unmentioned messages are ignored. Slack
membership remains the access boundary. Replies to a mention in an existing
thread remain in that thread; channel-level mentions start one threaded reply
beneath the mention. The event receipt uses the individual message timestamp
for deduplication and stores the thread parent separately for follow-up context.

## Required runtime configuration

- `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` must be available to the server.
- `GEMINI_API_KEY` is a normal server-side process environment variable. For
  local development, place it in the gitignored `.env` file. For a deployed
  runtime, set it in that runtime's private environment-variable settings.
  Never prefix it with `PUBLIC_` or `VITE_`.
- `GEMINI_MODEL` is optional and defaults to `gemini-3.5-flash`.
- No channel allowlist or channel environment variable is required. Add or
  remove the app from a Slack conversation to grant or revoke mention access.

## Required Slack app configuration

In the Slack app configuration at `api.slack.com/apps`:

1. Set the app and bot display name to `Spartans Hub`.
2. Under **OAuth & Permissions**, add the bot scope `app_mentions:read` and
   keep the existing `chat:write` scope used to post replies. The optional
   `channels:history` and `groups:history` scopes let the bot recover context
   from older public- and private-channel threads, respectively. Targeted
   thread replies do not require these history scopes.
3. Reinstall the app to the workspace if Slack requests it after the scope
   change.
4. Under **Event Subscriptions**, enable events and set the request URL to
   `https://spartanshub.spartanrobotics.org/api/971bot/slack/events`.
5. Subscribe to the bot event `app_mention`, while retaining existing reaction
   subscriptions. `message.channels` and `message.groups` are not needed for
   targeted assistant replies.
6. Invite the app to each channel where direct-mention access is wanted.

Gemini 3.5 Flash tool replies include the matching function-call ID so the
model can continue after a Hub data lookup. The answer review uses a smaller
thinking budget; if only that review fails, the completed answer is still
posted. Request-format errors and empty model replies have distinct safe
messages to make failures diagnosable without exposing provider details.
Temporary Gemini HTTP 5xx/408 and connection failures are retried up to three
times before the bot reports the safe failure category. The thread-context
window has no special failure at eight messages.

The endpoint verifies Slack request signatures, ignores bot-authored messages,
and handles only direct app mentions. Mentioned Hub feature follow-ups use
saved receipt context, with `conversations.replies` as a fallback for older
threads when the relevant history scope is available. New thread memory does
not depend on a history scope. The endpoint deduplicates Slack retries through
the service-role-only `slack_event_receipts` table, and replies in the mention thread. Failed
deliveries are marked retryable; completed or in-progress event IDs cannot
double-post from another server instance. Gemini has a 60-second request
timeout; if Slack retries while a reply is still processing, the durable
receipt acknowledges the duplicate without posting again. Credential, model,
quota, and timeout failures produce distinct safe replies without including a
secret or raw provider response. The model has no mutation tools and cannot
change Hub data. Google Search is disabled for assignment questions so internal
scouting data cannot become part of a generated web-search query.
