import { writable, get } from 'svelte/store';
import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';

// Shared across every /predictions/* page: the layout owns the event
// picker in its topbar, but each page fetches its own data for whichever
// event is selected, so the selection has to live somewhere both can see.
export const pmEvents = writable([]); // current TBA events, see /api/tba/current-events
export const pmEventKey = writable('');
export const pmLoadingEvents = writable(true);

// Any page that fetches elo stats (currently just the Dashboard) can push
// them here so the topbar's Elo badge doesn't need its own duplicate fetch.
export const pmMyElo = writable(null);

export async function loadPmEvents() {
  pmLoadingEvents.set(true);
  const [eventsResult, activeScoutingEventKey] = await Promise.all([
    fetch('/api/tba/current-events').then((res) => res.json()).catch(() => null),
    fetchActiveScoutingEventKey()
  ]);
  const events = eventsResult?.success ? eventsResult.data || [] : [];
  pmEvents.set(events);
  pmLoadingEvents.set(false);

  // Prefer whatever event scouting-admin has marked active, if it's one of
  // the currently-relevant events; otherwise default to the first live
  // event, or just the soonest upcoming one.
  if (!get(pmEventKey)) {
    const preferred = events.find((event) => event.key === activeScoutingEventKey);
    const live = events.find((event) => event.live);
    pmEventKey.set(preferred?.key || live?.key || events[0]?.key || '');
  }
  return events;
}
