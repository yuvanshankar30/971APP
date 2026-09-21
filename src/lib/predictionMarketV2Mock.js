// Mock data shaped exactly like the backend contract in
// docs/changes/PREDICTION_MARKET_V2_PLAN.md's "Interface contract" section
// - the UI is being built against this while the real /api/prediction-
// market-v2/* endpoints are built in parallel (see that plan doc). Every
// shape here should disappear in favor of a real fetch() once the backend
// PR lands; nothing here should leak into how components are structured
// (components read whatever shape the real API returns, this just
// supplies that shape for now).

const TEAMS = {
  frc971: '971', frc9584: '9584', frc254: '254', frc604: '604', frc1678: '1678',
  frc846: '846', frc4414: '4414', frc1323: '1323', frc114: '114', frc649: '649',
  frc840: '840', frc1868: '1868', frc7308: '7308', frc4159: '4159'
};

export const MOCK_EVENT = { event_key: '2026casj', name: 'Chezy Champs', teams_present: ['971', '9584'] };

export const MOCK_ELO = { elo: 1042, elo_delta_event: 18, active_predictions: 1, accuracy: 0.64, scored_predictions: 11 };

function match(key, red, blue, prob, status = 'upcoming', myPick = null) {
  return {
    match_key: key,
    red_teams: red,
    blue_teams: blue,
    model_probability_red: prob,
    my_pick: myPick,
    community_red_pct: Math.round((prob + (Math.random() * 0.14 - 0.07)) * 100) / 100,
    community_blue_pct: null,
    status
  };
}

export const MOCK_MATCHES = [
  match('qm34', ['254', '971', '604'], ['1678', '4414', '1323'], 0.59, 'upcoming'),
  match('qm35', ['114', '649', '840'], ['1868', '7308', '4159'], 0.77, 'upcoming'),
  match('qm36', ['1678', '971', '846'], ['254', '604', '7419'], 0.68, 'upcoming'),
  match('qm37', ['4414', '1323', '7308'], ['114', '1868', '649'], 0.68, 'upcoming'),
  match('qm25', ['254', '971', '604'], ['1678', '4414', '1323'], 0.411, 'complete', 'red'),
  match('qm18', ['67', '33', '2767'], ['1918', '3538', '3620'], 0.66, 'complete', 'red'),
  match('qm19', ['2054', '1718', '107'], ['67', '1918', '2767'], 0.92, 'complete', 'red'),
  match('qm20', ['33', '3538', '3620'], ['2054', '1718', '107'], 0.58, 'complete', 'blue')
].map((m) => ({ ...m, community_blue_pct: Math.round((1 - m.community_red_pct) * 100) / 100 }));

export function findMockMatch(key) {
  return MOCK_MATCHES.find((m) => m.match_key === key) || null;
}

export const MOCK_MATCH_DETAIL = {
  match_key: 'qm34',
  red_teams: ['254', '971', '604'],
  blue_teams: ['1678', '4414', '1323'],
  model_probability_red: 0.411,
  my_pick: 'red',
  model_probability_at_my_pick: 0.411,
  community_breakdown: { red: 34, blue: 27, total: 61 },
  elo_history_series: [
    { t: '−45m', model_prob: 0.41, community_prob: 0.55 },
    { t: '−30m', model_prob: 0.41, community_prob: 0.53 },
    { t: '−15m', model_prob: 0.41, community_prob: 0.54 },
    { t: 'now', model_prob: 0.41, community_prob: 0.56 }
  ]
};

export const MOCK_LEADERBOARD = [
  { user_id: 'u1', name: 'Bigadult27', elo: 1284, wins: 19, losses: 6 },
  { user_id: 'u2', name: 'Lightning', elo: 1042, wins: 11, losses: 6 },
  { user_id: 'u3', name: 'CircuitBreaker', elo: 998, wins: 9, losses: 8 },
  { user_id: 'u4', name: 'TorqueWrench', elo: 947, wins: 8, losses: 9 },
  { user_id: 'u5', name: 'GearHead971', elo: 1000, wins: 0, losses: 0 }
];

export const MOCK_MY_PICKS = [
  { match_key: 'qm34', side: 'red', locked: false, model_probability_at_pick: 0.411 },
  { match_key: 'qm25', side: 'red', locked: true, result: 'won', elo_delta: 12 },
  { match_key: 'qm18', side: 'red', locked: true, result: 'won', elo_delta: 6 },
  { match_key: 'qm19', side: 'red', locked: true, result: 'lost', elo_delta: -22 }
];

export const MOCK_LIVE_FEED = [
  { user: 'Lightning', side: 'red', match_key: '2026casj_qm34', t: 'now' },
  { user: 'Bigadult27', side: 'red', match_key: '2026miket_qm20', t: '1m' },
  { user: 'Bigadult27', side: 'blue', match_key: '2026miket_qm19', t: '3m' },
  { user: 'Bigadult27', side: 'red', match_key: '2026miket_qm18', t: '4m' },
  { user: 'Bigadult27', side: 'red', match_key: '2026casj_qm37', t: '6m' },
  { user: 'Bigadult27', side: 'red', match_key: '2026casj_qm36', t: '7m' },
  { user: 'Bigadult27', side: 'blue', match_key: '2026casj_qm35', t: '9m' }
];

export const MOCK_ALLIANCE_DRAFT = {
  event_key: '2026casj',
  seeds: ['971', '254', '1678', '604', '4414', '846', '1323', '649'],
  picks: [
    { pick_round: 1, captain: '971', predicted_pick: '604', locked: false },
    { pick_round: 1, captain: '254', predicted_pick: '1868', locked: false }
  ]
};
