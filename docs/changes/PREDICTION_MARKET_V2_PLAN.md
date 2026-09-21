# Prediction Market v2 — plan

Living document for this feature. Unlike the other files in `docs/changes/`
(point-in-time summaries written after the fact), this one is meant to be
kept up to date **during** the build — update it as decisions change,
rather than treating it as a frozen spec. Tracked in PR #TBD.

## Why

The current prediction market (`src/routes/predictions/+page.svelte`,
`src/lib/predictionMarket.js`, `prediction_market_bets` table) is a
pari-mutuel points-betting system: stake points on red/blue, winners split
the losing side's pot, leaderboard by balance. Direct instruction: rebuild
this as a visually distinct, Elo-rated prediction market modeled on
bluebanner.web.app's UI (screenshots provided), skinned in a Pit
Wall–style dark/dense-data theme. Reference sites are **visual inspiration
only** — no data, logic, or API calls are pulled from either.

## Decisions (from the Q&A pass)

| Question | Decision |
|---|---|
| Mechanic | **Elo rating**, not pari-mutuel points. Confidence-weighted: correctly calling a close model/community split earns more Elo than confirming a lopsided favorite; calling it wrong loses proportionally more the more "obvious" it looked. |
| Event scope | ~~Only events 971 or 9584 are actually competing at.~~ **Reversed by direct instruction**: any current FRC event, via an event picker (`GET /api/tba/current-events`) marking whichever event is happening right now as "live" — not scoped to this team, not the single "active scouting event," not season-wide. `assertScopedEvent` now just confirms TBA recognizes the event key. |
| Rollout | **Replaces `/predictions` in place** (no side-by-side v1/v2). |
| Access | Everyone signed in, same as today — no new permission gate. |
| Existing data | **Fresh start.** `prediction_market_bets` is left alone (queryable history, not migrated/converted). Chezy Champs is over; no in-flight bets to carry forward. |
| Model % | Reuses **this app's own EPA model** (`src/lib/epaModel.js`: `computeEventEpa` + `winProbability`). No external dependency on Pit Wall or Bluebanner — those are the visual reference only. |
| Alliance Draft | A **new prediction game**, not a reuse of `/picklist`: users predict which teams alliance captains will pick during real alliance selection. |
| Live picks feed | Real-time — see everyone's picks as they're made (matches the reference screenshots; herd-behavior risk accepted as a tradeoff for the "alive" feel). |
| Livestream panel | ~~Placeholder for the first build.~~ **Done early, by direct instruction**: auto-embeds the selected event's real TBA `webcasts` entry (youtube/twitch) - no manual paste-a-link step. |
| Emoji reactions / live feed | Built as **real, persisted, multi-user** features from the start — not mocked then swapped later. |
| Friends | Real feature, included in v1 (add/follow users, not just a static list). |
| Mobile | **Desktop-first.** The dense multi-panel layout is the priority; mobile gets a basic scrollable fallback, not a dedicated responsive redesign. |
| Subtabs | Exactly five: **Dashboard, Alliance Draft, My Predictions, Matches, Leaderboard.** Nothing added beyond these for v1. |
| Visual direction | **Hybrid**: terminal-dense typography and tables (the Pit Wall feel) as the base, with cinematic touches — motion, glow, gradients — reserved for key moments (a match resolving, an Elo change, a leaderboard shift). |

## Scope boundary: theme is local to this page only

Direct instruction: this does **not** need to follow Spartans Hub's shared
design system (`src/app.css` tokens, light/dark/modern/legacy theme
switching). It gets its own self-contained dark theme, fonts, and
component styling — scoped to `/predictions` and nothing else. No shared
`.card`/`.btn`/`.form-*` classes from `app.css`; this page defines its own.

## Data model (new)

All new tables, RLS-protected, `approved_user()` gating matching the
existing `prediction_market_bets` convention. Old table untouched.

- **`pm_elo_ratings`** — one row per user: `user_id`, `elo` (starting
  value TBD — likely 1000, standard default), `events_participated`,
  `updated_at`. Simple current-state table; history lives in the log
  below rather than being reconstructed from it every read.
- **`pm_elo_history`** — one row per (user, match) resolution: `user_id`,
  `event_key`, `match_key`, `picked_side`, `model_probability` (the EPA
  win-prob at pick time, frozen — later model changes must not silently
  rewrite past Elo deltas), `elo_delta`, `elo_after`, `resolved_at`. This
  is what both "Model probability when you predicted" (frozen) and the
  Elo-over-time chart read from.
