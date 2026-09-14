import { env } from '$env/dynamic/private';
import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import { createClient } from '@supabase/supabase-js';
import { json } from '@sveltejs/kit';
import { githubContentsPayload, githubJprogOutputPath } from '$lib/server/jprog_output_github.js';

const DEFAULT_REPOSITORY = 'yuvanshankar30/output';

async function requireUser(request) {
  const authorization = request.headers.get('authorization');
  if (!authorization) throw new Error('Sign in to publish JProg output.');
  const supabase = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error('Sign in to publish JProg output.');
}

export async function POST({ request }) {
  try {
    await requireUser(request);
    const { storagePath, content } = await request.json();
    if (typeof content !== 'string' || content.length > 5 * 1024 * 1024) return json({ error: 'Invalid JProg output content.' }, { status: 400 });
    const path = githubJprogOutputPath(storagePath);
    const token = env.JPROG_OUTPUT_GITHUB_TOKEN;
    if (!token) return json({ error: 'JProg GitHub publishing is not configured.' }, { status: 503 });
    const repository = env.JPROG_OUTPUT_GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return json({ error: 'Invalid JProg GitHub repository configuration.' }, { status: 500 });
    const contentUrl = `https://api.github.com/repos/${repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
    const existing = await fetch(contentUrl, { headers });
    if (!existing.ok && existing.status !== 404) return json({ error: 'GitHub could not inspect existing JProg output.' }, { status: existing.status });
    const payload = githubContentsPayload(path, content);
    if (existing.ok) payload.sha = (await existing.json()).sha;
    const response = await fetch(contentUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      return json({ error: detail.message || 'GitHub could not publish JProg output.' }, { status: response.status });
    }
    const result = await response.json();
    return json({ path, commit: result.commit?.sha || null });
  } catch (error) {
    return json({ error: error?.message || 'Could not publish JProg output.' }, { status: 401 });
  }
}
