import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: { GEMINI_API_KEY: 'test-key', GEMINI_MODEL: undefined } }));
import { env } from '$env/dynamic/private';
import { draftCodeChangePr, isCodeChangeRequest, parseCodeChangeRequest } from './hub_change_request.js';

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

describe('draftCodeChangePr Gemini model selection', () => {
  beforeEach(() => {
    env.GEMINI_MODEL = undefined;
  });

  it('defaults to gemini-3.5-flash, never the unreliable Flash-Lite default', async () => {
    // Real bug this guards against: this used to fall straight back to
    // "gemini-3.5-flash-lite" whenever GEMINI_MODEL wasn't configured (the
    // case in production) - confirmed against a real Slack transcript and
    // a matching Cloud Run log line, Flash-Lite reliably burned through
    // the whole MAX_CHANGE_ROUNDS budget without finishing even simple
    // requests. askGeminiAboutHub already worked this out for the plain
    // Q&A path; /edit needs the same guard even more since it's a harder,
    // multi-round agentic task.
    const fetchImpl = vi.fn().mockResolvedValue(noOpGeminiResponse());
    await draftCodeChangePr('rename the app', { apiKey: 'test-key', fetchImpl, githubToken: 'test-token' });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent'
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

  it('still falls back to Flash instead of Flash-Lite even if GEMINI_MODEL is explicitly set to Flash-Lite', async () => {
    env.GEMINI_MODEL = 'gemini-3.5-flash-lite';
    const fetchImpl = vi.fn().mockResolvedValue(noOpGeminiResponse());
    await draftCodeChangePr('rename the app', { apiKey: 'test-key', fetchImpl, githubToken: 'test-token' });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent'
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
});