- **`pm_match_picks`** — one row per (user, event, match) until the match
  locks: `user_id`, `event_key`, `match_key`, `side`, `picked_at`,
  `locked` (bool — true once the match starts; picks are immutable after
  this, matching the "real-time feed" decision that picks are visible
  live but not because they're still editable). Feeds the live "who
  picked what" feed directly.
- **`pm_alliance_draft_picks`** — the new Alliance Draft game: one row per
  (user, event, prediction): `user_id`, `event_key`, `predicted_captain`,
  `predicted_pick`, `pick_round` (1st/2nd/etc.), `placed_at`,
  `resolved_at`, `correct` (bool, null until real alliance selection
  happens for that event). Resolution logic (matching predictions against
  TBA's real alliance-selection result) is new work — no existing helper
  for this anywhere in the codebase.
- **`pm_friends`** — real friends feature: `user_id`, `friend_id`,
  `status` (`pending`/`accepted`), `created_at`. Standard mutual-request
  shape; surfaces "Friends" in the nav and (later) a filtered view of
  picks/leaderboard scoped to friends.
- **`pm_reactions`** — real, persisted emoji reactions: `user_id`,
  `event_key`, `emoji`, `created_at`. Simple append-only log; the live
  feed reads recent rows, doesn't need per-user uniqueness.

Every new table gets its own migration file following the existing
`prediction_market_bets` migration's structure (RLS enabled by default,
`approved_user()` read gate, service-role bypass for resolution jobs).

## Model integration

No new modeling work. `src/lib/epaModel.js` already exports:

- `computeEventEpa(matches, options)` — per-team EPA for an event, from
  raw TBA match data (same shape as `/api/tba/event-matches` already
  returns elsewhere in this app).
- `winProbability(epaA, epaB, scale)` — the win-probability number
  ("Model %" in the reference UI) between two EPA sums.

The Dashboard/Matches views compute each match's Red/Blue alliance EPA sum
from `computeEventEpa`'s output, then call `winProbability` — no new
`src/lib/` module needed for this piece, just wiring the existing exports
into the new page.

## Elo scoring formula (confidence-weighted)

Standard Elo update, using the frozen `model_probability` (not a 50/50
prior) as the expected-outcome term:

```
actual = 1 if picked_side won else 0
delta = K * (actual - model_probability_for_picked_side)
```

`K` (the scaling constant) needs a concrete starting value — flagged as an
open item below, not decided yet. This naturally gives the "upsetting a
90/10 favorite earns more than confirming it" behavior the Q&A asked for,
with zero bespoke logic beyond standard Elo math.

## Routes / page structure

Single top-level route, own layout, own theme — no shared nav chrome from
`+layout.svelte` (this page opts out the same way `/competition`'s
full-bleed launcher already does for width, but goes further: no shared
header/footer at all, its own self-contained shell matching the
reference's own top bar: event switcher, Dashboard / Alliance Draft / My
Predictions / Matches / Leaderboard, Elo, Friends, Account).

- `/predictions` — Dashboard (Match Watch table, stat strip, live event
  panel placeholder, live picks feed)
- `/predictions/alliance-draft`
- `/predictions/mine` (My Predictions)
- `/predictions/matches` (full match list + the per-match detail view
  seen in the second reference screenshot — probably
  `/predictions/matches/[matchKey]`)
- `/predictions/leaderboard`

Replacing `/predictions` in place means the current page's route file
gets fully rewritten, not added alongside — old pari-mutuel UI goes away
entirely once this ships (data stays, per the migration decision above).

## Visual design

Hybrid direction (terminal-dense + cinematic accents). Concrete typography,
color tokens, motion patterns, and component mockups are **not** decided
in this document — per direct instruction, a design skill gets loaded when
implementation actually starts on the UI, not during planning. This
section is a placeholder for that pass.

## Phased build order (proposed)

1. Migrations: the six new tables above.
2. Elo resolution: the existing market has no background job or webhook —
   `resolveOutstandingBets` in `/api/prediction-market/+server.js` runs
   lazily, per-request, whenever anyone loads an event's market page (it
   re-checks `.is('resolved_at', null)` bets against the match's real
   `winning_alliance` on every load - idempotent, so a repeat is a no-op).
   Same pattern applies here: resolve unresolved `pm_match_picks` rows into
   `pm_elo_history` the same way, on page load, not via a new poller.
3. Dashboard + Matches + per-match detail (the core loop: see match, see
   Model %, pick a side).
4. Leaderboard + My Predictions (read-heavy, no new write paths).
5. Live picks feed + emoji reactions (realtime; likely Supabase Realtime
   subscriptions, matching how live/polling behavior is done elsewhere in
   this app).
6. Friends.
7. Alliance Draft (the one genuinely new game mechanic with its own
   resolution logic against real alliance-selection results — biggest
   unknown, sequenced last on purpose).
