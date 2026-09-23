import { env } from '$env/dynamic/private';
import { getFileContent, listDirectory, createBranch, putFile, createPullRequest } from '$lib/server/github_repo.js';
import { queryHubDataToolDeclaration, executeHubDataQuery } from '$lib/server/hub_data_query.js';

// The GitHub token lives in Supabase Vault, not process env - see the
// get_app_secret migration and the conversation that led to it (a token
// pasted directly into Slack/chat is treated as sensitive: store it once,
// server-side, service-role-only, rather than in a process env var anyone
// with deploy-config access can read in plaintext). Fetched once per
// request and threaded through explicitly rather than cached at module
// scope, so it's never held longer than one /edit request needs it.
async function fetchGithubToken(supa) {
  if (!supa) throw new Error('No Supabase client available to fetch the GitHub token from Vault');
  const { data, error } = await supa.rpc('get_app_secret', { secret_name: 'github_token' });
  if (error) throw new Error(`Could not read the GitHub token from Vault: ${error.message}`);
  if (!data) throw new Error('No "github_token" secret is stored in Vault yet');
  return data;
}

// "@Spartans Hub /edit <description>" - lets a Change Lead ask Gemini to
// draft an actual code change as a pull request. Gated by the
// REQUEST_CODE_CHANGES permission (see permissions.js's "Change Lead" role/
// roster key) in handleHubAppMention, not in here - this module assumes the
// caller has already been authorized.
export function isCodeChangeRequest(question) {
  return /^\/edit\b/i.test(String(question || '').trim());
}

export function parseCodeChangeRequest(question) {
  return String(question || '').trim().replace(/^\/edit\b/i, '').trim();
}

const MAX_CHANGE_ROUNDS = 14;
// Hard ceiling on files touched by one request - not a technical limit, a
// blast-radius one: this bot has no test-running step, so a request that
// would sprawl across dozens of files is exactly the kind of change that
// most needs a human driving, not a bot guessing alone.
const MAX_FILES_PER_CHANGE = 12;

function readFileToolDeclaration() {
  return {
    name: 'read_file',
    description: 'Read a file from the main branch of this repository (frc971/spartanshub) as it exists right now. Returns its full text content.',
    parameters: {
      type: 'OBJECT',
      properties: { path: { type: 'STRING', description: 'Repo-relative file path, e.g. "src/lib/permissions.js".' } },
      required: ['path']
    }
  };
}

function listDirectoryToolDeclaration() {
  return {
    name: 'list_directory',
    description: 'List the files and subdirectories directly inside a directory of this repository (not recursive). Pass "" for the repo root.',
    parameters: {
      type: 'OBJECT',
      properties: { path: { type: 'STRING', description: 'Repo-relative directory path, e.g. "src/routes/manufacture".' } },
      required: ['path']
    }
  };
}

function writeFileToolDeclaration() {
  return {
    name: 'write_file',
    description: `Stage a full replacement (or a brand new file) to be included in the pull request this request will open. This does NOT touch the live site or database - it only stages content for a new, unmerged pull request a human will review. You may stage at most ${MAX_FILES_PER_CHANGE} files. Always pass the file's COMPLETE new content, not a diff or partial snippet - whatever you pass here becomes the entire file.`,
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Repo-relative file path to create or replace.' },
        content: { type: 'STRING', description: "The file's complete new text content." }
      },
      required: ['path', 'content']
    }
  };
}

function buildSystemPrompt() {
  return [
    'You are Spartans Hub\'s code-change assistant, invoked by a Change Lead (a trusted, authorized team member) via "@Spartans Hub /edit <description>" in Slack.',
    'You have read access to every file in the frc971/spartanshub repository via read_file and list_directory, and read-only access to a small allowlisted set of database tables via query_hub_data (use it only to understand real data shapes, e.g. before writing a migration - never to justify skipping a real file read).',
    'Use write_file to stage the files your change needs, given the requester\'s description. Always read a file with read_file before writing a changed version of it, so your version is a real edit of the current content, not a guess. Match the existing code style, naming, and patterns you find in nearby files - do not introduce a new framework, library, or pattern the codebase does not already use.',
    'You may create or edit a SQL migration file under migrations/ exactly like any other file write - that is allowed and often correct for a schema change. But you must NEVER attempt to execute, run, or apply a migration, and you have no tool that could mutate the live database even if you tried - query_hub_data is strictly read-only. Writing a migration FILE is the entire extent of what you may do about the database; actually applying it is a deliberate separate step a human takes later.',
    'Every change you make is submitted as a new, UNMERGED pull request for a human to review before anything reaches production - never claim in your final summary that the change is live, deployed, applied, or merged. It is not, and must not be.',
    'If the request is unclear, too large or risky to do responsibly in one pass, or you cannot find enough of the relevant code to make a confident change, do not guess - call no more write_file tools and instead explain in your final answer what you need clarified or why you are not proceeding.',
    'When you are done staging files (or have decided not to proceed), stop calling tools and write a final plain-text answer: a concise, PR-description-style summary of what you changed and why (or, if you did not stage anything, an explanation of what you need). Keep it under 1200 characters, Slack markdown, no tables.'
  ].join('\n\n');
}

