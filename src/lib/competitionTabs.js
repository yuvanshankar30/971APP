import { writable } from 'svelte/store';

// The Competition folder outgrew a dropdown - it carries fourteen surfaces,
// which is more than a hover menu can present without becoming a wall of
// text. Pressing it now opens /competition, which lays the same surfaces out
// as tiles with room to say what each one is for.
export const COMPETITION_FOLDER_LABEL = 'Competition';
export const COMPETITION_ROUTE = '/competition';

// Populated by +layout.svelte from the user's OWN resolved nav (saved
// layout, merged defaults, permission gating and all), so the landing page
// always mirrors the folder it replaced instead of being a second list that
// silently drifts out of sync with it.
export const competitionNavChildren = writable([]);

// One line per surface, so a tile says what the thing is rather than just
// repeating its name in a bigger font. Keyed by nav tab key.
export const COMPETITION_TAB_DESCRIPTIONS = {
  strategy: 'Team briefs, alliance notes, and the match-by-match plan',
  driveteam: "The field-facing view of 971's own upcoming matches",
  matchscout: 'Submit and edit match reports for an assigned robot',
  pitscout: 'Robot profiles, mechanisms, and the pit repair queue',
  myscout: 'Every report you have submitted, still editable',
  picklist: 'The shared, drag-to-order alliance selection list',
  matchrankings: 'Live qualification rankings and match results',
  powerrankings: '971 Scout Power - our own ranking, from our own scouts',
  robotratings: 'Head-to-head robot comparisons and star plots',
  epa: 'Expected Points Added, computed from raw TBA match data',
  vision: 'Camera-assisted scouting runs and their review queue',
  predictions: 'Play-point predictions on upcoming match outcomes',
  bluealliance: "Any team's events, rankings, and match schedule",
  'scouting-admin': 'Assignments, event setup, coverage, and data exports'
};

export function competitionTabDescription(key) {
  return COMPETITION_TAB_DESCRIPTIONS[key] || '';
}
