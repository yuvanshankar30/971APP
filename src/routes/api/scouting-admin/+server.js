import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { env } from '$env/dynamic/private';
import notescoutConfig from '$lib/notescout.json';
import { FRC_TEAMS, TEAM_ROLES } from '$lib/permissions.js';
import { getSupabase } from '$lib/server/971bot.js';
import { selectPitScoutEntries } from '$lib/server/pitScoutingSchema.js';
import { syncScoutingDataToSheet } from '$lib/server/google_sheets_sync.js';

const COMPETITION_LEAD = String(TEAM_ROLES.COMPETITION_LEAD || 'Competition Lead');
const ALL_FRC_TEAMS = new Set(Object.values(FRC_TEAMS).map(String));
const PIT_SCOUT_PHOTO_BUCKET = 'pit-scout-photos';

function hasAnyPitData(row) {
  if (!row) return false;
  const climbOptions = Array.isArray(row?.climb_options) ? row.climb_options.filter(Boolean) : [];
  const autoOptions = Array.isArray(row?.auto_options) ? row.auto_options.filter((option) => option?.name || option?.description) : [];
  const technicalDetails = row?.technical_details && typeof row.technical_details === 'object' && !Array.isArray(row.technical_details)
    ? row.technical_details
    : {};

  return Boolean(
    String(row?.drivebase_type || '').trim() ||
    String(row?.shooter_type || '').trim() ||
    String(row?.hopper_type || '').trim() ||
    String(row?.human_player_balls_in_auto || '').trim() ||
    String(row?.likely_breaking_component || '').trim() ||
    row?.estimated_bps !== null && row?.estimated_bps !== undefined ||
    climbOptions.length ||
    autoOptions.length ||
    Object.values(technicalDetails).some((value) => (
      Array.isArray(value)
        ? value.filter(Boolean).length
        : value !== '' && value !== null && value !== undefined
    ))
  );
}

function getPitScoutStatus(row) {
  if (!hasAnyPitData(row)) return 'pending';
  const photoPaths = Array.isArray(row?.photo_paths) ? row.photo_paths.filter(Boolean) : [];
  return photoPaths.length ? 'completed' : 'needs_photo';
}
const COMPETITION_ROLE_PRIORITY = [
  'Scouting Admin',
  'Scouting Lead',
  'Data Scout Lead',
  'Note Scout Lead',
  'Data Scout Member',
  'Note Scout Member'
];

const getClientFromRequest = (request) => {
  const auth = request?.headers?.get('authorization') || '';
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } }
  });
};

function fallbackEventKey() {
  return String(notescoutConfig?.event_key || '').trim() || null;
}

function isCompetitionLead(profile) {
  if (profile?.role === 'admin') return true;
  return String(profile?.team_role || '').trim().toLowerCase() === COMPETITION_LEAD.toLowerCase();
}

function isScoutingLead(rosterKeys) {
  const keys = new Set((rosterKeys || []).map(normalizeKey).filter(Boolean));
  return keys.has('scouting admin') || keys.has('scouting lead') || keys.has('data scout lead') || keys.has('note scout lead');
}

function canManageScouting(profile, rosterKeys) {
  return isCompetitionLead(profile) || isScoutingLead(rosterKeys);
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function pickCompetitionRole(roleSet) {
  for (const roleName of COMPETITION_ROLE_PRIORITY) {
    if (roleSet.has(roleName)) return roleName;
  }
  return null;
}

function matchNumberForKey(matchKey) {
  const m = String(matchKey || '').match(/_qm(\d+)$/i);
  return m ? Number(m[1]) : null;
}

function isMatchKeyForEvent(matchKey, eventKey) {
  const mk = String(matchKey || '').trim().toLowerCase();
  const ek = String(eventKey || '').trim().toLowerCase();
  if (!mk || !ek) return false;
  return mk.startsWith(`${ek}_`);
}

function slotKey(matchKey, teamKey) {
  return `${matchKey}::${teamKey}`;
}

function userSlotKey(userId, matchKey, teamKey) {
  return `${userId}::${matchKey}::${teamKey}`;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseTimestampMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function toRound(value, digits = 4) {
  const n = safeNumber(value, 0);
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function avg(list) {
  if (!Array.isArray(list) || !list.length) return 0;
  return list.reduce((sum, v) => sum + safeNumber(v, 0), 0) / list.length;
}

function solveLinearSystem(a, b) {
  const n = a.length;
  if (!n || b.length !== n) return [];

  const mat = a.map((row) => row.slice());
  const rhs = b.slice();
  const EPS = 1e-9;

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(mat[row][col]) > Math.abs(mat[pivot][col])) pivot = row;
    }

    if (Math.abs(mat[pivot][col]) < EPS) {
      mat[col][col] = mat[col][col] + EPS;
      continue;
    }

    if (pivot !== col) {
      [mat[col], mat[pivot]] = [mat[pivot], mat[col]];
      [rhs[col], rhs[pivot]] = [rhs[pivot], rhs[col]];
    }

    const div = mat[col][col];
    for (let j = col; j < n; j += 1) mat[col][j] /= div;
    rhs[col] /= div;

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = mat[row][col];
      if (Math.abs(factor) < EPS) continue;
      for (let j = col; j < n; j += 1) {
        mat[row][j] -= factor * mat[col][j];
      }
      rhs[row] -= factor * rhs[col];
    }
  }

  return rhs.map((v) => safeNumber(v, 1));
}

function extractBlueFuelCount(match) {
  const blue = match?.score_breakdown?.blue;
  if (!blue || typeof blue !== 'object') return null;

  const countKeys = ['autoFuelLow', 'autoFuelHigh', 'teleopFuelLow', 'teleopFuelHigh'];
  const hasAllCountKeys = countKeys.every((k) => Number.isFinite(Number(blue[k])));
  if (hasAllCountKeys) {
    return countKeys.reduce((sum, key) => sum + safeNumber(blue[key], 0), 0);
  }

  const pointKeys = ['totalFuelPoints', 'fuelPoints', 'teleopFuelPoints', 'autoFuelPoints'];
  for (const key of pointKeys) {
    if (Number.isFinite(Number(blue[key]))) return safeNumber(blue[key], 0);
  }

  return null;
}

