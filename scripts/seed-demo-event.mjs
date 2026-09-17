#!/usr/bin/env node
// Populates one real event with random-but-valid scouting data (pit entries,
// match reports, notes, robot ratings, and a pick list) so pages that read
// scouting data - Strategy, Drive Team, Team View, Robot Ratings - render
// fully flushed out instead of empty, for demoing/reviewing the UI.
//
// Deliberately does NOT touch the database directly. It authenticates as a
// real user and calls the already-deployed app's own scouting APIs
// (/pitscout, /notescout, /api/matchscout, /api/scouting-robot-ratings,
// /api/scouting-picklist), the same endpoints the real scouting UI calls -
// so every row it creates passes the same validation real submissions do,
// and Row Level Security is exercised exactly as it is in production.
//
// It requires a REAL team/match roster to seed against - synthetic team
// numbers would leave TBA-backed views (match schedule, opponent rosters)
// empty regardless of what's seeded here - so this fetches the real roster
// and match schedule for the target event from the deployed app's own TBA
// proxy (/api/tba/event-teams, /api/tba/event-matches) rather than
// inventing one.
//
// Usage:
//   node --env-file=.env scripts/seed-demo-event.mjs [event_key] [--matches=N] [--set-active]
//
// Defaults to event_key "2026arc" (the 2026 Archimedes Division event key,
// per the format already used elsewhere in this codebase's own comments -
// verify this is the correct key for the actual event you want seeded and
// pass a different one as the first argument if not).
//
// Requires in .env (or the environment): PUBLIC_SUPABASE_URL,
// PUBLIC_SUPABASE_ANON_KEY, DEV_TOOLS_EMAIL, DEV_TOOLS_PASSWORD - the same
// persistent admin test account scripts/send-slack-test.mjs uses. That
// account needs whatever scouting-write permissions a normal scout has, and
// (for --set-active) whatever role /api/scouting-config's canManageScouting
// check requires.

import { createClient } from '@supabase/supabase-js';

const APP_ORIGIN = process.env.APP_ORIGIN || 'https://spartanshub.spartanrobotics.org';

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith('--'));
const eventKey = positional[0] || '2026arc';
const matchLimitArg = args.find((arg) => arg.startsWith('--matches='));
const matchLimit = matchLimitArg ? Number(matchLimitArg.split('=')[1]) : 12;
const setActive = args.includes('--set-active');

