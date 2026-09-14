import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { getSupabase } from '$lib/server/971bot.js';
import { visionMatchKeys } from '$lib/scoutingComparison.js';

export async function GET({ request, url }) {
  const client = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('authorization') || '' } }
  });
  const { data: auth } = await client.auth.getUser();
  if (!auth?.user) return json({ error: 'Unauthorized' }, { status: 401 });
  const id = url.searchParams.get('report_id');
  if (!id) return json({ error: 'report_id is required' }, { status: 400 });
  let db;
  try { db = getSupabase(); } catch { db = client; }
  try {
    // The report ID never grants access to another scout's report.
    const { data: manual, error: manualError } = await db.from('match_scout_entries')
      .select('*').eq('id', id).eq('created_by', auth.user.id).maybeSingle();
    if (manualError) throw manualError;
    if (!manual) return json({ error: 'Report not found' }, { status: 404 });
    const { data: pitProblems, error: pitError } = await db.from('pit_problem_reports')
      .select('id,summary,detail,severity,resolved,created_at')
      .eq('event_key', manual.event_key).eq('team_key', manual.team_key)
      .eq('match_key', manual.match_key).eq('created_by', auth.user.id)
      .eq('source', 'Match scout').order('created_at', { ascending: false });
    if (pitError) throw pitError;
    // Vision reads retain the existing member/RLS access policy.
    const { data: matches, error: matchError } = await client.from('vision_matches')
      .select('id,match_key,status').eq('event_key', manual.event_key)
      .in('match_key', visionMatchKeys(manual.event_key, manual.match_key));
    if (matchError) throw matchError;
    if (!matches?.length) return json({ success: true, data: { manual, pitProblems: pitProblems || [], matches: [], runs: [], run: null, observations: [], tracks: [] } });
    const { data: runs, error: runError } = await client.from('vision_runs')
      .select('id,vision_match_id,status,model_name,model_version,config,created_at,completed_at,released_at')
      .in('vision_match_id', matches.map(match => match.id)).order('created_at', { ascending: false });
    if (runError) throw runError;
    const requested = url.searchParams.get('run_id');
    const run = requested ? runs?.find(row => row.id === requested) : runs?.find(row => row.status === 'complete') || runs?.[0] || null;
    if (requested && !run) return json({ error: 'Vision run does not belong to this match' }, { status: 400 });
    let observations = [], tracks = [];
    if (run) {
      const results = await Promise.all([
        client.from('vision_observations').select('*').eq('vision_run_id', run.id).eq('team_key', manual.team_key).order('started_ms'),
        client.from('vision_tracks').select('*').eq('vision_run_id', run.id).eq('team_key', manual.team_key)
      ]);
      for (const result of results) if (result.error) throw result.error;
      observations = results[0].data || [];
      tracks = results[1].data || [];
    }
    return json({ success: true, data: { manual, pitProblems: pitProblems || [], matches, runs: runs || [], run, observations, tracks } });
  } catch (error) {
    return json({ error: error.message || 'Could not load scouting comparison' }, { status: 500 });
  }
}