function buildTeamScoutFuelEstimates(rows) {
  const byTeamScoutMatch = new Map();
  for (const row of rows || []) {
    const matchKey = String(row?.match_key || '');
    const teamKey = String(row?.team_key || '');
    const scoutId = String(row?.created_by || '');
    if (!matchKey || !teamKey || !scoutId) continue;

    const key = `${matchKey}::${teamKey}::${scoutId}`;
    if (!byTeamScoutMatch.has(key)) {
      byTeamScoutMatch.set(key, {
        match_key: matchKey,
        team_key: teamKey,
        scout_id: scoutId,
        speed_values: [],
        accuracy_values: [],
        open_shoot_starts: [],
        shooting_seconds: 0
      });
    }
    const agg = byTeamScoutMatch.get(key);
    const eventType = String(row?.event_type || '').trim();
    const eventValue = safeNumber(row?.event_value, 0);

    if (eventType === 'rank_speed') {
      if (eventValue > 0) agg.speed_values.push(eventValue);
      continue;
    }

    if (eventType === 'rank_accuracy') {
      if (eventValue > 0) agg.accuracy_values.push(eventValue);
      continue;
    }

    const ts = parseTimestampMs(row?.created_at);
    if (eventType === 'shooting_start') {
      if (ts !== null) agg.open_shoot_starts.push(ts);
      continue;
    }

    if (eventType === 'shooting_end') {
      if (ts === null || agg.open_shoot_starts.length === 0) continue;
      const start = agg.open_shoot_starts.shift();
      const deltaSec = Math.max(0, (ts - start) / 1000);
      if (deltaSec > 0) agg.shooting_seconds += deltaSec;
    }
  }

  const estimates = [];
  for (const agg of byTeamScoutMatch.values()) {
    const avgSpeed = avg(agg.speed_values);
    const avgAccuracy = avg(agg.accuracy_values);
    const shootTime = safeNumber(agg.shooting_seconds, 0);
    const baseEstimate = avgSpeed * shootTime * avgAccuracy;
    if (!Number.isFinite(baseEstimate) || baseEstimate <= 0) continue;
    estimates.push({
      match_key: agg.match_key,
      team_key: agg.team_key,
      scout_id: agg.scout_id,
      base_estimate: baseEstimate,
      shooting_seconds: shootTime
    });
  }
  return estimates;
}

function computeSmartScoutAdjustment({ matches, dataEvents, userNameMap, enabled }) {
  const matchBlueTeams = new Map();
  for (const match of matches || []) {
    matchBlueTeams.set(match?.key, new Set(match?.alliances?.blue?.team_keys || []));
  }

  const teamScoutRows = buildTeamScoutFuelEstimates(dataEvents);
  const rowsByMatch = new Map();
  const scoutIds = new Set();

  for (const row of teamScoutRows) {
    if (!matchBlueTeams.get(row.match_key)?.has(row.team_key)) continue;
    if (!rowsByMatch.has(row.match_key)) rowsByMatch.set(row.match_key, new Map());
    const scoutMap = rowsByMatch.get(row.match_key);
    const prev = scoutMap.get(row.scout_id) || { base_estimate: 0, shooting_seconds: 0 };
    scoutMap.set(row.scout_id, {
      base_estimate: prev.base_estimate + safeNumber(row.base_estimate, 0),
      shooting_seconds: prev.shooting_seconds + safeNumber(row.shooting_seconds, 0)
    });
    scoutIds.add(row.scout_id);
  }

  const matchRows = [];
  for (const match of matches || []) {
    const y = extractBlueFuelCount(match);
    const scoutMap = rowsByMatch.get(match?.key) || new Map();
    if (!Number.isFinite(y) || y === null || scoutMap.size === 0) continue;
    matchRows.push({
      match_key: match.key,
      target_fuel: safeNumber(y, 0),
      scout_inputs: scoutMap
    });
  }

  const scoutList = [...scoutIds].sort((a, b) => a.localeCompare(b));
  const scoutIndex = new Map(scoutList.map((id, idx) => [id, idx]));
  const n = scoutList.length;
  const factors = Array(n).fill(1);

  if (enabled && n > 0 && matchRows.length > 0) {
    const lambda = 0.25;
    const gram = Array.from({ length: n }, () => Array(n).fill(0));
    const rhs = Array(n).fill(0);

    for (const row of matchRows) {
      const entries = [...row.scout_inputs.entries()];
      for (const [scoutI, payloadI] of entries) {
        const xi = safeNumber(payloadI?.base_estimate, 0);
        const i = scoutIndex.get(scoutI);
        if (i === undefined) continue;
        rhs[i] += xi * row.target_fuel;
        for (const [scoutJ, payloadJ] of entries) {
          const xj = safeNumber(payloadJ?.base_estimate, 0);
          const j = scoutIndex.get(scoutJ);
          if (j === undefined) continue;
          gram[i][j] += xi * xj;
        }
      }
    }

    for (let i = 0; i < n; i += 1) {
      gram[i][i] += lambda;
      rhs[i] += lambda;
    }

    const solved = solveLinearSystem(gram, rhs);
    for (let i = 0; i < n; i += 1) {
      factors[i] = Math.max(0, safeNumber(solved[i], 1));
    }
  }

  const residuals = [];
  const scoutResidualMap = new Map();
  const scoutBalancedBallCount = new Map();
  const scoutShootingSeconds = new Map();

  for (const row of matchRows) {
    let predicted = 0;
    for (const [scoutId, payload] of row.scout_inputs.entries()) {
      const x = safeNumber(payload?.base_estimate, 0);
      const shootingSeconds = safeNumber(payload?.shooting_seconds, 0);
      const idx = scoutIndex.get(scoutId);
      const balancedCount = x * safeNumber(factors[idx], 1);
      predicted += balancedCount;
      scoutBalancedBallCount.set(scoutId, (scoutBalancedBallCount.get(scoutId) || 0) + balancedCount);
      scoutShootingSeconds.set(scoutId, (scoutShootingSeconds.get(scoutId) || 0) + shootingSeconds);
    }
    const residual = row.target_fuel - predicted;
    residuals.push(residual);

    for (const [scoutId] of row.scout_inputs.entries()) {
      if (!scoutResidualMap.has(scoutId)) scoutResidualMap.set(scoutId, []);
      scoutResidualMap.get(scoutId).push(residual);
    }
  }

  const rmse =
    residuals.length > 0
      ? Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / residuals.length)
      : 0;
  const mae =
    residuals.length > 0
      ? residuals.reduce((sum, r) => sum + Math.abs(r), 0) / residuals.length
      : 0;

  const byScout = scoutList
    .map((scoutId, idx) => {
      const rs = scoutResidualMap.get(scoutId) || [];
      const rMae = rs.length ? rs.reduce((sum, r) => sum + Math.abs(r), 0) / rs.length : 0;
      const rBias = rs.length ? rs.reduce((sum, r) => sum + r, 0) / rs.length : 0;
      const rRmse = rs.length ? Math.sqrt(rs.reduce((sum, r) => sum + r * r, 0) / rs.length) : 0;
      const balancedBallCount = safeNumber(scoutBalancedBallCount.get(scoutId), 0);
      const shootingSeconds = safeNumber(scoutShootingSeconds.get(scoutId), 0);
      const estimatedBps = shootingSeconds > 0 ? balancedBallCount / shootingSeconds : 0;
      return {
        scout_id: scoutId,
        scout_name: userNameMap.get(scoutId) || scoutId,
        adjustment_factor: toRound(factors[idx], 4),
        balanced_ball_count: toRound(balancedBallCount, 3),
        shooting_seconds: toRound(shootingSeconds, 3),
        estimated_bps: toRound(estimatedBps, 4),
        residual_mae: toRound(rMae, 3),
        residual_bias: toRound(rBias, 3),
        residual_rmse: toRound(rRmse, 3),
        sample_matches: rs.length
      };
    })
    .sort((a, b) => a.scout_name.localeCompare(b.scout_name));

  const warning =
    matchRows.length === 0
      ? 'No qualification matches had both blue alliance fuel data and scout input data.'
      : null;

  return {
    enabled: !!enabled,
    match_count: matchRows.length,
    residual_rmse: toRound(rmse, 3),
    residual_mae: toRound(mae, 3),
    warning,
    by_scout: byScout
  };
}

