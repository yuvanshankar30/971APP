export async function fetchActiveScoutingEventKey(fetchImpl = fetch) {
  try {
    const res = await fetchImpl('/api/scouting-config');
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) return null;
    return String(data?.data?.event_key || '').trim() || null;
  } catch {
    return null;
  }
}

// Teams a scouting admin typed in manually for the active event (prescouting,
// before an event has a roster on TBA) - see /scouting-admin.
export async function fetchManualScoutingTeams(fetchImpl = fetch) {
  try {
    const res = await fetchImpl('/api/scouting-config');
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) return [];
    return Array.isArray(data?.data?.manual_teams) ? data.data.manual_teams : [];
  } catch {
    return [];
  }
}

// { value, label } options for every past event with real scouting data,
// sorted newest-first - lets scouting pages offer a "browse a past event"
// dropdown alongside the always-current active event key above.
export async function fetchAvailableScoutingEvents(fetchImpl = fetch) {
  try {
    const res = await fetchImpl('/api/scouting-config');
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) return [];
    return Array.isArray(data?.data?.available_events) ? data.data.available_events : [];
  } catch {
    return [];
  }
}
