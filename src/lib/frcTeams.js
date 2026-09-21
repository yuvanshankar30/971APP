import { FRC_TEAMS } from '$lib/permissions.js';

const TEAM_971 = FRC_TEAMS?.TEAM_971 ?? '971';
const TEAM_9584 = FRC_TEAMS?.TEAM_9584 ?? '9584';
const TEAM_MENTOR = FRC_TEAMS?.MENTOR ?? 'Mentor';

export const FRC_TEAM_META = {
  [TEAM_971]: {
    label: 'Team 971',
    shortLabel: '971',
    tagClass: 'tag-971'
  },
  [TEAM_9584]: {
    label: 'Team 9584',
    shortLabel: '9584',
    tagClass: 'tag-9584'
  },
  [TEAM_MENTOR]: {
    label: 'Mentor',
    shortLabel: 'Mentor',
    tagClass: 'tag-mentor'
  }
};

export function getFrcTeamMeta(team) {
  if (!team) return null;
  const meta = FRC_TEAM_META[team];
  if (meta) return meta;
  return {
    label: team,
    shortLabel: team,
    tagClass: 'tag-tonal'
  };
}

export function isTeam9584(team) {
  return Boolean(team) && team === TEAM_9584;
}

// Short team number for display beside a record's name. An unset team means
// 971 - the same bucketing passesTeamFilter() uses - but a Mentor row keeps
// its own label rather than being relabelled as a team it is not.
export function teamShortLabel(team) {
  if (!team) return FRC_TEAM_META[TEAM_971].shortLabel;
  return getFrcTeamMeta(team)?.shortLabel || String(team);
}

// Team-filter buckets: 9584 is explicit; everything else (971 / mentor / unset)
// counts as 971. Returns true when the row passes the current checkbox state.
export function passesTeamFilter(team, show971, show9584) {
  return isTeam9584(team) ? show9584 : show971;
}
