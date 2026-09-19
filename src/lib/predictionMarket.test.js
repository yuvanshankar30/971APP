import { describe, expect, it } from 'vitest';
import { STARTING_BALANCE, availableBalance, balanceHistoryForUser, buildTestMarketMatch, isTestMarketKey, myBetForMatch, oddsHistoryForMatch, poolForMatch, resolvePariMutuel, summarizeStandings } from './predictionMarket.js';

describe('test prediction market', () => {
  it('uses the active event roster and a stable event-scoped key', () => {
    const match = buildTestMarketMatch('2026test', ['frc1', 'frc2', 'frc3', 'frc4', 'frc5', 'frc6']);
    expect(match.key).toBe('2026test_test1');
    expect(match.alliances.red.team_keys).toEqual(['frc1', 'frc2', 'frc3']);
    expect(match.alliances.blue.team_keys).toEqual(['frc4', 'frc5', 'frc6']);
    expect(isTestMarketKey(match.key, '2026test')).toBe(true);
    expect(match.actual_time).toBeNull();
  });
});

describe('resolvePariMutuel', () => {
  it('pays winners their stake back plus a proportional share of the losing pool', () => {
    const bets = [
      { id: 'a', created_by: 'a', side: 'red', stake: 100 },
      { id: 'b', created_by: 'b', side: 'red', stake: 300 },
      { id: 'c', created_by: 'c', side: 'blue', stake: 200 }
    ];
    const result = resolvePariMutuel(bets, 'red');
    // winPool=400, losePool=200. a's share=100/400=0.25 -> +50 -> payout 150.
    expect(result.find((r) => r.id === 'a')).toMatchObject({ payout: 150, winning_side: 'red' });
    // b's share=300/400=0.75 -> +150 -> payout 450.
    expect(result.find((r) => r.id === 'b')).toMatchObject({ payout: 450, winning_side: 'red' });
    expect(result.find((r) => r.id === 'c')).toMatchObject({ payout: 0, winning_side: 'red' });
    // Conservation of money: total paid out equals total staked.
    const totalStaked = bets.reduce((sum, bet) => sum + bet.stake, 0);
    const totalPaid = result.reduce((sum, row) => sum + row.payout, 0);
    expect(totalPaid).toBe(totalStaked);
  });

  it('refunds everyone when nobody picked the winning side', () => {
    const bets = [
      { id: 'a', created_by: 'a', side: 'blue', stake: 100 },
      { id: 'b', created_by: 'b', side: 'blue', stake: 50 }
    ];
    const result = resolvePariMutuel(bets, 'red');
    expect(result).toEqual([
      { id: 'a', payout: 100, winning_side: 'red' },
      { id: 'b', payout: 50, winning_side: 'red' }
    ]);
  });

  it('refunds everyone on a tie/no-result instead of guessing a side', () => {
    const bets = [{ id: 'a', created_by: 'a', side: 'red', stake: 80 }];
    expect(resolvePariMutuel(bets, '')).toEqual([{ id: 'a', payout: 80, winning_side: null }]);
  });
});

describe('summarizeStandings', () => {
  const bets = [
    { created_by: 'a', side: 'red', stake: 100, resolved_at: '2026-09-15T00:00:00Z', payout: 150 }, // +50
    { created_by: 'a', side: 'blue', stake: 50, resolved_at: null }, // pending
    { created_by: 'b', side: 'blue', stake: 200, resolved_at: '2026-09-15T00:00:00Z', payout: 0 } // -200
  ];

  it('only lets settled bets move the ranked balance', () => {
    const standings = summarizeStandings(bets);
    const a = standings.find((row) => row.userId === 'a');
    const b = standings.find((row) => row.userId === 'b');
    expect(a.balance).toBe(STARTING_BALANCE + 50);
    expect(a.pendingStake).toBe(50);
    expect(b.balance).toBe(STARTING_BALANCE - 200);
    expect(standings[0].userId).toBe('a'); // sorted highest balance first
  });

  it('counts wins and losses from settled net, not raw payout', () => {
    const standings = summarizeStandings(bets);
    expect(standings.find((row) => row.userId === 'a').wins).toBe(1);
    expect(standings.find((row) => row.userId === 'b').losses).toBe(1);
  });

  it('keeps practice predictions out of standings and balances', () => {
    const practice = [{ id: 'test', match_key: '2026test_test1', created_by: 'a', side: 'red', stake: 900, resolved_at: null }];
    expect(summarizeStandings(practice)).toEqual([]);
    expect(availableBalance(practice, 'a')).toBe(STARTING_BALANCE);
  });
});

