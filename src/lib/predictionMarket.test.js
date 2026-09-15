import { describe, expect, it } from 'vitest';
import { STARTING_BALANCE, availableBalance, myBetForMatch, resolvePariMutuel, summarizeStandings } from './predictionMarket.js';

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