async function callGemini(fetchImpl, apiKey, model, systemPrompt, contents, tools, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools: [{ function_declarations: tools }],
        generationConfig: { maxOutputTokens: 2000 }
      }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `Gemini request failed (${response.status})`);
      error.httpStatus = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function executeChangeTool(fetchImpl, githubToken, supa, staged, call) {
  const args = call?.args || {};
  switch (call?.name) {
    case 'read_file': {
      const result = await getFileContent(fetchImpl, githubToken, String(args.path || ''), 'main');
      if (!result) return { error: `"${args.path}" does not exist on main.` };
      if (result.isDirectory) return { error: `"${args.path}" is a directory, not a file - use list_directory instead.` };
      return { path: args.path, content: result.content };
    }
    case 'list_directory': {
      try {
        const entries = await listDirectory(fetchImpl, githubToken, String(args.path || ''), 'main');
        return { path: args.path || '', entries };
      } catch (error) {
        return { error: error.message || 'Could not list that directory' };
      }
    }
    case 'write_file': {
      const path = String(args.path || '').trim();
      if (!path) return { error: 'path is required' };
      if (!staged.has(path) && staged.size >= MAX_FILES_PER_CHANGE) {
        return { error: `Already staged the maximum of ${MAX_FILES_PER_CHANGE} files for one request. Finish up with what is already staged.` };
      }
      staged.set(path, String(args.content ?? ''));
      return { staged: path, totalFilesStaged: staged.size };
    }
    case 'query_hub_data':
      return executeHubDataQuery(supa, args);
    default:
      return { error: `Unknown tool "${call?.name}"` };
  }
}

function slugifyBranchSuffix(description) {
  const slug = String(description || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'change';
  return `${slug}-${Date.now().toString(36)}`;
}

// Returns { prUrl, prNumber, summary } when a PR was opened, or
// { prUrl: null, summary } when Gemini decided not to (or could not) stage
// any file changes - the caller posts `summary` back to Slack either way.
export async function draftCodeChangePr(description, options = {}) {
  const apiKey = options.apiKey ?? env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  const model = options.model ?? env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';
  const fetchImpl = options.fetchImpl || fetch;
  const supa = options.supa || null;
  const timeoutMs = options.timeoutMs ?? 45000;
  const githubToken = options.githubToken ?? await fetchGithubToken(supa);

  const trimmedDescription = String(description || '').trim();
  if (!trimmedDescription) {
    return { prUrl: null, summary: 'Tell me what to change - e.g. `/edit change the Sign In button on the login screen to say "Log In" instead`.' };
  }

  const tools = [readFileToolDeclaration(), listDirectoryToolDeclaration(), writeFileToolDeclaration()];
  if (supa) tools.push(queryHubDataToolDeclaration());
  const systemPrompt = buildSystemPrompt();
  const contents = [{ role: 'user', parts: [{ text: trimmedDescription.slice(0, 2000) }] }];
  const staged = new Map();

  for (let round = 0; round < MAX_CHANGE_ROUNDS; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    const payload = await callGemini(fetchImpl, apiKey, model, systemPrompt, contents, tools, timeoutMs);
    const parts = payload?.candidates?.[0]?.content?.parts || [];
    const functionCalls = parts.filter((part) => part?.functionCall).map((part) => part.functionCall);

    if (functionCalls.length) {
      contents.push({ role: 'model', parts: parts.filter((part) => part?.functionCall) });
      const functionResponseParts = [];
      for (const call of functionCalls) {
        // eslint-disable-next-line no-await-in-loop
        const result = await executeChangeTool(fetchImpl, githubToken, supa, staged, call);
        functionResponseParts.push({ functionResponse: { name: call.name, response: result } });
      }
      contents.push({ role: 'user', parts: functionResponseParts });
      continue;
    }

    const summary = parts
      .filter((part) => !part.thought && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim();

    if (staged.size === 0) {
      return { prUrl: null, summary: summary || 'I could not find a safe, confident way to make that change, and did not stage anything.' };
    }

    const branch = `gemini-edit/${slugifyBranchSuffix(trimmedDescription)}`;
    // eslint-disable-next-line no-await-in-loop
    await createBranch(fetchImpl, githubToken, branch, 'main');
    for (const [path, content] of staged) {
      // eslint-disable-next-line no-await-in-loop
      await putFile(fetchImpl, githubToken, path, content, `/edit: ${trimmedDescription.slice(0, 60)}`, branch);
    }
    const requester = options.requesterName ? ` (requested by ${options.requesterName} via Slack)` : '';
    // eslint-disable-next-line no-await-in-loop
    const pr = await createPullRequest(fetchImpl, githubToken, {
      title: trimmedDescription.slice(0, 70),
      body: `${summary || 'Drafted from a Slack /edit request.'}\n\n---\nDrafted by Gemini from a Slack \`/edit\` request${requester}. **Unmerged** - review carefully before merging; no tests were run against this change.\n\nRequest: "${trimmedDescription}"`,
      head: branch,
      base: 'main'
    });
    return { prUrl: pr.url, prNumber: pr.number, summary: summary || 'Opened a draft pull request for this change.' };
  }

  throw new Error('Gemini did not finish drafting this change within the tool-call round limit');
}
