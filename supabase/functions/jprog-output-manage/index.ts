// Browse/delete/create-folder/rename support for the same public
// yuvanshankar30/output repository jprog-output/index.ts publishes to.
// Shares its exact auth pattern (any signed-in Supabase user, checked via
// /auth/v1/user) and its exact GitHub credential (JPROG_OUTPUT_GITHUB_TOKEN,
// JPROG_OUTPUT_GITHUB_REPOSITORY) - the browser never receives the GitHub
// write token, only this function does.
const DEFAULT_REPOSITORY = 'yuvanshankar30/output';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const PLACEHOLDER_NAME = '.gitkeep';

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

// No path traversal, no leading/trailing slash, no null bytes - this browses
// the whole output repo (not only JustinProgOutput/YYYYMMDD/*.ngc|.tap the
// way jprog-output/index.ts's own path check is scoped), so this check is
// intentionally general rather than reusing that function's narrower regex.
function safePath(path: unknown, { allowRoot = false } = {}) {
  const trimmed = String(path ?? '').replace(/^\/+|\/+$/g, '');
  if (!trimmed) {
    if (allowRoot) return '';
    throw new Error('A path is required.');
  }
  if (trimmed.includes('\0') || trimmed.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('Invalid path.');
  }
  return trimmed;
}

// Root-level entries define the repository's shared structure. In
// particular, JustinProgOutput is the handoff root consumed by JProg and
// the Files tab, so client-side button hiding alone is not enough to keep a
// direct request from renaming or deleting it.
function isRootEntry(path: string) {
  return !path.includes('/');
}