// ===== Quick Scout alliance-score attribution =====
// Team 604's method: a scout logs starting position + shooting/climbed/
// defense/broken toggles (see src/routes/quickscout/), and this regresses
// those coarse per-robot signals against each match's REAL alliance score
// (score_breakdown.<color>.totalPoints, confirmed live against real 2026arc
// data - unlike extractBlueFuelCount above, this field is season-agnostic
// and always present) to estimate what share of the alliance's score each
// robot was responsible for. Same solveLinearSystem solver as Smart Fuel
// Calibration above, but a genuinely different regression shape: that tool
// solves one correction FACTOR per scout (ridge shrinks toward 1) using
// alliance-total fuel counts; this solves shared point-VALUE coefficients
// (ridge shrinks toward 0) using alliance-total score, one row per
// match×alliance since TBA never gives us a single robot's own score.
//
// Known, accepted limitation: defense reduces the OPPONENT alliance's
// score, not this alliance's own total, so a same-alliance regression
// structurally can't credit it well - its coefficient will likely be near
// zero or noisy. That's expected, not a bug - matches what was actually
// asked for (604's simple method), not a fancier two-alliance model.
const QUICK_FEATURE_NAMES = ['intercept', 'shooting_seconds', 'climbed_count', 'defense_count', 'broken_count'];

function buildQuickScoutFeatureMap(rows) {
  const byTeamMatch = new Map();
  const openShootStarts = new Map(); // `${match}::${team}` -> [start ms, ...]

  for (const row of rows || []) {
    const matchKey = String(row?.match_key || '');
    const teamKey = String(row?.team_key || '');
    const eventType = String(row?.event_type || '').trim();
    if (!matchKey || !teamKey || !eventType.startsWith('quick_')) continue;

    const key = `${matchKey}::${teamKey}`;
    if (!byTeamMatch.has(key)) {
      byTeamMatch.set(key, {
        match_key: matchKey,
        team_key: teamKey,
        shooting_seconds: 0,
        climbed: false,
        defense: false,
        broken: false
      });
    }
    const agg = byTeamMatch.get(key);
    const ts = parseTimestampMs(row?.created_at);

    if (eventType === 'quick_shooting_start') {
      if (ts !== null) {
        if (!openShootStarts.has(key)) openShootStarts.set(key, []);
        openShootStarts.get(key).push(ts);
      }
      continue;
    }
    if (eventType === 'quick_shooting_end') {
      const stack = openShootStarts.get(key);
      if (ts === null || !stack || stack.length === 0) continue;
      const start = stack.shift();
      const deltaSec = Math.max(0, (ts - start) / 1000);
      if (deltaSec > 0) agg.shooting_seconds += deltaSec;
      continue;
    }
    if (eventType === 'quick_climbed_start') { agg.climbed = true; continue; }
    if (eventType === 'quick_defense_start') { agg.defense = true; continue; }
    if (eventType === 'quick_broken_start') { agg.broken = true; continue; }
    // quick_auto_start_position and the _end events of climbed/defense/broken
    // (already captured by their _start above) intentionally don't affect
    // the feature map further.
  }

  return byTeamMatch;
}

function buildAllianceRegressionRows({ matches, featureMap }) {
  const rows = [];
  for (const match of matches || []) {
    for (const color of ['blue', 'red']) {
      const teamKeys = match?.alliances?.[color]?.team_keys || [];
      if (teamKeys.length !== 3) continue;
      const totalPoints = match?.score_breakdown?.[color]?.totalPoints;
      if (!Number.isFinite(Number(totalPoints))) continue;

      const perTeamFeatures = {};
      let anyCoverage = false;
      let shootSum = 0;
      let climbedCount = 0;
      let defenseCount = 0;
      let brokenCount = 0;
      for (const teamKey of teamKeys) {
        const feat = featureMap.get(`${match.key}::${teamKey}`);
        const resolved = feat || { shooting_seconds: 0, climbed: false, defense: false, broken: false };
        if (feat) anyCoverage = true;
        perTeamFeatures[teamKey] = resolved;
        shootSum += safeNumber(resolved.shooting_seconds, 0);
        if (resolved.climbed) climbedCount += 1;
        if (resolved.defense) defenseCount += 1;
        if (resolved.broken) brokenCount += 1;
      }
      if (!anyCoverage) continue;

      rows.push({
        match_key: match.key,
        alliance_color: color,
        team_keys: teamKeys,
        features: [1, shootSum, climbedCount, defenseCount, brokenCount],
        per_team_features: perTeamFeatures,
        target: safeNumber(totalPoints, 0)
      });
    }
  }
  return rows;
}

// Ridge toward 0 (a sensible zero-prior for literal point-value weights,
// unlike computeSmartScoutAdjustment's shrink-toward-1 correction factors).
// Standardizes the 4 non-intercept features before fitting so one flat
// lambda regularizes evenly despite very different natural scales
// (shooting seconds can be 100+, climb/defense/broken counts are 0-3), then
// un-standardizes the fitted coefficients back to real point-value units.
function fitQuickScoutRegression(rows, lambda = 0.05) {
  const P = QUICK_FEATURE_NAMES.length;
  if (!rows.length) return Array(P).fill(0);

  const scales = [1];
  for (let i = 1; i < P; i += 1) {
    const maxAbs = Math.max(0, ...rows.map((r) => Math.abs(r.features[i])));
    scales.push(maxAbs > 0 ? maxAbs : 1);
  }

  const gram = Array.from({ length: P }, () => Array(P).fill(0));
  const rhs = Array(P).fill(0);
  for (const row of rows) {
    const x = row.features.map((v, i) => v / scales[i]);
    for (let i = 0; i < P; i += 1) {
      rhs[i] += x[i] * row.target;
      for (let j = 0; j < P; j += 1) gram[i][j] += x[i] * x[j];
    }
  }
  for (let i = 1; i < P; i += 1) gram[i][i] += lambda;

  const solvedStandardized = solveLinearSystem(gram, rhs);
  return solvedStandardized.map((v, i) => safeNumber(v, 0) / scales[i]);
}

