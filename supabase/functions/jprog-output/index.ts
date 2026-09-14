const OUTPUT_ROOT = 'Jprog Output/';
const DEFAULT_REPOSITORY = 'yuvanshankar30/output';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function githubOutputPath(storagePath: unknown) {
  const path = String(storagePath || '');
  if (!path.startsWith(OUTPUT_ROOT)) throw new Error('JProg output must be stored under Jprog Output.');
  const repositoryPath = path.slice(OUTPUT_ROOT.length);
  if (!/^\d{8}\/[A-Za-z0-9._-]+\.(?:ngc|tap)$/i.test(repositoryPath)) throw new Error('Invalid JProg output path.');
  return path;
}

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

async function githubFailure(githubResponse: Response, fallback: string) {
  const detail = await githubResponse.json().catch(() => ({}));
  if (detail.message === 'Resource not accessible by personal access token') {
    return response({ error: 'GitHub token cannot write yuvanshankar30/output. Create a fine-grained token for that repository with Contents: Read and write, then replace the Supabase JPROG_OUTPUT_GITHUB_TOKEN secret.' }, 403);
  }
  return response({ error: detail.message || fallback }, githubResponse.status);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);

  try {
    const authorization = request.headers.get('authorization');
    const projectUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!authorization || !projectUrl || !anonKey) return response({ error: 'Sign in to publish JProg output.' }, 401);

    const userResponse = await fetch(`${projectUrl}/auth/v1/user`, { headers: { Authorization: authorization, apikey: anonKey } });
    if (!userResponse.ok) return response({ error: 'Sign in to publish JProg output.' }, 401);

    const { storagePath, content } = await request.json();
    if (typeof content !== 'string' || content.length > 5 * 1024 * 1024) return response({ error: 'Invalid JProg output content.' }, 400);
    const path = githubOutputPath(storagePath);
    const token = Deno.env.get('JPROG_OUTPUT_GITHUB_TOKEN');
    const repository = Deno.env.get('JPROG_OUTPUT_GITHUB_REPOSITORY') || DEFAULT_REPOSITORY;
    if (!token) return response({ error: 'JProg GitHub publishing is not configured.' }, 503);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return response({ error: 'Invalid JProg GitHub repository configuration.' }, 500);

    const contentUrl = `https://api.github.com/repos/${repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
    const existing = await fetch(contentUrl, { headers });
    if (!existing.ok && existing.status !== 404) return githubFailure(existing, 'GitHub could not inspect existing JProg output.');
    const payload: Record<string, string> = { message: `Add JProg output ${path}`, content: btoa(content) };
    if (existing.ok) payload.sha = (await existing.json()).sha;
    const githubResponse = await fetch(contentUrl, { method: 'PUT', headers, body: JSON.stringify(payload) });
    if (!githubResponse.ok) {
      return githubFailure(githubResponse, 'GitHub could not publish JProg output.');
    }
    const result = await githubResponse.json();
    return response({ path, commit: result.commit?.sha || null });
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : 'Could not publish JProg output.' }, 400);
  }
});
