import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: { GEMINI_API_KEY: 'test-key', GEMINI_MODEL: undefined } }));
import { env } from '$env/dynamic/private';
import { approveDraftCodeChangePr, draftCodeChangePr, isCodeChangeRequest, parseCodeChangeRequest, rejectDraftCodeChangePr } from './hub_change_request.js';

// A single-round response with no functionCall and no text ends the loop
// immediately with { prUrl: null }, exercising the model-selection logic
// without needing a real GitHub token, Supabase client, or write_file call.
function noOpGeminiResponse() {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'Not making this change.' }] } }] })
  };
}

describe('isCodeChangeRequest / parseCodeChangeRequest', () => {
  it('recognizes a /edit prefix case-insensitively and strips it', () => {
    expect(isCodeChangeRequest('/edit change the button label')).toBe(true);
    expect(isCodeChangeRequest('/EDIT change it')).toBe(true);
    expect(isCodeChangeRequest('edit change it')).toBe(false);
    expect(parseCodeChangeRequest('/edit  change the button label')).toBe('change the button label');
  });
});

describe('rejectDraftCodeChangePr', () => {
  it('closes and removes only an open bot-created draft branch', async () => {
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (url.endsWith('/pulls/42')) {
        if (options.method === 'PATCH') return { ok: true, json: async () => ({ number: 42, state: 'closed', head: { ref: 'gemini-edit/login-copy' } }) };
        return { ok: true, json: async () => ({ number: 42, state: 'open', head: { ref: 'gemini-edit/login-copy' } }) };
      }
      if (url.endsWith('/git/refs/heads/gemini-edit%2Flogin-copy')) return { ok: true, json: async () => ({}) };
      throw new Error(`Unexpected request: ${url}`);
    });
    await expect(rejectDraftCodeChangePr(42, { fetchImpl, githubToken: 'test-token' }))
      .resolves.toMatchObject({ number: 42, state: 'closed' });
    expect(fetchImpl.mock.calls.some(([url, options]) => url.endsWith('/pulls/42') && options.method === 'PATCH')).toBe(true);
    expect(fetchImpl.mock.calls.some(([url, options]) => url.endsWith('/git/refs/heads/gemini-edit%2Flogin-copy') && options.method === 'DELETE')).toBe(true);
  });

  it('refuses to close a non-bot pull request', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ number: 42, state: 'open', head: { ref: 'feature/someone-elses-work' } }) }));
    await expect(rejectDraftCodeChangePr(42, { fetchImpl, githubToken: 'test-token' }))
      .rejects.toThrow('not an open Spartans Hub draft');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('approveDraftCodeChangePr', () => {
  const openDraft = { number: 42, state: 'open', title: 'Change copy', html_url: 'https://github.com/frc971/spartanshub/pull/42', head: { ref: 'gemini-edit/change-copy', sha: 'draft-sha' } };

  it('never asks Gemini or merges while GitHub checks are pending', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/pulls/42')) return { ok: true, json: async () => openDraft };
      if (url.includes('/check-runs')) return { ok: true, json: async () => ({ check_runs: [{ name: 'test', status: 'in_progress' }] }) };
      if (url.endsWith('/status')) return { ok: true, json: async () => ({ state: 'pending' }) };
      throw new Error(`Unexpected request: ${url}`);
    });
    await expect(approveDraftCodeChangePr(42, { fetchImpl, githubToken: 'test-token', apiKey: 'test-key' }))
      .resolves.toMatchObject({ merged: false, phase: 'checks', checks: { state: 'pending' } });
    expect(fetchImpl.mock.calls.some(([url]) => url.includes('generativelanguage.googleapis.com'))).toBe(false);
    expect(fetchImpl.mock.calls.some(([url]) => url.endsWith('/merge'))).toBe(false);
  });

  it('reviews a passing, unchanged draft before squash-merging it', async () => {
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (url.endsWith('/pulls/42')) return { ok: true, json: async () => openDraft };
      if (url.includes('/check-runs')) return { ok: true, json: async () => ({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] }) };
      if (url.endsWith('/status')) return { ok: true, json: async () => ({ state: 'success' }) };
      if (url.includes('/pulls/42/files')) return { ok: true, json: async () => ([{ filename: 'src/example.js', status: 'modified', patch: '+safe change' }]) };
      if (url.includes('generativelanguage.googleapis.com')) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'APPROVE - no blocking defects.' }] } }] }) };
      if (url.endsWith('/merge') && options.method === 'PUT') return { ok: true, json: async () => ({ merged: true, sha: 'merge-sha' }) };
      throw new Error(`Unexpected request: ${url}`);
    });
    await expect(approveDraftCodeChangePr(42, { fetchImpl, githubToken: 'test-token', apiKey: 'test-key' }))
      .resolves.toMatchObject({ merged: true, phase: 'merged', review: { approved: true } });
    expect(fetchImpl.mock.calls.some(([url, options]) => url.endsWith('/merge') && options.method === 'PUT')).toBe(true);
  });
});