function computeQuickScoutModel({ matches, quickEvents }) {
  const featureMap = buildQuickScoutFeatureMap(quickEvents);
  const rows = buildAllianceRegressionRows({ matches, featureMap });

  if (rows.length === 0) {
    return {
      alliance_count: 0,
      coefficients: null,
      residual_rmse: 0,
      residual_mae: 0,
      warning: 'No matches yet have both Quick Scout data and a real alliance score to regress against.',
      by_team: []
    };
  }

  // lambda=0.05, not 0.5: verified against synthetic data with known ground
  // truth (see session notes) that 0.5 introduces real bias here - an
  // unregularized intercept trades off against low-variance regularized
  // features (climbed/defense/broken are small integer counts), and 0.5
  // was strong enough to shrink a true broken coefficient of -2 down to
  // -0.36. 0.05 recovers known coefficients within ~15% on 60 synthetic
  // alliance-matches while still preventing an unregularized blowup on
  // small/collinear real data.
  const [beta0, betaShoot, betaClimb, betaDefense, betaBroken] = fitQuickScoutRegression(rows, 0.05);

  const residuals = [];
  const teamAgg = new Map();

  for (const row of rows) {
    const contributions = {};
    let predictedTotal = beta0;
    for (const teamKey of row.team_keys) {
      const f = row.per_team_features[teamKey];
      const contribution =
        betaShoot * safeNumber(f?.shooting_seconds, 0) +
        betaClimb * (f?.climbed ? 1 : 0) +
        betaDefense * (f?.defense ? 1 : 0) +
        betaBroken * (f?.broken ? 1 : 0);
      contributions[teamKey] = contribution;
      predictedTotal += contribution;
    }
    residuals.push(row.target - predictedTotal);

    const sumContribution = Object.values(contributions).reduce((s, v) => s + v, 0);
    for (const teamKey of row.team_keys) {
      const contribution = contributions[teamKey];
      // Relative-share convention; split evenly if the whole alliance's
      // modeled contribution is ~0 (e.g. no Quick Scout coverage this match).
      const percent = sumContribution > 1e-6 ? (contribution / sumContribution) * 100 : 100 / 3;
      if (!teamAgg.has(teamKey)) teamAgg.set(teamKey, { sumPercent: 0, sumContribution: 0, matchCount: 0 });
      const agg = teamAgg.get(teamKey);
      agg.sumPercent += percent;
      agg.sumContribution += contribution;
      agg.matchCount += 1;
    }
  }

  const rmse = residuals.length ? Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length) : 0;
  const mae = residuals.length ? residuals.reduce((s, r) => s + Math.abs(r), 0) / residuals.length : 0;

  const byTeam = [...teamAgg.entries()]
    .map(([teamKey, agg]) => ({
      team_key: teamKey,
      matches_scored: agg.matchCount,
      avg_percent_of_alliance_score: toRound(agg.sumPercent / agg.matchCount, 1),
      avg_contribution_points: toRound(agg.sumContribution / agg.matchCount, 2)
    }))
    .sort((a, b) => b.avg_percent_of_alliance_score - a.avg_percent_of_alliance_score);

  return {
    alliance_count: rows.length,
    coefficients: {
      intercept: toRound(beta0, 3),
      shooting_seconds: toRound(betaShoot, 4),
      climbed: toRound(betaClimb, 3),
      defense: toRound(betaDefense, 3),
      broken: toRound(betaBroken, 3)
    },
    residual_rmse: toRound(rmse, 2),
    residual_mae: toRound(mae, 2),
    warning: rows.length < 5 ? 'Very few matches with Quick Scout coverage so far - estimates will be noisy.' : null,
    by_team: byTeam
  };
}

async function fetchActorProfile(authSupa) {
  const { data } = await authSupa.auth.getUser();
  const actorId = data?.user?.id || null;
  if (!actorId) return { actorId: null, profile: null };

  const { data: profile } = await authSupa
    .from('user_profiles')
    .select('id, role, permissions, team_role')
    .eq('id', actorId)
    .single();

  return { actorId, profile: profile || null };
}

async function getScoutingSettings(db) {
  const emptySettings = {
    event_key: fallbackEventKey(),
    smart_fuel_algorithm_enabled: false,
    google_sheet_id: null,
    google_sheet_last_synced_at: null,
    google_sheet_last_sync_error: null
  };

  const primary = await db
    .from('scouting_settings')
    .select('event_key, smart_fuel_algorithm_enabled, google_sheet_id, google_sheet_last_synced_at, google_sheet_last_sync_error')
    .eq('id', 1)
    .maybeSingle();

  if (!primary.error) {
    return {
      event_key: String(primary.data?.event_key || '').trim() || fallbackEventKey(),
      smart_fuel_algorithm_enabled: !!primary.data?.smart_fuel_algorithm_enabled,
      google_sheet_id: primary.data?.google_sheet_id || null,
      google_sheet_last_synced_at: primary.data?.google_sheet_last_synced_at || null,
      google_sheet_last_sync_error: primary.data?.google_sheet_last_sync_error || null
    };
  }

  // Backward compatibility before the migration has been applied.
  const fallback = await db
    .from('scouting_settings')
    .select('event_key')
    .eq('id', 1)
    .maybeSingle();

  if (fallback.error) return emptySettings;
  return {
    event_key: String(fallback.data?.event_key || '').trim() || fallbackEventKey(),
    smart_fuel_algorithm_enabled: false,
    google_sheet_id: null,
    google_sheet_last_synced_at: null,
    google_sheet_last_sync_error: null
  };
}

async function fetchCompetitionRoleKeys(db) {
  const { data, error } = await db
    .from('roster_keys')
    .select('id, roster_id, key_name')
    .in('key_name', COMPETITION_ROLE_PRIORITY)
    .order('id', { ascending: true });

  if (error) throw error;

  const byName = new Map();
  for (const row of data || []) {
    const keyName = String(row?.key_name || '').trim();
    if (!keyName || byName.has(keyName)) continue;
    byName.set(keyName, {
      id: row.id,
      roster_id: row.roster_id,
      key_name: keyName
    });
  }

  return byName;
}

async function findScoutingRosterId(db, existingRoleKeys = new Map()) {
  for (const row of existingRoleKeys.values()) {
    if (row?.roster_id) return row.roster_id;
  }

  const { data, error } = await db
    .from('rosters')
    .select('id, name')
    .order('id', { ascending: true });

  if (error) return null;
  const rows = data || [];
  const scoutingRoster =
    rows.find((r) => String(r?.name || '').toLowerCase().includes('scouting')) ||
    rows.find((r) => String(r?.name || '').toLowerCase().includes('competition')) ||
    rows[0];

  return scoutingRoster?.id || null;
}

async function ensureCompetitionRoleKeys(db) {
  const byName = await fetchCompetitionRoleKeys(db);
  const missing = COMPETITION_ROLE_PRIORITY.filter((name) => !byName.has(name));
  if (!missing.length) return byName;

  const rosterId = await findScoutingRosterId(db, byName);
  if (!rosterId) return byName;

  for (const keyName of missing) {
    const { error } = await db.from('roster_keys').insert([
      {
        roster_id: rosterId,
        key_name: keyName,
        category: 'Scouting'
      }
    ]);

    if (error && error.code !== '23505') throw error;
  }

  return fetchCompetitionRoleKeys(db);
}

async function fetchCompetitionRolesByUser(db, keyIds) {
  if (!keyIds.length) return new Map();
  const { data, error } = await db
    .from('roster_entries')
    .select('user_id, key:key_id(key_name)')
    .in('key_id', keyIds);

  if (error) throw error;

  const byUser = new Map();
  for (const row of data || []) {
    const userId = row?.user_id;
    const keyName = String(row?.key?.key_name || '').trim();
    if (!userId || !keyName) continue;
    if (!byUser.has(userId)) byUser.set(userId, new Set());
    byUser.get(userId).add(keyName);
  }

  return byUser;
}

async function fetchRosterKeysForUser(db, userId) {
  if (!userId) return [];
  const { data, error } = await db
    .from('roster_entries')
    .select('key:key_id(key_name)')
    .eq('user_id', userId);

  if (error) return [];
  return (data || [])
    .map((row) => row?.key?.key_name)
    .filter(Boolean)
    .map(String);
}

