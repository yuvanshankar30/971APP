// A friendly, play-points prediction market: scouts wager on which alliance
// wins an upcoming match. No house edge - winners split the losing side's
// stakes proportionally (pari-mutuel), same mechanic real horse-racing pools
// use, chosen specifically because it needs no pre-set odds/win probability
// to be fair. Ranks "who has the best judgement" by ending balance, which is
// the whole point: it rewards being right and sizing predictions well, not just
// being right often.

export const STARTING_BALANCE = 1000;
export const TEST_MARKET_SUFFIX = 'test1';

const FALLBACK_TEST_TEAMS = ['frc971', 'frc254', 'frc1678', 'frc1323', 'frc604', 'frc581'];

export function testMarketKey(eventKey) {
  return `${String(eventKey || '').trim()}_${TEST_MARKET_SUFFIX}`;
}

export function isTestMarketKey(matchKey, eventKey = '') {
  const key = String(matchKey || '');
  return eventKey ? key === testMarketKey(eventKey) : key.endsWith(`_${TEST_MARKET_SUFFIX}`);
}

// A permanent practice row lets scouts exercise placing, updating, and
// cancelling predictions before TBA publishes an event schedule. It never
// resolves, so practice activity cannot change the ranked point balance.
export function buildTestMarketMatch(eventKey, eventTeams = []) {
  const supplied = eventTeams.map((team) => typeof team === 'string' ? team : team?.key).filter(Boolean);
  const teamKeys = [...new Set([...supplied, ...FALLBACK_TEST_TEAMS])].slice(0, 6);
  return {
    key: testMarketKey(eventKey),
    comp_level: 'test',
    set_number: 1,
    match_number: 1,
    actual_time: null,
    predicted_time: null,
    time: null,
    is_test_market: true,
    alliances: {
      red: { team_keys: teamKeys.slice(0, 3), score: -1 },
      blue: { team_keys: teamKeys.slice(3, 6), score: -1 }
    }
  };
}

// Given every bet placed on ONE match and that match's resolved winning
// side, returns each bet's payout. Pure and match-scoped - the caller is
// responsible for grouping bets by match_key before calling this.
//
// winningSide: 'red' | 'blue' normally; '' (TBA's own encoding for a tie) or
// anything else falls back to a full refund - nobody profits or loses on a
// match with no clear winner.
export function resolvePariMutuel(bets = [], winningSide) {
  if (winningSide !== 'red' && winningSide !== 'blue') {
    return bets.map((bet) => ({ id: bet.id, payout: bet.stake, winning_side: winningSide || null }));
  }

  const winners = bets.filter((bet) => bet.side === winningSide);
  const winPool = winners.reduce((sum, bet) => sum + bet.stake, 0);
  const losePool = bets.filter((bet) => bet.side !== winningSide).reduce((sum, bet) => sum + bet.stake, 0);

  // Nobody picked the winning side - there is no one to award the losing
  // pool to. Refund instead of letting it vanish or crediting the house
  // (there is no house).
  if (winPool <= 0) {
    return bets.map((bet) => ({ id: bet.id, payout: bet.stake, winning_side: winningSide }));
  }

  return bets.map((bet) => {
    if (bet.side !== winningSide) return { id: bet.id, payout: 0, winning_side: winningSide };
    const share = bet.stake / winPool;
    return { id: bet.id, payout: Math.round((bet.stake + share * losePool) * 100) / 100, winning_side: winningSide };
  });
}

// One leaderboard row per scout. Settled balance only counts resolved bets -
// an unresolved wager is neither a win nor a loss yet, so it cannot move the
// number the candy prize gets decided on. pendingStake surfaces separately
// so a big outstanding bet is still visible before it resolves.
export function summarizeStandings(bets = []) {
  const byScout = new Map();
  for (const bet of bets) {
    if (isTestMarketKey(bet?.match_key)) continue;
    const key = bet?.created_by;
    if (!key) continue;
    if (!byScout.has(key)) byScout.set(key, { userId: key, settledNet: 0, pendingStake: 0, wins: 0, losses: 0, pushes: 0, betCount: 0 });
    const row = byScout.get(key);
    row.betCount += 1;
    if (bet.resolved_at) {
      const net = Number(bet.payout ?? 0) - Number(bet.stake ?? 0);
      row.settledNet += net;
      if (net > 0) row.wins += 1;
      else if (net < 0) row.losses += 1;
      else row.pushes += 1;
    } else {
      row.pendingStake += Number(bet.stake ?? 0);
    }
  }

  return [...byScout.values()]
    .map((row) => ({ ...row, balance: STARTING_BALANCE + row.settledNet }))
    .sort((a, b) => b.balance - a.balance || b.wins - a.wins);
}

