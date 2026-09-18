import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { normalizeTeamKey } from '$lib/server/matchScoutingSchema.js';
import { visionMatchKeys } from '$lib/scoutingComparison.js';
import { buildVisionMatchScoutSuggestions } from '$lib/visionMatchScoutSuggestions.js';

function clientFor(request) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
}

export async function GET({ request, url }) {
  const client = clientFor(request);
  const { data: auth } = await client.auth.getUser();
  if (!auth?.user) return json({ error: 'Unauthorized' }, { status: 401 });

  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  const matchKey = String(url.searchParams.get('match_key') || '').trim();
  const teamKey = normalizeTeamKey(url.searchParams.get('team_key'));
  if (!eventKey || !matchKey || !teamKey) return json({ error: 'event_key, match_key, and a valid team_key are required' }, { status: 400 });

  try {
    const { data: matches, error: matchError } = await client.from('vision_matches')
      .select('id, match_key').eq('event_key', eventKey).in('match_key', visionMatchKeys(eventKey, matchKey));
    if (matchError) throw matchError;
    if (!matches?.length) return json({ success: true, data: { run: null, fields: {}, evidence: {}, reviewed: false } });

    const { data: runs, error: runError } = await client.from('vision_runs')
      .select('id, vision_match_id, status, model_name, model_version, config, completed_at, created_at')
      .in('vision_match_id', matches.map(match => match.id)).eq('status', 'complete').order('completed_at', { ascending: false });
    if (runError) throw runError;
    if (!runs?.length) return json({ success: true, data: { run: null, fields: {}, evidence: {}, reviewed: false } });

    // A newer rerun can still be awaiting review. Keep it visible in Vision
    // Scouting, but do not hide an earlier completed run that already has
    // reviewed evidence the match scout can use.
    const runIds = runs.map(run => run.id);
    const [observationResult, trackResult] = await Promise.all([
      client.from('vision_observations').select('*').in('vision_run_id', runIds).eq('team_key', teamKey).in('review_status', ['accepted', 'corrected']).order('started_ms'),
      client.from('vision_tracks').select('*').in('vision_run_id', runIds).eq('team_key', teamKey)
    ]);
    if (observationResult.error) throw observationResult.error;
    if (trackResult.error) throw trackResult.error;
    const suggestions = runs.map(run => ({
      run,
      suggestion: buildVisionMatchScoutSuggestions({
        run, teamKey,
        tracks: (trackResult.data || []).filter(track => track.vision_run_id === run.id),
        observations: (observationResult.data || []).filter(observation => observation.vision_run_id === run.id)
      })
    }));
    const chosen = suggestions.find(entry => Object.keys(entry.suggestion.fields).length) || suggestions.find(entry => entry.suggestion.reviewed) || suggestions[0];
    return json({ success: true, data: {
      run: { id: chosen.run.id, model_name: chosen.run.model_name, model_version: chosen.run.model_version, completed_at: chosen.run.completed_at },
      ...chosen.suggestion
    } });
  } catch (error) {
    return json({ error: error.message || 'Could not load reviewed vision suggestions' }, { status: 500 });
  }
}