describe('draftCodeChangePr Gemini model selection', () => {
  beforeEach(() => {
    env.GEMINI_MODEL = undefined;
  });

  it('defaults to gemini-3.1-pro-preview, never the unreliable Flash-Lite default', async () => {
    // Direct instruction: /edit now defaults to Gemini 3.1 Pro (its real
    // model id, "gemini-3.1-pro-preview" - "gemini-3.1-pro" alone 404s) for
    // stronger reasoning on this harder, multi-round agentic read/write
    // task than the plain Q&A path. Still must never silently fall back to
    // Flash-Lite (an earlier real bug, confirmed against a real Slack
    // transcript and Cloud Run log line - Flash-Lite reliably burned
    // through the whole MAX_CHANGE_ROUNDS budget without finishing even
    // simple requests).
    const fetchImpl = vi.fn().mockResolvedValue(noOpGeminiResponse());
    await draftCodeChangePr('rename the app', { apiKey: 'test-key', fetchImpl, githubToken: 'test-token' });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent'
    );
  });

  it('respects an explicitly configured GEMINI_MODEL other than Flash-Lite', async () => {
    env.GEMINI_MODEL = 'gemini-3.5-pro';
    const fetchImpl = vi.fn().mockResolvedValue(noOpGeminiResponse());
    await draftCodeChangePr('rename the app', { apiKey: 'test-key', fetchImpl, githubToken: 'test-token' });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-pro:generateContent'
    );
  });

  it('still falls back to Pro instead of Flash-Lite even if GEMINI_MODEL is explicitly set to Flash-Lite', async () => {
    env.GEMINI_MODEL = 'gemini-3.5-flash-lite';
    const fetchImpl = vi.fn().mockResolvedValue(noOpGeminiResponse());
    await draftCodeChangePr('rename the app', { apiKey: 'test-key', fetchImpl, githubToken: 'test-token' });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent'
    );
  });

  it('an explicit options.model override still wins over everything else', async () => {
    env.GEMINI_MODEL = 'gemini-3.5-pro';
    const fetchImpl = vi.fn().mockResolvedValue(noOpGeminiResponse());
    await draftCodeChangePr('rename the app', { apiKey: 'test-key', fetchImpl, githubToken: 'test-token', model: 'gemini-3.5-flash-lite' });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent'
    );
  });

  it('stops before starting another edit round when cancellation is requested', async () => {
    const fetchImpl = vi.fn();
    await expect(draftCodeChangePr('rename the app', {
      apiKey: 'test-key', fetchImpl, githubToken: 'test-token', shouldCancel: async () => true
    })).rejects.toMatchObject({ code: 'EDIT_CANCELLED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not create a branch when cancellation arrives during Gemini output', async () => {
    let geminiCalls = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        geminiCalls += 1;
        const part = geminiCalls === 1
          ? { functionCall: { name: 'write_file', args: { path: 'example.txt', content: 'new text' } } }
          : { text: 'Staged example.txt for review.' };
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [part] } }] }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const shouldCancel = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(draftCodeChangePr('create example', {
      apiKey: 'test-key', githubToken: 'test-token', fetchImpl, shouldCancel
    })).rejects.toMatchObject({ code: 'EDIT_CANCELLED' });
    expect(fetchImpl.mock.calls.some(([url]) => url.endsWith('/git/refs'))).toBe(false);
  });
});