export function myBetForMatch(bets = [], matchKey, userId) {
  if (!userId) return null;
  return bets.find((bet) => bet.match_key === matchKey && bet.created_by === userId) || null;
}

// A scout's current spendable balance for placing a NEW bet: starting points,
// plus/minus every settled result, minus whatever they already have locked
// up in bets that have not resolved yet (excluding one bet being edited, so
// raising or lowering an existing wager checks against the right ceiling).
export function availableBalance(bets = [], userId, excludeBetId = null) {
  let settledNet = 0;
  let pendingStake = 0;
  for (const bet of bets) {
    if (bet.created_by !== userId) continue;
    if (isTestMarketKey(bet.match_key)) continue;
    if (bet.id === excludeBetId) continue;
    if (bet.resolved_at) settledNet += Number(bet.payout ?? 0) - Number(bet.stake ?? 0);
    else pendingStake += Number(bet.stake ?? 0);
  }
  return STARTING_BALANCE + settledNet - pendingStake;
}

// Replays one match's bets in the order they were actually placed so the
// implied red-side share can be charted over time, the same "odds moved as
// the crowd weighed in" line real prediction markets show. Built entirely
// from data already on each bet row (placed_at, side, stake) - no new
// schema or history table needed. A bet that was later edited or cancelled
// only shows its FINAL stake at its ORIGINAL placed_at (bets are one
// editable row per scout, not an append-only ledger), so this is a
// reasonable reconstruction, not a perfectly exact replay.
export function oddsHistoryForMatch(bets = [], matchKey) {
  const matchBets = (bets || [])
    .filter((bet) => bet.match_key === matchKey && (bet.side === 'red' || bet.side === 'blue'))
    .slice()
    .sort((a, b) => String(a.placed_at).localeCompare(String(b.placed_at)));
  const history = [];
  let redPool = 0;
  let bluePool = 0;
  for (const bet of matchBets) {
    if (bet.side === 'red') redPool += Number(bet.stake || 0);
    else bluePool += Number(bet.stake || 0);
    const total = redPool + bluePool;
    history.push({ at: bet.placed_at, redShare: total > 0 ? redPool / total : 0.5, total });
  }
  return history;
}

// One scout's running point balance over time, from STARTING_BALANCE
// through each of their bets in the order it actually resolved - the same
// idea as a portfolio-value-over-time chart, built from settled bets alone
// since an unresolved bet hasn't moved the balance yet.
export function balanceHistoryForUser(bets = [], userId) {
  const resolved = (bets || [])
    .filter((bet) => bet.created_by === userId && bet.resolved_at && !isTestMarketKey(bet.match_key))
    .slice()
    .sort((a, b) => String(a.resolved_at).localeCompare(String(b.resolved_at)));
  let balance = STARTING_BALANCE;
  const history = [{ at: null, balance, matchKey: null }];
  for (const bet of resolved) {
    balance += Number(bet.payout ?? 0) - Number(bet.stake ?? 0);
    history.push({ at: bet.resolved_at, balance, matchKey: bet.match_key });
  }
  return history;
}

// How much is currently staked on each side of ONE match, and what that
// implies about the "crowd's" confidence - real signal a scout can weigh
// before placing their own bet, the same way real prediction/betting
// markets surface pool sizes rather than a single house-set number.
export function poolForMatch(bets = [], matchKey) {
  const matchBets = bets.filter((bet) => bet.match_key === matchKey);
  const redPool = matchBets.filter((bet) => bet.side === 'red').reduce((sum, bet) => sum + Number(bet.stake || 0), 0);
  const bluePool = matchBets.filter((bet) => bet.side === 'blue').reduce((sum, bet) => sum + Number(bet.stake || 0), 0);
  const total = redPool + bluePool;
  return {
    redPool,
    bluePool,
    total,
    redShare: total > 0 ? redPool / total : null,
    blueShare: total > 0 ? bluePool / total : null,
    betCount: matchBets.length
  };
}