function encodePath(path: string) {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

// GitHub's Contents API only lists one directory level per call and has no
// folder delete/rename primitive at all - the Git Trees API's `recursive=1`
// gives every blob under the whole repo in one call, which this filters down
// to the requested prefix. Used only by delete/rename's folder branches
// (list itself stays a plain single-level Contents API call, matching the
// natural level-by-level browsing UX of a file-browser popup).
async function recursiveBlobsUnder(apiRoot: string, headers: Record<string, string>, prefix: string) {
  const repoResponse = await fetch(`${apiRoot}`, { headers });
  if (!repoResponse.ok) return { error: repoResponse };
  const repoInfo = await repoResponse.json();
  const branch = repoInfo.default_branch || 'main';
  const treeResponse = await fetch(`${apiRoot}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers });
  if (!treeResponse.ok) return { error: treeResponse };
  const tree = await treeResponse.json();
  const withinPrefix = prefix ? `${prefix}/` : '';
  const blobs = (tree.tree || []).filter(
    (entry: { type: string; path: string }) => entry.type === 'blob' && (!withinPrefix || entry.path.startsWith(withinPrefix))
  );
  return { blobs };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);

  try {
    const authorization = request.headers.get('authorization');
    const projectUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!authorization || !projectUrl || !anonKey) return response({ error: 'Sign in to manage JProg output.' }, 401);

    const userResponse = await fetch(`${projectUrl}/auth/v1/user`, { headers: { Authorization: authorization, apikey: anonKey } });
    if (!userResponse.ok) return response({ error: 'Sign in to manage JProg output.' }, 401);

    const token = Deno.env.get('JPROG_OUTPUT_GITHUB_TOKEN');
    const repository = Deno.env.get('JPROG_OUTPUT_GITHUB_REPOSITORY') || DEFAULT_REPOSITORY;
    if (!token) return response({ error: 'JProg GitHub publishing is not configured.' }, 503);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return response({ error: 'Invalid JProg GitHub repository configuration.' }, 500);

    const headers = ghHeaders(token);
    const apiRoot = `https://api.github.com/repos/${repository}`;
    const contentsUrl = (path: string) => `${apiRoot}/contents/${encodePath(path)}`;

    const body = await request.json().catch(() => ({}));
    const action = body.action;

    if (action === 'list') {
      const path = safePath(body.path, { allowRoot: true });
      const res = await fetch(contentsUrl(path), { headers });
      if (res.status === 404) return response({ path, entries: [] });
      if (!res.ok) return githubFailure(res, 'Could not list this folder.');
      const data = await res.json();
      const entries = (Array.isArray(data) ? data : [data]).filter((entry: { name: string }) => entry.name !== PLACEHOLDER_NAME);
      return response({
        path,
        entries: entries
          .map((entry: { name: string; path: string; type: string; size: number }) => ({
            name: entry.name,
            path: entry.path,
            type: entry.type === 'dir' ? 'dir' : 'file',
            size: entry.size ?? null
          }))
          .sort((a: { type: string; name: string }, b: { type: string; name: string }) =>
            a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
          )
      });
    }

    if (action === 'download') {
      const path = safePath(body.path);
      const res = await fetch(contentsUrl(path), { headers });
      if (!res.ok) return githubFailure(res, 'Could not find that file to download.');
      const info = await res.json();
      if (Array.isArray(info)) return response({ error: `${path} is a folder.` }, 400);
      // Contents only inlines base64 below roughly 1 MB. The matching Git
      // Blobs endpoint keeps downloads working for larger router programs.
      let content = info.content;
      if (!content) {
        const blobRes = await fetch(`${apiRoot}/git/blobs/${info.sha}`, { headers });
        if (!blobRes.ok) return githubFailure(blobRes, 'Could not read that file.');
        content = (await blobRes.json()).content;
      }
      return response({ name: path.split('/').pop(), content });
    }

    if (action === 'upload') {
      const path = safePath(body.path);
      const content = body.content;
      if (typeof content !== 'string' || content.length > 25 * 1024 * 1024) {
        return response({ error: 'Invalid file content.' }, 400);
      }
      const url = contentsUrl(path);
      const payload: Record<string, string> = { message: `Add ${path}`, content };
      // A file already at this exact path is an overwrite, which GitHub's
      // Contents API requires the current sha for - fetched fresh rather
      // than trusted from an earlier list() call, the same reasoning
      // delete/rename already use.
      const existing = await fetch(url, { headers });
      if (existing.ok) {
        const info = await existing.json();
        if (Array.isArray(info)) return response({ error: `${path} is already a folder.` }, 409);
        payload.sha = info.sha;
      } else if (existing.status !== 404) {
        return githubFailure(existing, 'Could not check for an existing file at that path.');
      }
      const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(payload) });
      if (!res.ok) return githubFailure(res, 'Could not upload that file.');
      return response({ ok: true });
    }

    if (action === 'mkdir') {
      const path = safePath(body.path);
      const res = await fetch(contentsUrl(`${path}/${PLACEHOLDER_NAME}`), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ message: `Create folder ${path}`, content: '' })
      });
      if (!res.ok) return githubFailure(res, 'Could not create that folder.');
      return response({ ok: true });
    }

    if (action === 'delete') {
      const path = safePath(body.path);
      if (isRootEntry(path)) {
        return response({ error: 'Root-level output repository entries cannot be renamed or removed.' }, 403);
      }
      const existing = await fetch(contentsUrl(path), { headers });
      if (!existing.ok) return githubFailure(existing, 'Could not find that item to delete.');
      const info = await existing.json();
      if (Array.isArray(info)) {
        const { blobs, error } = await recursiveBlobsUnder(apiRoot, headers, path);
        if (error) return githubFailure(error, 'Could not read this folder before deleting it.');
        for (const blob of blobs || []) {
          const blobExisting = await fetch(contentsUrl(blob.path), { headers });
          if (!blobExisting.ok) return githubFailure(blobExisting, `Could not read ${blob.path} before deleting it.`);
          const blobInfo = await blobExisting.json();
          const del = await fetch(contentsUrl(blob.path), {
            method: 'DELETE',
            headers,
            body: JSON.stringify({ message: `Delete ${blob.path}`, sha: blobInfo.sha })
          });
          if (!del.ok) return githubFailure(del, `Could not delete ${blob.path}.`);
        }
      } else {
        const del = await fetch(contentsUrl(path), {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ message: `Delete ${path}`, sha: info.sha })
        });
        if (!del.ok) return githubFailure(del, 'Could not delete that file.');
      }
      return response({ ok: true });
    }

    if (action === 'rename') {
      const fromPath = safePath(body.fromPath);
      const toPath = safePath(body.toPath);
      if (isRootEntry(fromPath) || isRootEntry(toPath)) {
        return response({ error: 'Root-level output repository entries cannot be renamed or removed.' }, 403);
      }
      const existing = await fetch(contentsUrl(fromPath), { headers });
      if (!existing.ok) return githubFailure(existing, 'Could not find that item to rename.');
      const info = await existing.json();

      if (Array.isArray(info)) {
        const { blobs, error } = await recursiveBlobsUnder(apiRoot, headers, fromPath);
        if (error) return githubFailure(error, 'Could not read this folder before renaming it.');
        for (const blob of blobs || []) {
          const blobExisting = await fetch(contentsUrl(blob.path), { headers });
          if (!blobExisting.ok) return githubFailure(blobExisting, `Could not read ${blob.path} before renaming it.`);
          const blobInfo = await blobExisting.json();
          const destination = toPath + blob.path.slice(fromPath.length);
          const put = await fetch(contentsUrl(destination), {
            method: 'PUT',
            headers,
            body: JSON.stringify({ message: `Rename ${blob.path} to ${destination}`, content: blobInfo.content, encoding: 'base64' })
          });
          if (!put.ok) return githubFailure(put, `Could not create ${destination}.`);
          const del = await fetch(contentsUrl(blob.path), {
            method: 'DELETE',
            headers,
            body: JSON.stringify({ message: `Remove ${blob.path} after rename`, sha: blobInfo.sha })
          });
          if (!del.ok) return githubFailure(del, `Renamed but could not remove the original ${blob.path}.`);
        }
      } else {
        const put = await fetch(contentsUrl(toPath), {
          method: 'PUT',
          headers,
          body: JSON.stringify({ message: `Rename ${fromPath} to ${toPath}`, content: info.content, encoding: 'base64' })
        });
        if (!put.ok) return githubFailure(put, 'Could not create the renamed file.');
        const del = await fetch(contentsUrl(fromPath), {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ message: `Remove ${fromPath} after rename`, sha: info.sha })
        });
        if (!del.ok) return githubFailure(del, 'Renamed but could not remove the original file.');
      }
      return response({ ok: true });
    }

    return response({ error: 'Unknown action.' }, 400);
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : 'Could not manage JProg output.' }, 400);
  }
});