8. Livestream panel (placeholder box only, per decision above).

## Interface contract (UI/backend split)

UI (Claude) and backend (Codex) are being built in parallel against this
fixed contract, so neither side blocks on the other. UI builds against
mocked data matching these exact shapes; backend implements exactly this
(or updates this section in the same PR if a field genuinely needs to
change, rather than silently drifting from it).

### Tables

```sql
pm_elo_ratings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  elo numeric NOT NULL DEFAULT 1000,
  events_participated integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
)

pm_elo_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  event_key text NOT NULL,
  match_key text NOT NULL,
  picked_side text NOT NULL CHECK (picked_side IN ('red','blue')),
  model_probability numeric NOT NULL,     -- frozen at pick time, never rewritten
  elo_delta numeric NOT NULL,
  elo_after numeric NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now()
)

pm_match_picks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  event_key text NOT NULL,
  match_key text NOT NULL,
  side text NOT NULL CHECK (side IN ('red','blue')),
  picked_at timestamptz NOT NULL DEFAULT now(),
  locked boolean NOT NULL DEFAULT false,  -- true once the match starts; immutable after
  UNIQUE (user_id, event_key, match_key)
)

pm_alliance_draft_picks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  event_key text NOT NULL,
  predicted_captain text NOT NULL,   -- team key, e.g. "frc971"
  predicted_pick text NOT NULL,      -- team key predicted to be picked
  pick_round integer NOT NULL,       -- 1 = first pick, 2 = second pick, etc.
  placed_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  correct boolean                    -- null until real alliance selection happens
)

pm_friends (
  user_id uuid NOT NULL REFERENCES auth.users(id),
  friend_id uuid NOT NULL REFERENCES auth.users(id),
  status text NOT NULL CHECK (status IN ('pending','accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_id)
)

pm_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  event_key text NOT NULL,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)
```

All RLS-protected, `approved_user()` read gate, matching
`prediction_market_bets`' existing policy shape. `pm_friends`/`pm_reactions`
need a policy that only lets a user see their own `pm_friends` rows (both
directions of the pair) - reactions are public within an event, same as
picks.

### API endpoints (new, under `/api/prediction-market-v2/`)

- `GET /dashboard?event_key=X` → `{ elo, active_predictions, accuracy, scored_predictions, matches: [{ match_key, red_teams, blue_teams, model_probability_red, my_pick, community_red_pct, community_blue_pct, status }] }`
- `POST /picks` body `{ event_key, match_key, side }` → upserts `pm_match_picks` (rejects if `locked`)
- `GET /picks/mine?event_key=X` → my picks for that event
- `GET /matches?event_key=X` → full match list, same match shape as dashboard
- `GET /matches/[matchKey]` → `{ match_key, red_teams, blue_teams, model_probability_red, my_pick, model_probability_at_my_pick, community_breakdown: { red, blue, total }, elo_history_series: [{ t, model_prob, community_prob }] }`
- `GET /leaderboard?event_key=X` (event) or no param (season-wide across 971/9584 events only, per the scope decision above) → `[{ user_id, name, elo, wins, losses }]`
- `GET/POST /alliance-draft?event_key=X` → list/submit `pm_alliance_draft_picks`
- `GET/POST /friends` → list/request friends (`pm_friends`)
- `POST /reactions` body `{ event_key, emoji }` → insert `pm_reactions`; UI subscribes to this and to `pm_match_picks` inserts via Supabase Realtime channels (`pm_reactions:${event_key}`, `pm_picks:${event_key}`) for the live feed, not polling.

### Elo resolution

`actual = 1 if picked_side won else 0; delta = K * (actual - model_probability_for_picked_side)`.
Runs lazily on `GET /dashboard` and `GET /matches` (same pattern as
`resolveOutstandingBets` in the existing `/api/prediction-market` route:
per-request, idempotent, no background job) - resolve any `pm_match_picks`
row for a since-completed match into `pm_elo_history` + update
`pm_elo_ratings`, exactly once. `model_probability` comes from
`src/lib/epaModel.js`'s `computeEventEpa` + `winProbability` over that
event's own matches - no external API call.

## Open items / risks

- **Elo K-factor**: default to `K = 32` (standard chess-Elo starting point)
  unless testing against real data says otherwise - not precious, just
  needs a fixed value so nobody is blocked on picking one.
- **Alliance Draft resolution**: no existing code path reads real alliance
  selection results from TBA anywhere in this app today — this is new
  integration work, not a reuse of something that exists.
- **Realtime infrastructure**: confirm Supabase Realtime is already used
  elsewhere in this codebase (for a pattern to follow) or whether this is
  the first consumer of it.