describe('draftCodeChangePr round budget', () => {
  it('searches paths once and forces a final answer after repeated tool calls', async () => {
    let geminiCalls = 0;
    const fetchImpl = vi.fn(async (url, options) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        geminiCalls += 1;
        const part = geminiCalls < 40
          ? { functionCall: { name: 'search_paths', args: { query: 'theme' } } }
          : { text: 'No files were staged; I could not finish this edit.' };
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [part] } }] }) };
      }
      if (url.includes('/git/trees/main?recursive=1')) {
        return { ok: true, json: async () => ({ truncated: false, tree: [
          { type: 'blob', path: 'src/lib/themes.js' }, { type: 'blob', path: 'README.md' }
        ] }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const result = await draftCodeChangePr('remove a theme', {
      apiKey: 'test-key', githubToken: 'test-token', fetchImpl
    });
    expect(result).toEqual({ prUrl: null, summary: 'No files were staged; I could not finish this edit.' });
    expect(fetchImpl.mock.calls.filter(([url]) => url.includes('/git/trees/'))).toHaveLength(1);
    const geminiRequests = fetchImpl.mock.calls.filter(([url]) => url.includes('generativelanguage.googleapis.com'));
    expect(geminiRequests).toHaveLength(40);
    const secondRequest = JSON.parse(geminiRequests[1][1].body);
    expect(secondRequest.contents.at(-1).parts[0].functionResponse.response.matches).toContain('src/lib/themes.js');
    expect(JSON.parse(geminiRequests.at(-1)[1].body).toolConfig.functionCallingConfig.mode).toBe('NONE');
  });

  it('opens a PR for staged files when the final summary round ends tool use', async () => {
    let geminiCalls = 0;
    const fetchImpl = vi.fn(async (url, options) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        geminiCalls += 1;
        const part = geminiCalls === 1
          ? { functionCall: { name: 'write_file', args: { path: 'example.txt', content: 'new text' } } }
          : geminiCalls < 40
            ? { functionCall: { name: 'search_paths', args: { query: 'example' } } }
            : { text: 'Staged example.txt for review.' };
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [part] } }] }) };
      }
      if (url.includes('/git/trees/main?recursive=1')) {
        return { ok: true, json: async () => ({ truncated: false, tree: [] }) };
      }
      if (url.endsWith('/git/ref/heads/main')) {
        return { ok: true, json: async () => ({ object: { sha: 'base-sha' } }) };
      }
      if (url.endsWith('/git/refs')) return { ok: true, json: async () => ({}) };
      if (url.includes('/contents/example.txt?ref=')) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
      if (url.endsWith('/contents/example.txt')) return { ok: true, json: async () => ({}) };
      if (url.endsWith('/pulls')) return { ok: true, json: async () => ({ html_url: 'https://github.com/frc971/spartanshub/pull/42', number: 42 }) };
      throw new Error(`Unexpected request: ${url}`);
    });
    const result = await draftCodeChangePr('create example', {
      apiKey: 'test-key', githubToken: 'test-token', fetchImpl
    });
    expect(result.prUrl).toBe('https://github.com/frc971/spartanshub/pull/42');
    expect(result.summary).toBe('Staged example.txt for review.');
    expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith('/pulls'))).toHaveLength(1);
  });
});
