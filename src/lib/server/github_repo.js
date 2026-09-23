import { env } from '$env/dynamic/private';

// Minimal GitHub REST API v3 client for the Slack /edit code-change command
// (see hub_change_request.js). No SDK dependency - plain fetch, matching how
// this app already talks to every other external API (TBA, Gemini). Every
// write here only ever reaches a NEW branch, never main - opening a pull
// request is this module's only "final" action, and it never merges one.
//
// The token itself is never read from process env here - it lives in
// Supabase Vault (fetched once per request via the get_app_secret RPC, see
// fetchGithubToken in hub_change_request.js) and is threaded through every
// call below as an explicit parameter instead, so it's only ever held
// in-memory for the lifetime of one /edit request.
const API_BASE = 'https://api.github.com';
const OWNER = env.GITHUB_REPO_OWNER || 'frc971';
const REPO = env.GITHUB_REPO_NAME || 'spartanshub';

function authHeaders(token) {
  if (!token) throw new Error('No GitHub token was supplied');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function githubRequest(fetchImpl, token, path, options = {}) {
  const response = await fetchImpl(`${API_BASE}${path}`, {
    ...options,
    headers: { ...authHeaders(token), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || `GitHub API request failed (${response.status})`);
    error.githubStatus = response.status;
    error.githubPath = path;
    throw error;
  }
  return payload;
}

// Returns null (not an error) for a path that doesn't exist yet, so callers
// can tell "file is empty" apart from "file doesn't exist" when deciding
// whether a write is a create or an update.
export async function getFileContent(fetchImpl, token, path, ref = 'main') {
  try {
    const data = await githubRequest(fetchImpl, token, `/repos/${OWNER}/${REPO}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`);
    if (Array.isArray(data)) return { isDirectory: true, entries: data.map((e) => ({ name: e.name, path: e.path, type: e.type })) };
    return {
      isDirectory: false,
      content: Buffer.from(data.content || '', 'base64').toString('utf-8'),
      sha: data.sha
    };
  } catch (error) {
    if (error.githubStatus === 404) return null;
    throw error;
  }
}

export async function listDirectory(fetchImpl, token, path, ref = 'main') {
  const data = await githubRequest(fetchImpl, token, `/repos/${OWNER}/${REPO}/contents/${encodeURI(path || '')}?ref=${encodeURIComponent(ref)}`);
  if (!Array.isArray(data)) throw new Error(`"${path}" is a file, not a directory`);
  return data.map((e) => ({ name: e.name, path: e.path, type: e.type }));
}

export async function createBranch(fetchImpl, token, branchName, fromRef = 'main') {
  const base = await githubRequest(fetchImpl, token, `/repos/${OWNER}/${REPO}/git/ref/heads/${encodeURIComponent(fromRef)}`);
  await githubRequest(fetchImpl, token, `/repos/${OWNER}/${REPO}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: base.object.sha })
  });
  return branchName;
}

// One commit per file (the Contents API's own unit of work) - simple and
// reliable over building raw git blob/tree/commit objects by hand, at the
// cost of a PR with one commit per touched file instead of one squashed
// commit. Looks up the current sha first so this works for both a brand
// new file and an edit to an existing one.
export async function putFile(fetchImpl, token, path, content, message, branch) {
  const existing = await getFileContent(fetchImpl, token, path, branch).catch(() => null);
  return githubRequest(fetchImpl, token, `/repos/${OWNER}/${REPO}/contents/${encodeURI(path)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      branch,
      ...(existing?.sha ? { sha: existing.sha } : {})
    })
  });
}

export async function createPullRequest(fetchImpl, token, { title, body, head, base = 'main' }) {
  const pr = await githubRequest(fetchImpl, token, `/repos/${OWNER}/${REPO}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title, body, head, base, draft: false })
  });
  return { url: pr.html_url, number: pr.number };
}
