import { matchVideoSources } from '$lib/tbaMedia.js';

function firstFinite(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function firstMatchingFinite(object, pattern) {
  for (const [key, value] of Object.entries(object || {})) {
    if (pattern.test(key) && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function climbCount(breakdown) {
  if (!breakdown) return null;
  const explicit = firstFinite(breakdown, ['climbCount', 'endGameClimbCount', 'endgameClimbCount']);
  if (explicit != null) return explicit;
  const statuses = Object.entries(breakdown)
    .filter(([key]) => /(?:endgame|climb|tower).*robot/i.test(key))
    .map(([, value]) => String(value || '').toLowerCase());
  return statuses.length ? statuses.filter((value) => !['none', 'no', 'failed', 'parked'].includes(value)).length : null;
}

export function referenceFromTbaMatch(match) {
  const output = { matchKey: match?.key || null, alliances: {} };
  for (const color of ['red', 'blue']) {
    const breakdown = match?.score_breakdown?.[color] || {};
    output.alliances[color] = {
      teamKeys: match?.alliances?.[color]?.team_keys || [],
      totalScore: match?.alliances?.[color]?.score ?? null,
      fuel: firstFinite(breakdown, ['fuelPoints', 'totalFuelPoints', 'totalFuel', 'fuelCount', 'hubPoints'])
        ?? firstMatchingFinite(breakdown, /(?:^|total)(?:fuel|hub).*(?:points|count)?$/i),
      climbs: climbCount(breakdown),
      breakdown
    };
  }
  return output;
}

// The six teams in a match, per alliance, in driver-station order. Separate
// from referenceFromTbaMatch because the roster is useful long before a match
// is played (it drives identity assignment during review) while the score
// breakdown only exists afterwards.
export function rosterFromTbaMatch(match) {
  const roster = {};
  for (const color of ['red', 'blue']) {
    const teamKeys = match?.alliances?.[color]?.team_keys;
    roster[color] = Array.isArray(teamKeys) ? teamKeys.filter((key) => typeof key === 'string' && key) : [];
  }
  if (!roster.red.length && !roster.blue.length) return null;
  roster.fetched_at = new Date().toISOString();
  return roster;
}

export async function fetchTbaMatchRoster(matchKey, authKey, fetchImpl = fetch) {
  if (!matchKey || !authKey) return null;
  try {
    const response = await fetchImpl(`https://www.thebluealliance.com/api/v3/match/${encodeURIComponent(matchKey)}`, {
      headers: { 'X-TBA-Auth-Key': authKey }
    });
    if (!response.ok) return null;
    return rosterFromTbaMatch(await response.json());
  } catch (error) {
    // A missing key, an offline venue, or a match TBA doesn't know about yet
    // must never block creating the match - review just falls back to typing
    // the team number by hand.
    console.warn('fetchTbaMatchRoster failed', error?.message || error);
    return null;
  }
}

export async function fetchTbaMatchReference(matchKey, authKey, fetchImpl = fetch) {
  if (!matchKey || !authKey) return null;
  const response = await fetchImpl(`https://www.thebluealliance.com/api/v3/match/${encodeURIComponent(matchKey)}`, {
    headers: { 'X-TBA-Auth-Key': authKey }
  });
  if (!response.ok) return null;
  return referenceFromTbaMatch(await response.json());
}

export async function fetchTbaMatchVideoSources(matchKey, authKey, fetchImpl = fetch) {
  if (!matchKey || !authKey) return null;
  try {
    const response = await fetchImpl(`https://www.thebluealliance.com/api/v3/match/${encodeURIComponent(matchKey)}`, {
      headers: { 'X-TBA-Auth-Key': authKey }
    });
    if (!response.ok) return null;
    return matchVideoSources(await response.json());
  } catch (error) {
    console.warn('fetchTbaMatchVideoSources failed', error?.message || error);
    return null;
  }
}