async function fetchEventMatches(eventKey) {
  if (!eventKey) return { matches: [], warning: 'No event configured.' };

  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return { matches: [], warning: 'Server missing TBA_API_KEY.' };

  try {
    const resp = await fetch(`https://www.thebluealliance.com/api/v3/event/${encodeURIComponent(eventKey)}/matches`, {
      headers: { 'X-TBA-Auth-Key': authKey }
    });
    if (!resp.ok) {
      return { matches: [], warning: `TBA request failed (${resp.status}).` };
    }

    const raw = await resp.json();
    const matches = (raw || [])
      .filter((m) => m?.comp_level === 'qm')
      .sort((a, b) => (a?.match_number || 0) - (b?.match_number || 0));

    return { matches, warning: null };
  } catch (e) {
    return { matches: [], warning: e?.message || 'Failed to fetch TBA matches.' };
  }
}

async function fetchEventTeams(eventKey) {
  if (!eventKey) return { teamKeys: [] };

  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return { teamKeys: [] };

  try {
    const resp = await fetch(`https://www.thebluealliance.com/api/v3/event/${encodeURIComponent(eventKey)}/teams/simple`, {
      headers: { 'X-TBA-Auth-Key': authKey }
    });
    if (!resp.ok) return { teamKeys: [] };

    const raw = await resp.json();
    const teamKeys = (raw || []).map((t) => t?.key).filter(Boolean);
    return { teamKeys };
  } catch {
    return { teamKeys: [] };
  }
}

async function fetchUpcomingEvents() {
  const authKey = env.TBA_API_KEY || env.VITE_TBA_API_KEY || env.PUBLIC_TBA_API_KEY;
  if (!authKey) return { events: [], warning: null };

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const yesterdayIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const teams = ['frc971', 'frc9584'];

  const urls = [
    ...teams.map((team) => `https://www.thebluealliance.com/api/v3/team/${team}/events/upcoming/simple`),
    ...teams.map((team) => `https://www.thebluealliance.com/api/v3/team/${team}/events/${currentYear}/simple`),
    ...teams.map((team) => `https://www.thebluealliance.com/api/v3/team/${team}/events/${currentYear + 1}/simple`)
  ];

  try {
    const responses = await Promise.all(
      urls.map((u) => fetch(u, { headers: { 'X-TBA-Auth-Key': authKey } }))
    );

    const okResponses = responses.filter((r) => r.ok);
    if (!okResponses.length) {
      const statuses = responses.map((r) => r?.status).filter(Boolean);
      const all404 = statuses.length > 0 && statuses.every((s) => s === 404);
      if (all404) {
        // Treat "no upcoming events endpoint data" as empty state, not an operator-facing error.
        return { events: [], warning: null };
      }
      return { events: [], warning: `TBA events request failed (${responses[0]?.status || 'unknown'}).` };
    }

    const payloads = await Promise.all(okResponses.map((r) => r.json()));
    const byKey = new Map();

    for (const list of payloads) {
      for (const ev of list || []) {
        if (!ev?.key) continue;
        byKey.set(ev.key, {
          key: ev.key,
          name: ev.name || ev.key,
          year: ev.year || null,
          start_date: ev.start_date || null,
          end_date: ev.end_date || null
        });
      }
    }

    const events = [...byKey.values()]
      .filter((ev) => {
        const end = String(ev?.end_date || '');
        if (!end) return true;
        return end >= yesterdayIso;
      })
      .sort((a, b) => {
        const aDate = String(a.start_date || '9999-12-31');
        const bDate = String(b.start_date || '9999-12-31');
        if (aDate !== bDate) return aDate.localeCompare(bDate);
        return String(a.key).localeCompare(String(b.key));
      });

    return { events, warning: null };
  } catch (e) {
    return { events: [], warning: e?.message || 'Failed to fetch upcoming events.' };
  }
}

function computeTypeMetrics({ type, assignments, matches, slotTeamsByMatch, evidenceRows, userNameMap }) {
  const totalMatches = matches.length;
  const totalSlots = totalMatches * 6;

  const relevantAssignments = (assignments || []).filter((row) => row?.scouting_type === type);
  const assignedSlots = new Set();
  for (const row of relevantAssignments) {
    if (!row?.assigned_user) continue;
    if (!slotTeamsByMatch.has(row.match_key)) continue;
    assignedSlots.add(slotKey(row.match_key, row.team_key));
  }

  let fullyAssignedMatches = 0;
  for (const match of matches) {
    const teams = slotTeamsByMatch.get(match.key) || [];
    const allAssigned = teams.every((teamKey) => assignedSlots.has(slotKey(match.key, teamKey)));
    if (allAssigned) fullyAssignedMatches += 1;
  }

  const anyEvidenceBySlot = new Set();
  const ownEvidenceBySlot = new Set();
  const userMaxStartedMatch = new Map();

  for (const row of evidenceRows || []) {
    const mk = row?.match_key;
    const tk = row?.team_key;
    const uid = row?.created_by;
    if (!mk || !tk) continue;
    if (!slotTeamsByMatch.has(mk)) continue;

    anyEvidenceBySlot.add(slotKey(mk, tk));

    if (uid) {
      ownEvidenceBySlot.add(userSlotKey(uid, mk, tk));
      const mn = matchNumberForKey(mk);
      if (mn !== null) {
        const prev = userMaxStartedMatch.get(uid) || 0;
        if (mn > prev) userMaxStartedMatch.set(uid, mn);
      }
    }
  }

  let fullyScoutedMatches = 0;
  for (const match of matches) {
    const teams = slotTeamsByMatch.get(match.key) || [];
    const allScouted = teams.every((teamKey) => anyEvidenceBySlot.has(slotKey(match.key, teamKey)));
    if (allScouted) fullyScoutedMatches += 1;
  }

  const missedAssignments = [];
  for (const row of relevantAssignments) {
    if (!row?.assigned_user) continue;
    if (!slotTeamsByMatch.has(row.match_key)) continue;

    const matchNumber = matchNumberForKey(row.match_key);
    if (matchNumber === null) continue;

    const ownEvidence = ownEvidenceBySlot.has(userSlotKey(row.assigned_user, row.match_key, row.team_key));
    if (ownEvidence) continue;

    const maxStarted = userMaxStartedMatch.get(row.assigned_user) || 0;
    if (maxStarted > matchNumber) {
      missedAssignments.push({
        scouting_type: type,
        match_key: row.match_key,
        match_number: matchNumber,
        team_key: row.team_key,
        assigned_user: row.assigned_user,
        user_name: userNameMap.get(row.assigned_user) || null
      });
    }
  }

  const percent = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

  return {
    assigned_matches: fullyAssignedMatches,
    assigned_match_percent: percent(fullyAssignedMatches, totalMatches),
    scouted_matches: fullyScoutedMatches,
    scouted_match_percent: percent(fullyScoutedMatches, totalMatches),
    assigned_slots: assignedSlots.size,
    total_slots: totalSlots,
    missed_shifts: missedAssignments.length,
    missed_shift_percent: percent(missedAssignments.length, assignedSlots.size || 0),
    missed_assignments: missedAssignments
  };
}