const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.PUBLIC_SUPABASE_ANON_KEY;
const DEV_EMAIL = process.env.DEV_TOOLS_EMAIL;
const DEV_PASSWORD = process.env.DEV_TOOLS_PASSWORD;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !DEV_EMAIL || !DEV_PASSWORD) {
  console.error('Missing PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY / DEV_TOOLS_EMAIL / DEV_TOOLS_PASSWORD in the environment.');
  console.error('Run with: node --env-file=.env scripts/seed-demo-event.mjs [event_key]');
  process.exit(1);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(list) {
  return list[randInt(0, list.length - 1)];
}
function chance(p) {
  return Math.random() < p;
}

const ROBOT_ARCHETYPES = ['Fuel Cycler', 'Climber', 'Defense', 'Auto Specialist', 'Generalist'];
const START_POSITIONS = ['left', 'center', 'right'];
const AUTO_ZONES = ['left', 'center', 'right', 'none'];
const AUTO_FUEL_SOURCES = ['Neutral Zone', 'Outpost', 'Depot', 'Ground', 'Preload'];
const MATCH_FORM_ROLES = ['Scorer', 'Defense', 'Shuttler'];
const MATCH_RATING_FIELDS = ['Shot accuracy', 'BPS'];
const TELEOP_ROBOT_STATUS = ['active', 'active', 'active', 'active', 'stopped', 'brownout', 'dead'];
const BALL_COUNT_RANGES = Array.from({ length: 20 }, (_, i) => `${i * 25}-${(i + 1) * 25}`);

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log(`Signing in as ${DEV_EMAIL}...`);
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email: DEV_EMAIL, password: DEV_PASSWORD });
  if (authError || !authData?.session) {
    console.error('Sign-in failed:', authError?.message || 'no session returned');
    process.exit(1);
  }
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authData.session.access_token}`
  };

  async function post(path, body) {
    const response = await fetch(`${APP_ORIGIN}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || (payload && payload.success === false)) {
      throw new Error(`${path} -> ${response.status}: ${payload?.error || 'unknown error'}`);
    }
    return payload;
  }

  console.log(`Fetching real roster and match schedule for ${eventKey}...`);
  const [teamsRes, matchesRes] = await Promise.all([
    fetch(`${APP_ORIGIN}/api/tba/event-teams?event_key=${encodeURIComponent(eventKey)}`),
    fetch(`${APP_ORIGIN}/api/tba/event-matches?event_key=${encodeURIComponent(eventKey)}&comp_level=qm`)
  ]);
  const teamsPayload = await teamsRes.json().catch(() => null);
  const matchesPayload = await matchesRes.json().catch(() => null);
  if (!teamsRes.ok || !teamsPayload?.success || !teamsPayload.data?.length) {
    throw new Error(`Could not fetch a real roster for "${eventKey}" - check the event key is correct and TBA_API_KEY is configured on the deployed app. (${teamsPayload?.error || teamsRes.status})`);
  }
  const teams = teamsPayload.data;
  const matches = (matchesPayload?.success ? matchesPayload.data || [] : []).slice(0, matchLimit);
  console.log(`Roster: ${teams.length} teams. Seeding match reports for the first ${matches.length} qual matches.`);

  if (setActive) {
    console.log('Setting this as the active scouting event...');
    await post('/api/scouting-config', { event_key: eventKey });
  }

  console.log('Seeding pit entries, notes, and robot ratings per team...');
  for (const team of teams) {
    const teamKey = team.key;
    try {
      await post('/pitscout', {
        action: 'save-entry',
        event_key: eventKey,
        team_key: teamKey,
        drivebase_type: pick(['Swerve', 'Tank', 'Mecanum']),
        shooter_type: pick(['Flywheel', 'Catapult', 'None']),
        hopper_type: pick(['Hopper', 'Funnel', 'None']),
        human_player_balls_in_auto: pick(['0', '1', '2', '3+']),
        scout_name: 'Demo Seed',
        robot_archetype: pick(ROBOT_ARCHETYPES),
        additional_notes: 'Randomly seeded demo pit profile.',
        likely_breaking_component: pick(['Intake belt', 'Climber latch', 'Wiring', 'Nothing observed']),
        estimated_bps: randInt(5, 40),
        climb_options: chance(0.5) ? ['L2'] : ['No Climb'],
        photo_paths: [],
        auto_options: [{ name: 'Center auto', description: 'Randomly generated demo auto description.' }],
        technical_details: { overall_reliability_rating: randInt(5, 10) }
      });

      await post('/notescout', {
        action: 'save-note',
        match_key: null,
        match_number: null,
        team_key: teamKey,
        notes: pick([
          'Solid, consistent cycles all match.',
          'Struggled with intake jams a couple times.',
          'Strong defense when paired against us.',
          'Fast auto, reliable start.',
          'Watch for the occasional stall under pressure.'
        ]),
        ranking_impact: pick(['positive', 'neutral', 'negative'])
      });

      await post('/api/scouting-robot-ratings', {
        action: 'rate',
        event_key: eventKey,
        team_key: teamKey,
        team_number: team.team_number,
        overall_rating: randInt(4, 10),
        offense_rating: randInt(3, 10),
        shuttling_rating: randInt(3, 10),
        driving_rating: randInt(3, 10),
        defense_rating: chance(0.7) ? randInt(2, 9) : null,
        notes: 'Seeded demo impression.',
        strategy_notes: chance(0.5) ? 'Seen shuttling well in practice matches.' : ''
      });
    } catch (e) {
      console.warn(`  team ${team.team_number}: ${e.message}`);
    }
  }

  console.log('Seeding match scouting reports...');
  for (const match of matches) {
    const allTeamKeys = [...(match.alliances?.red?.team_keys || []), ...(match.alliances?.blue?.team_keys || [])];
    for (const teamKey of allTeamKeys) {
      const alliance = (match.alliances?.red?.team_keys || []).includes(teamKey) ? 'red' : 'blue';
      const status = pick(TELEOP_ROBOT_STATUS);
      try {
        await post('/api/matchscout', {
          action: 'save-entry',
          form_version: 2,
          event_key: eventKey,
          match_key: match.key,
          team_key: teamKey,
          alliance,
          scout_name: 'Demo Seed',
          starting_position: pick(START_POSITIONS),
          auto_start_zone: pick(AUTO_ZONES),
          preload: chance(0.8),
          auto_cycles: randInt(0, 4),
          auto_points_band: `${randInt(0, 5) * 10}-${randInt(6, 10) * 10}`,
          auto_finish: pick(['Scored', 'Parked', 'Nothing']),
          auto_moved: chance(0.9) ? 'ran' : 'did-not-run',
          ball_sources: [pick(AUTO_FUEL_SOURCES)],
          auto_collision: chance(0.1),
          auto_collision_notes: '',
          auto_path_name: '',
          auto_path: [],
          teleop_roles: [pick(MATCH_FORM_ROLES)],
          teleop_roles_none: false,
          teleop_notes: '',
          balls_scored_band: pick(BALL_COUNT_RANGES),
          ratings: Object.fromEntries(MATCH_RATING_FIELDS.map((field) => [field, randInt(1, 5)])),
          ratings_unknown: [],
          significant_crash: false,
          crash_target: null,
          crash_details: null,
          teleop_robot_status: status,
          mechanical_break: status === 'dead' && chance(0.5),
          intake_speed: randInt(1, 3),
          intake_jammed: chance(0.15),
          robot_disabled: status === 'dead' ? 'died' : 'none',
          card: pick(['none', 'none', 'none', 'yellow']),
          beached: chance(0.05),
          driver_skill: randInt(2, 5),
          post_notes: ''
        });
      } catch (e) {
        console.warn(`  ${match.key} / ${teamKey}: ${e.message}`);
      }
    }
  }

  console.log('Seeding the pick list from the current roster order...');
  try {
    const orderedIds = [];
    for (const team of [...teams].sort(() => Math.random() - 0.5)) {
      try {
        const added = await post('/api/scouting-picklist', {
          action: 'add',
          event_key: eventKey,
          team_key: team.key,
          team_number: team.team_number,
          nickname: team.nickname
        });
        orderedIds.push(added.data.id);
      } catch (e) {
        if (!String(e.message).includes('409')) console.warn(`  picklist add ${team.team_number}: ${e.message}`);
      }
    }
    if (orderedIds.length) await post('/api/scouting-picklist', { action: 'reorder', event_key: eventKey, ordered_ids: orderedIds });
  } catch (e) {
    console.warn(`  picklist: ${e.message}`);
  }

  console.log(`Done. Seeded demo data for ${eventKey}.${setActive ? '' : ' Set it active in Scouting Admin (or rerun with --set-active) to see it on Strategy/Drive Team/Team View.'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
