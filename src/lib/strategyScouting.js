import { parseAutoPointsEstimate } from '$lib/matchScouting.js';
import { summarizeMatchScoutEntries, summarizeTeamPerformance } from '$lib/scoutingStats.js';

export function strategyTeamNumber(teamKey) {
  return String(teamKey || '').replace(/^frc/i, '') || 'Unknown';
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function autoEstimate(entry) {
  const stored = Number(entry?.auto_points_average);
  if (entry?.auto_points_average != null && Number.isFinite(stored)) return stored;
  return parseAutoPointsEstimate(entry?.auto_points_band)?.average ?? null;
}

function groupByTeam(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!row?.team_key) continue;
    if (!groups.has(row.team_key)) groups.set(row.team_key, []);
    groups.get(row.team_key).push(row);
  }
  return groups;
}

// One decision-oriented row per team. This deliberately references raw report
// rows rather than creating a second persistence layer, so strategy always
// reflects the observations scouts actually collected.
export function buildStrategyRows(data = {}) {
  const byEvents = groupByTeam(data.data_events);
  const byMatches = groupByTeam(data.match_entries);
  const byPit = groupByTeam(data.pit_entries);
  const byNotes = groupByTeam(data.notes);
  const byAutos = groupByTeam(data.auto_paths);
  const byProblems = groupByTeam(data.pit_problems);
  const keys = new Set([
    ...byEvents.keys(), ...byMatches.keys(), ...byPit.keys(), ...byNotes.keys(), ...byAutos.keys(), ...byProblems.keys()
  ]);

  return [...keys].map((teamKey) => {
    const dataEvents = byEvents.get(teamKey) || [];
    const matchEntries = byMatches.get(teamKey) || [];
    const pitEntries = byPit.get(teamKey) || [];
    const notes = byNotes.get(teamKey) || [];
    const autoPaths = byAutos.get(teamKey) || [];
    const problems = byProblems.get(teamKey) || [];
    const performance = summarizeTeamPerformance(dataEvents);
    const matchScoutSummary = summarizeMatchScoutEntries(matchEntries);
    const autoAverage = average(matchEntries.map(autoEstimate));
    return {
      teamKey,
      teamNumber: strategyTeamNumber(teamKey),
      dataEvents,
      matchEntries,
      pitEntry: pitEntries[0] || null,
      notes,
      autoPaths,
      problems,
      openProblems: problems.filter((problem) => !problem.resolved),
      performance,
      matchScoutSummary,
      autoAverage,
      autoMobilityRate: matchScoutSummary.autoRunRate,
      coverage: dataEvents.length + matchEntries.length + pitEntries.length + notes.length + autoPaths.length
    };
  }).sort((first, second) => Number(first.teamNumber) - Number(second.teamNumber));
}

export function strategyTotals(rows) {
  return {
    teams: rows.length,
    matchReports: rows.reduce((sum, row) => sum + row.matchEntries.length, 0),
    pitProfiles: rows.filter((row) => row.pitEntry).length,
    notes: rows.reduce((sum, row) => sum + row.notes.length, 0),
    autoPaths: rows.reduce((sum, row) => sum + row.autoPaths.length, 0),
    openProblems: rows.reduce((sum, row) => sum + row.openProblems.length, 0)
  };
}