describe('myBetForMatch', () => {
  const bets = [{ match_key: 'm1', created_by: 'a', side: 'red', stake: 10 }];
  it('finds a scout\'s own bet for a match, or null', () => {
    expect(myBetForMatch(bets, 'm1', 'a')).toMatchObject({ side: 'red' });
    expect(myBetForMatch(bets, 'm1', 'b')).toBeNull();
  });
});

describe('availableBalance', () => {
  it('subtracts pending stakes and adds settled net, excluding the bet being edited', () => {
    const bets = [
      { id: '1', created_by: 'a', stake: 100, resolved_at: '2026-09-15T00:00:00Z', payout: 150 },
      { id: '2', created_by: 'a', stake: 300, resolved_at: null }
    ];
    expect(availableBalance(bets, 'a')).toBe(STARTING_BALANCE + 50 - 300);
    // Editing bet '2' itself shouldn't count its own stake against the ceiling.
    expect(availableBalance(bets, 'a', '2')).toBe(STARTING_BALANCE + 50);
  });
});

describe('poolForMatch', () => {
  it('sums stakes per side and computes the implied crowd share', () => {
    const bets = [
      { match_key: 'm1', side: 'red', stake: 300 },
      { match_key: 'm1', side: 'red', stake: 100 },
      { match_key: 'm1', side: 'blue', stake: 200 },
      { match_key: 'm2', side: 'blue', stake: 999 } // a different match - must not leak in
    ];
    const pool = poolForMatch(bets, 'm1');
    expect(pool).toMatchObject({ redPool: 400, bluePool: 200, total: 600, betCount: 3 });
    expect(pool.redShare).toBeCloseTo(2 / 3, 5);
    expect(pool.blueShare).toBeCloseTo(1 / 3, 5);
  });

  it('reports no share (not a divide-by-zero) when nobody has bet on the match yet', () => {
    const pool = poolForMatch([], 'm1');
    expect(pool).toMatchObject({ redPool: 0, bluePool: 0, total: 0, betCount: 0, redShare: null, blueShare: null });
  });
});

describe('oddsHistoryForMatch', () => {
  it('replays bets in placed_at order into a running implied red share', () => {
    const bets = [
      { match_key: 'm1', side: 'blue', stake: 100, placed_at: '2026-09-19T10:02:00Z' },
      { match_key: 'm1', side: 'red', stake: 100, placed_at: '2026-09-19T10:00:00Z' },
      { match_key: 'm2', side: 'red', stake: 500, placed_at: '2026-09-19T09:00:00Z' } // different match, must not leak in
    ];
    const history = oddsHistoryForMatch(bets, 'm1');
    expect(history).toHaveLength(2);
    // First bet placed (by time, not array order) was red - 100% red share.
    expect(history[0]).toMatchObject({ redShare: 1, total: 100 });
    // Then a blue bet arrives, evening the pool to 50/50.
    expect(history[1]).toMatchObject({ redShare: 0.5, total: 200 });
  });

  it('returns an empty history when nobody has bet on the match yet', () => {
    expect(oddsHistoryForMatch([], 'm1')).toEqual([]);
  });
});

describe('balanceHistoryForUser', () => {
  it('starts at STARTING_BALANCE and walks resolved bets in resolution order', () => {
    const bets = [
      { created_by: 'u1', match_key: 'm2', stake: 100, payout: 0, resolved_at: '2026-09-19T12:00:00Z' },
      { created_by: 'u1', match_key: 'm1', stake: 100, payout: 250, resolved_at: '2026-09-19T10:00:00Z' },
      { created_by: 'u1', match_key: 'm3', stake: 50, payout: 50, resolved_at: null }, // unresolved - must not count yet
      { created_by: 'u2', match_key: 'm1', stake: 999, payout: 0, resolved_at: '2026-09-19T09:00:00Z' } // different scout
    ];
    const history = balanceHistoryForUser(bets, 'u1');
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({ balance: STARTING_BALANCE, at: null });
    // m1 resolved first (10:00) - +150 net.
    expect(history[1]).toMatchObject({ balance: STARTING_BALANCE + 150, matchKey: 'm1' });
    // m2 resolved second (12:00) - -100 net.
    expect(history[2]).toMatchObject({ balance: STARTING_BALANCE + 150 - 100, matchKey: 'm2' });
  });

  it('is just the starting balance for a scout with no resolved bets', () => {
    expect(balanceHistoryForUser([], 'u1')).toEqual([{ at: null, balance: STARTING_BALANCE, matchKey: null }]);
  });
});
