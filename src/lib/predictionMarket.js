// A friendly, play-money prediction market: scouts wager on which alliance
// wins an upcoming match. No house edge - winners split the losing side's
// stakes proportionally (pari-mutuel), same mechanic real horse-racing pools
// use, chosen specifically because it needs no pre-set odds/win probability
// to be fair. Ranks "who has the best judgement" by ending balance, which is
// the whole point: it rewards being right and sizing bets well, not just
// being right often.

export const STARTING_BALANCE = 1000;

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

// A scout's current spendable balance for placing a NEW bet: starting money,
// plus/minus every settled result, minus whatever they already have locked
// up in bets that have not resolved yet (excluding one bet being edited, so
// raising or lowering an existing wager checks against the right ceiling).
export function availableBalance(bets = [], userId, excludeBetId = null) {
  let settledNet = 0;
  let pendingStake = 0;
  for (const bet of bets) {
    if (bet.created_by !== userId) continue;
    if (bet.id === excludeBetId) continue;
    if (bet.resolved_at) settledNet += Number(bet.payout ?? 0) - Number(bet.stake ?? 0);
    else pendingStake += Number(bet.stake ?? 0);
  }
  return STARTING_BALANCE + settledNet - pendingStake;
}
