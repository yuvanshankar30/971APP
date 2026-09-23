// Read the same people, rosters, and role assignments edited on the Admin page.
// Keep auth ids, email addresses, permissions, and account state out of Gemini.
export async function loadHubRoster(supa) {
  const [profiles, rosters, entries] = await Promise.all([
    supa.from('user_profiles').select('id, full_name, team_role'),
    supa.from('rosters').select('id, name'),
    supa.from('roster_entries').select('user_id, roster_id, key:key_id(key_name)')
  ]);
  if (profiles.error || rosters.error || entries.error) throw new Error('Could not read the Hub roster');
  const rosterNames = new Map((rosters.data || []).map((row) => [row.id, row.name]));
  const members = new Map((profiles.data || []).filter((row) => row.full_name).map((row) => [row.id, {
    name: row.full_name,
    teamRole: row.team_role || null,
    roles: []
  }]));
  for (const entry of entries.data || []) {
    const member = members.get(entry.user_id);
    if (member && entry.key?.key_name) {
      member.roles.push(`${rosterNames.get(entry.roster_id) || 'Roster'}: ${entry.key.key_name}`);
    }
  }
  return [...members.values()];
}

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function identifyRosterQuestion(question, members) {
  const text = normalize(question);
  const named = members.filter((member) => {
    const name = normalize(member.name);
    if (name && text.includes(name)) return true;
    const first = name.split(' ')[0];
    return first?.length >= 3 && new RegExp(`\\b${first}\\b`).test(text);
  });
  if (named.length) return { aboutPerson: true, members: named, searchName: null };

  const roleQuestion = text.match(/\bwho (?:is|are) (?:the |our )?(.+?)(?: on (?:the )?team)?$/);
  if (roleQuestion) {
    const role = roleQuestion[1].replace(/\b(on|at) (?:spartans |spartan robotics|team 971|the hub).*$/, '').trim();
    const roleWords = role.split(' ').filter((word) => word.length >= 3);
    const matches = members.filter((member) => roleWords.length > 0 && [member.teamRole, ...member.roles]
      .some((value) => roleWords.every((word) => normalize(value).includes(word))));
    if (matches.length) return { aboutPerson: true, members: matches, searchName: null };
  }

  const personPrompt = text.match(/\b(?:who is|who s|tell me about|what do you think of|what is your opinion of|opinion on)\s+(.+)$/);
  if (personPrompt) return { aboutPerson: true, members: [], searchName: personPrompt[1] };
  const namedUnknown = String(question || '').match(/\b(?:[Ii]s|[Ww]as|[Dd]oes|[Dd]id|[Cc]an|[Cc]ould|[Ss]hould|[Ww]ould)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/);
  if (namedUnknown && normalize(namedUnknown[1]) !== 'spartans hub') {
    return { aboutPerson: true, members: [], searchName: namedUnknown[1] };
  }
  return { aboutPerson: false, members: [], searchName: null };
}