function computeMissedMatchList(dataMissed, noteMissed, quickMissed = []) {
  const byMatch = new Map();
  for (const item of [...dataMissed, ...noteMissed, ...quickMissed]) {
    if (!byMatch.has(item.match_key)) {
      byMatch.set(item.match_key, {
        match_key: item.match_key,
        match_number: item.match_number,
        data_missed_count: 0,
        note_missed_count: 0,
        quick_missed_count: 0,
        missed_assignments: []
      });
    }
    const row = byMatch.get(item.match_key);
    if (item.scouting_type === 'data') row.data_missed_count += 1;
    if (item.scouting_type === 'note') row.note_missed_count += 1;
    if (item.scouting_type === 'quick') row.quick_missed_count += 1;
    row.missed_assignments.push(item);
  }

  return [...byMatch.values()].sort((a, b) => (a.match_number || 0) - (b.match_number || 0));
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

async function countAllRows(db, tableName) {
  const { count, error } = await db
    .from(tableName)
    .select('id', { count: 'exact', head: true })
    .not('id', 'is', null);

  if (error) throw error;
  return Number(count) || 0;
}

async function deleteAllRows(db, tableName) {
  const count = await countAllRows(db, tableName);
  if (count === 0) return 0;

  const { error } = await db
    .from(tableName)
    .delete()
    .not('id', 'is', null);

  if (error) throw error;
  return count;
}

async function fetchAllStorageObjectNames(db, bucketId) {
  const pageSize = 1000;
  const names = [];

  for (let offset = 0; ; offset += pageSize) {
    const page = await db
      .schema('storage')
      .from('objects')
      .select('name')
      .eq('bucket_id', bucketId)
      .range(offset, offset + pageSize - 1);

    if (page.error) return { data: null, error: page.error };

    const rows = page.data || [];
    names.push(...rows);
    if (rows.length < pageSize) break;
  }

  return { data: names, error: null };
}

async function fetchAllPitEntryPhotoRows(db) {
  const pageSize = 1000;
  const rows = [];

  for (let offset = 0; ; offset += pageSize) {
    const page = await db
      .from('pit_scout_entries')
      .select('photo_paths')
      .range(offset, offset + pageSize - 1);

    if (page.error) return { data: null, error: page.error };

    const pageRows = page.data || [];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }

  return { data: rows, error: null };
}

async function fetchPitPhotoPaths(db) {
  const bucketRows = await fetchAllStorageObjectNames(db, PIT_SCOUT_PHOTO_BUCKET);

  if (!bucketRows.error) {
    return {
      paths: [...new Set((bucketRows.data || []).map((row) => String(row?.name || '').trim()).filter(Boolean))],
      warning: null
    };
  }

  const entryRows = await fetchAllPitEntryPhotoRows(db);

  if (entryRows.error) throw entryRows.error;

  return {
    paths: [
      ...new Set(
        (entryRows.data || [])
          .flatMap((row) => (Array.isArray(row?.photo_paths) ? row.photo_paths : []))
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      )
    ],
    warning: 'Scouting rows were cleared, but pit photo cleanup could only use paths stored on pit entries.'
  };
}

async function removePitPhotos(db, photoPaths) {
  let removed = 0;
  const warnings = [];

  for (const batch of chunk(photoPaths, 100)) {
    if (!batch.length) continue;
    const { error } = await db.storage.from(PIT_SCOUT_PHOTO_BUCKET).remove(batch);
    if (error) {
      warnings.push(`Failed to remove some pit photos: ${error.message}`);
      continue;
    }
    removed += batch.length;
  }

  return { removed, warnings };
}

async function clearAllScoutingData(db) {
  const pitPhotosResult = await fetchPitPhotoPaths(db);
  const warningParts = [];
  if (pitPhotosResult.warning) warningParts.push(pitPhotosResult.warning);

  const [dataEventsDeleted, notesDeleted, assignmentsDeleted, pitEntriesDeleted] = await Promise.all([
    deleteAllRows(db, 'scout_data_events'),
    deleteAllRows(db, 'scout_notes'),
    deleteAllRows(db, 'scout_match_assignments'),
    deleteAllRows(db, 'pit_scout_entries')
  ]);

  const pitPhotoRemoval = await removePitPhotos(db, pitPhotosResult.paths || []);
  warningParts.push(...pitPhotoRemoval.warnings);

  return {
    deleted: {
      data_events: dataEventsDeleted,
      notes: notesDeleted,
      assignments: assignmentsDeleted,
      pit_entries: pitEntriesDeleted,
      pit_photos: pitPhotoRemoval.removed
    },
    warning: warningParts.filter(Boolean).join(' ')
  };
}

export async function GET({ request }) {
  try {
    const authSupa = getClientFromRequest(request);
    const { actorId, profile } = await fetchActorProfile(authSupa);
    const db = getSupabase();
    const actorRosterKeys = actorId ? await fetchRosterKeysForUser(db, actorId) : [];

    if (!actorId) return json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageScouting(profile, actorRosterKeys)) return json({ error: 'Forbidden' }, { status: 403 });
    const settings = await getScoutingSettings(db);
    const eventKey = settings.event_key;
    const smartFuelEnabled = settings.smart_fuel_algorithm_enabled;

    const [upcomingRes, matchesRes, eventTeamsRes, usersRes, assignmentsRes, pitRes, competitionRoleKeys] = await Promise.all([
      fetchUpcomingEvents(),
      fetchEventMatches(eventKey),
      fetchEventTeams(eventKey),
      db
        .from('user_profiles')
        .select('id, full_name, email, role, team_role, frc_team, banned')
        .order('full_name', { ascending: true }),
      db
        .from('scout_match_assignments')
        .select('scouting_type, match_key, team_key, assigned_user, completed_at')
        .in('scouting_type', ['data', 'note', 'quick']),
      eventKey
        ? selectPitScoutEntries(db, (query) => query.eq('event_key', eventKey))
        : Promise.resolve({ data: [], error: null, schema: null, warning: null }),
      ensureCompetitionRoleKeys(db)
    ]);

    if (usersRes.error) return json({ error: usersRes.error.message }, { status: 500 });
    if (assignmentsRes.error) return json({ error: assignmentsRes.error.message }, { status: 500 });
    if (pitRes.error) return json({ error: pitRes.error.message }, { status: 500 });

    const competitionRoleOptions = [...COMPETITION_ROLE_PRIORITY];
    const competitionRoleKeyIds = competitionRoleOptions
      .map((name) => competitionRoleKeys.get(name)?.id || null)
      .filter(Boolean);
    const competitionRolesByUser = await fetchCompetitionRolesByUser(db, competitionRoleKeyIds);

    const matches = [...(matchesRes.matches || [])];
    const warning = [matchesRes.warning, upcomingRes.warning, pitRes.warning].filter(Boolean).join(' ') || null;
    const matchKeys = matches.map((m) => m.key).filter(Boolean);
    const slotTeamsByMatch = new Map();
    const teamSet = new Set();

    // Seed from the event's registered team list so pit metrics are correct
    // even before any matches are posted to TBA.
    for (const teamKey of (eventTeamsRes.teamKeys || [])) teamSet.add(teamKey);

    // Fallback: include any teams that already have pit scout entries so progress shows
    // even if TBA calls fail or the event team list is empty.
    const pitRowsForTeamSeed = pitRes.data || [];
    for (const row of pitRowsForTeamSeed) {
      if (row?.team_key) teamSet.add(row.team_key);
    }

    for (const match of matches) {
      const teams = [
        ...(match?.alliances?.blue?.team_keys || []),
        ...(match?.alliances?.red?.team_keys || [])
      ];
      slotTeamsByMatch.set(match.key, teams);
      for (const teamKey of teams) teamSet.add(teamKey);
    }

    const dataEventsRes = eventKey
      ? await db
          .from('scout_data_events')
          .select('match_key, team_key, created_by, event_type, event_value, created_at')
          .ilike('match_key', `${eventKey}_%`)
      : matchKeys.length
        ? await db
            .from('scout_data_events')
            .select('match_key, team_key, created_by, event_type, event_value, created_at')
            .in('match_key', matchKeys)
        : { data: [], error: null };

    if (dataEventsRes.error) return json({ error: dataEventsRes.error.message }, { status: 500 });

    const noteEventsRes = eventKey
      ? await db
          .from('scout_notes')
          .select('match_key, team_key, created_by')
          .ilike('match_key', `${eventKey}_%`)
      : matchKeys.length
        ? await db
            .from('scout_notes')
            .select('match_key, team_key, created_by')
            .in('match_key', matchKeys)
        : { data: [], error: null };

    if (noteEventsRes.error) return json({ error: noteEventsRes.error.message }, { status: 500 });

    // scout_data_events is shared by every scouting mode with no mode
    // column - split it here by the quick_ event_type prefix so a match
    // scouted only via Quick Scout doesn't silently count as "Data Scouted"
    // too (computeTypeMetrics has no event_type filtering of its own).
    const allDataEventRows = dataEventsRes.data || [];
    const dataEvidenceRows = allDataEventRows.filter((r) => !String(r?.event_type || '').startsWith('quick_'));
    const quickEvidenceRows = allDataEventRows.filter((r) => String(r?.event_type || '').startsWith('quick_'));
    const noteEvidenceRows = noteEventsRes.data || [];

    const assignments = (assignmentsRes.data || []).filter((row) => isMatchKeyForEvent(row?.match_key, eventKey));

    const localSlotsByMatch = new Map();
    const addLocalSlot = (matchKey, teamKey) => {
      if (!isMatchKeyForEvent(matchKey, eventKey)) return;
      if (!teamKey) return;
      if (slotTeamsByMatch.has(matchKey)) return;
      if (!localSlotsByMatch.has(matchKey)) localSlotsByMatch.set(matchKey, new Set());
      localSlotsByMatch.get(matchKey).add(teamKey);
    };

    for (const row of assignments) addLocalSlot(row?.match_key, row?.team_key);
    for (const row of dataEvidenceRows) addLocalSlot(row?.match_key, row?.team_key);
    for (const row of noteEvidenceRows) addLocalSlot(row?.match_key, row?.team_key);
    for (const row of quickEvidenceRows) addLocalSlot(row?.match_key, row?.team_key);

    for (const [localMatchKey, teamKeys] of localSlotsByMatch.entries()) {
      const teams = [...teamKeys];
      slotTeamsByMatch.set(localMatchKey, teams);
      matches.push({
        key: localMatchKey,
        match_number: matchNumberForKey(localMatchKey),
        alliances: { blue: { team_keys: [] }, red: { team_keys: [] } }
      });
      for (const teamKey of teams) teamSet.add(teamKey);
    }

    matches.sort((a, b) => {
      const aNum = matchNumberForKey(a?.key);
      const bNum = matchNumberForKey(b?.key);
      if (aNum !== null && bNum !== null && aNum !== bNum) return aNum - bNum;
      if (aNum !== null && bNum === null) return -1;
      if (aNum === null && bNum !== null) return 1;
      return String(a?.key || '').localeCompare(String(b?.key || ''));
    });

    const users = (usersRes.data || [])
      .filter((u) => !u?.banned)
      .map((u) => ({
        id: u.id,
        full_name: u.full_name || null,
        email: u.email || null,
        role: u.role || 'member',
        frc_team: u.frc_team || null,
        competition_role: pickCompetitionRole(competitionRolesByUser.get(u.id) || new Set())
      }));

    const userNameMap = new Map(users.map((u) => [u.id, u.full_name || u.email || u.id]));

    const dataMetrics = computeTypeMetrics({
      type: 'data',
      assignments,
      matches,
      slotTeamsByMatch,
      evidenceRows: dataEvidenceRows,
      userNameMap
    });

    const noteMetrics = computeTypeMetrics({
      type: 'note',
      assignments,
      matches,
      slotTeamsByMatch,
      evidenceRows: noteEvidenceRows,
      userNameMap
    });

    const quickMetrics = computeTypeMetrics({
      type: 'quick',
      assignments,
      matches,
      slotTeamsByMatch,
      evidenceRows: quickEvidenceRows,
      userNameMap
    });

    const pitRows = pitRes.data || [];
    const pitSchema = pitRes.schema || {};
    const pitStatusByTeam = new Map(
      pitRows
        .filter((row) => row?.team_key)
        .map((row) => [row.team_key, getPitScoutStatus(row)])
    );

    const totalTeams = teamSet.size;
    const pitStatusCounts = { pending: 0, needs_photo: 0, completed: 0 };
    for (const teamKey of teamSet) {
      const status = pitStatusByTeam.get(teamKey) || 'pending';
      pitStatusCounts[status] = (pitStatusCounts[status] || 0) + 1;
    }
    const pitScoutedTeams = pitStatusCounts.completed;

    const totalMatches = matches.length;
    const missedMatches = computeMissedMatchList(dataMetrics.missed_assignments, noteMetrics.missed_assignments, quickMetrics.missed_assignments);

    const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);
    const smartFuelModel = computeSmartScoutAdjustment({
      matches,
      dataEvents: dataEvidenceRows,
      userNameMap,
      enabled: smartFuelEnabled
    });
    const quickScoutModel = computeQuickScoutModel({
      matches,
      quickEvents: quickEvidenceRows
    });

    return json({
      success: true,
      data: {
        event_key: eventKey || null,
        smart_fuel_algorithm_enabled: smartFuelEnabled,
        google_sheet_id: settings.google_sheet_id,
        google_sheet_last_synced_at: settings.google_sheet_last_synced_at,
        google_sheet_last_sync_error: settings.google_sheet_last_sync_error,
        upcoming_events: upcomingRes.events || [],
        warning,
        competition_role_options: competitionRoleOptions,
        users,
        metrics: {
          pit: {
            scouted_teams: pitScoutedTeams,
            pending_teams: pitStatusCounts.pending,
            needs_photo_teams: pitStatusCounts.needs_photo,
            completed_teams: pitStatusCounts.completed,
            total_teams: totalTeams,
            percent: pct(pitScoutedTeams, totalTeams)
          },
          data: {
            assigned_matches: dataMetrics.assigned_matches,
            scouted_matches: dataMetrics.scouted_matches,
            total_matches: totalMatches,
            assigned_percent: dataMetrics.assigned_match_percent,
            scouted_percent: dataMetrics.scouted_match_percent,
            missed_shifts: dataMetrics.missed_shifts,
            missed_shift_percent: dataMetrics.missed_shift_percent
          },
          note: {
            assigned_matches: noteMetrics.assigned_matches,
            scouted_matches: noteMetrics.scouted_matches,
            total_matches: totalMatches,
            assigned_percent: noteMetrics.assigned_match_percent,
            scouted_percent: noteMetrics.scouted_match_percent,
            missed_shifts: noteMetrics.missed_shifts,
            missed_shift_percent: noteMetrics.missed_shift_percent
          },
          quick: {
            assigned_matches: quickMetrics.assigned_matches,
            scouted_matches: quickMetrics.scouted_matches,
            total_matches: totalMatches,
            assigned_percent: quickMetrics.assigned_match_percent,
            scouted_percent: quickMetrics.scouted_match_percent,
            missed_shifts: quickMetrics.missed_shifts,
            missed_shift_percent: quickMetrics.missed_shift_percent
          },
          overall: {
            assigned_percent: pct(
              dataMetrics.assigned_matches + noteMetrics.assigned_matches,
              Math.max(1, totalMatches * 2)
            ),
            scouted_percent: pct(
              dataMetrics.scouted_matches + noteMetrics.scouted_matches,
              Math.max(1, totalMatches * 2)
            ),
            missed_shift_percent: pct(
              dataMetrics.missed_shifts + noteMetrics.missed_shifts,
              Math.max(1, dataMetrics.assigned_slots + noteMetrics.assigned_slots)
            )
          }
        },
        missed_matches: missedMatches,
        smart_fuel_model: smartFuelModel,
        quick_scout_model: quickScoutModel
      }
    });
  } catch (e) {
    return json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}

export async function POST({ request }) {
  try {
    const body = await request.json();
    const action = String(body?.action || '');

    const authSupa = getClientFromRequest(request);
    const { actorId, profile } = await fetchActorProfile(authSupa);
    const db = getSupabase();
    const actorRosterKeys = actorId ? await fetchRosterKeysForUser(db, actorId) : [];
    if (!actorId) return json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageScouting(profile, actorRosterKeys)) return json({ error: 'Forbidden' }, { status: 403 });

    if (action === 'update-event-key') {
      const eventKey = String(body?.event_key || '').trim();
      if (!eventKey) return json({ error: 'event_key is required' }, { status: 400 });

      const { data, error } = await db
        .from('scouting_settings')
        .upsert({ id: 1, event_key: eventKey, updated_by: actorId, updated_at: new Date().toISOString() }, { onConflict: 'id' })
        .select('event_key')
        .single();

      if (error) return json({ error: error.message }, { status: 500 });
      return json({ success: true, data: { event_key: data?.event_key || eventKey } });
    }

    if (action === 'update-smart-fuel-algorithm') {
      const enabled = !!body?.enabled;
      const update = await db
        .from('scouting_settings')
        .upsert(
          {
            id: 1,
            smart_fuel_algorithm_enabled: enabled,
            updated_by: actorId,
            updated_at: new Date().toISOString()
          },
          { onConflict: 'id' }
        )
        .select('smart_fuel_algorithm_enabled')
        .single();

      if (update.error) {
        return json(
          {
            error:
              update.error.message ||
              'Failed to update smart_fuel_algorithm_enabled. Run the latest migration first.'
          },
          { status: 500 }
        );
      }

      return json({
        success: true,
        data: {
          smart_fuel_algorithm_enabled: !!update.data?.smart_fuel_algorithm_enabled
        }
      });
    }

    if (action === 'update-google-sheet-id') {
      // Empty string is valid input here - clears the configured sheet
      // (turns the sync back off) rather than being rejected like a blank
      // event_key is above, since "no sheet configured" is this feature's
      // normal off state, not an error condition.
      const sheetId = String(body?.google_sheet_id ?? '').trim();
      const { data, error } = await db
        .from('scouting_settings')
        .upsert(
          { id: 1, google_sheet_id: sheetId || null, updated_by: actorId, updated_at: new Date().toISOString() },
          { onConflict: 'id' }
        )
        .select('google_sheet_id')
        .single();
      if (error) return json({ error: error.message }, { status: 500 });
      return json({ success: true, data: { google_sheet_id: data?.google_sheet_id || null } });
    }

    if (action === 'sync-scouting-sheet') {
      const result = await syncScoutingDataToSheet();
      return json({ success: result.ok, data: result });
    }

    if (action === 'delete-all-scouting-data') {
      const cleared = await clearAllScoutingData(db);
      return json({
        success: true,
        data: cleared
      });
    }

    if (action !== 'update-competition-role') {
      return json({ error: 'Invalid action' }, { status: 400 });
    }

    const targetUserId = String(body?.target_user_id || '').trim();
    const competitionRoleRaw = body?.competition_role;
    const competitionRole = competitionRoleRaw === null || competitionRoleRaw === '' ? null : String(competitionRoleRaw).trim();
    const frcTeamRaw = body?.frc_team;
    const frcTeam = frcTeamRaw === null || frcTeamRaw === '' ? null : String(frcTeamRaw).trim();

    if (!targetUserId) return json({ error: 'target_user_id is required' }, { status: 400 });
    if (competitionRole !== null && !COMPETITION_ROLE_PRIORITY.includes(competitionRole)) {
      return json({ error: 'Invalid competition_role' }, { status: 400 });
    }
    if (frcTeam !== null && !ALL_FRC_TEAMS.has(frcTeam)) return json({ error: 'Invalid frc_team' }, { status: 400 });

    const { data: profileData, error: profileError } = await db
      .from('user_profiles')
      .update({ frc_team: frcTeam })
      .eq('id', targetUserId)
      .select('id, full_name, email, frc_team')
      .single();

    if (profileError) return json({ error: profileError.message }, { status: 500 });

    const roleKeyMap = await ensureCompetitionRoleKeys(db);
    const availableRoleNames = [...COMPETITION_ROLE_PRIORITY];
    const roleKeyIds = availableRoleNames
      .map((name) => roleKeyMap.get(name)?.id || null)
      .filter(Boolean);

    const { data: existingEntries, error: existingError } = roleKeyIds.length
      ? await db
          .from('roster_entries')
          .select('id, key_id')
          .eq('user_id', targetUserId)
          .in('key_id', roleKeyIds)
      : { data: [], error: null };

    if (existingError) return json({ error: existingError.message }, { status: 500 });

    const selectedRoleKey = competitionRole ? roleKeyMap.get(competitionRole) || null : null;
    if (competitionRole && !selectedRoleKey) {
      return json({ error: `Missing roster key for role "${competitionRole}". Add scouting keys in Admin > Roster Studio.` }, { status: 400 });
    }

    const keepKeyId = selectedRoleKey?.id || null;
    const entriesToDelete = (existingEntries || []).filter((entry) => entry.key_id !== keepKeyId);

    for (const entry of entriesToDelete) {
      const { error: delErr } = await db.from('roster_entries').delete().eq('id', entry.id);
      if (delErr) return json({ error: delErr.message }, { status: 500 });
    }

    const hasSelectedEntry = keepKeyId
      ? (existingEntries || []).some((entry) => entry.key_id === keepKeyId)
      : false;

    if (selectedRoleKey && !hasSelectedEntry) {
      const { error: insertErr } = await db.from('roster_entries').insert([
        {
          roster_id: selectedRoleKey.roster_id,
          user_id: targetUserId,
          key_id: selectedRoleKey.id
        }
      ]);

      if (insertErr) return json({ error: insertErr.message }, { status: 500 });
    }

    return json({
      success: true,
      data: {
        ...profileData,
        competition_role: competitionRole
      }
    });
  } catch (e) {
    return json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
