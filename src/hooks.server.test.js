import { describe, expect, it, vi } from 'vitest';
import { csrfCheck } from './hooks.server.js';

// Real, confirmed report: setup.py opens /install/fusion-runner/setup in
// the reader's own browser so they can submit a plain, no-JS
// <form method="post"> with their Fusion Runner admin token - SvelteKit's
// own checkOrigin rejected that exact submission with "Cross-site POST
// form submissions are forbidden", stranding the reader mid-install.
// This hook re-implements that same protection for every route except
// that one genuine exception.

function makeEvent({ method = 'GET', pathname = '/', origin = 'https://hub.example', contentType, requestOrigin }) {
  const headers = new Map();
  if (contentType) headers.set('content-type', contentType);
  if (requestOrigin !== undefined) headers.set('origin', requestOrigin);
  const request = { method, headers: { get: (name) => headers.get(name.toLowerCase()) ?? null } };
  const url = new URL(pathname, origin);
  return { request, url };
}

describe('csrfCheck', () => {
  it('blocks a form POST to an ordinary route whose Origin does not match', async () => {
    const resolve = vi.fn();
    const event = makeEvent({
      method: 'POST',
      pathname: '/api/whatever',
      contentType: 'application/x-www-form-urlencoded',
      requestOrigin: 'https://attacker.example'
    });
    const response = await csrfCheck({ event, resolve });
    expect(response.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('blocks a form POST to an ordinary route with no Origin header at all', async () => {
    const resolve = vi.fn();
    const event = makeEvent({
      method: 'POST',
      pathname: '/api/whatever',
      contentType: 'multipart/form-data; boundary=xyz'
    });
    const response = await csrfCheck({ event, resolve });
    expect(response.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('allows a form POST to an ordinary route whose Origin matches', async () => {
    const resolve = vi.fn(() => 'resolved');
    const event = makeEvent({
      method: 'POST',
      pathname: '/api/whatever',
      origin: 'https://hub.example',
      contentType: 'application/x-www-form-urlencoded',
      requestOrigin: 'https://hub.example'
    });
    const result = await csrfCheck({ event, resolve });
    expect(result).toBe('resolved');
    expect(resolve).toHaveBeenCalledWith(event);
  });

  it('never blocks a JSON POST, matching every other route in this app', async () => {
    const resolve = vi.fn(() => 'resolved');
    const event = makeEvent({
      method: 'POST',
      pathname: '/api/whatever',
      contentType: 'application/json',
      requestOrigin: 'https://attacker.example'
    });
    const result = await csrfCheck({ event, resolve });
    expect(result).toBe('resolved');
  });

  it('never blocks a GET request regardless of content-type or origin', async () => {
    const resolve = vi.fn(() => 'resolved');
    const event = makeEvent({
      method: 'GET',
      pathname: '/api/whatever',
      contentType: 'application/x-www-form-urlencoded',
      requestOrigin: 'https://attacker.example'
    });
    const result = await csrfCheck({ event, resolve });
    expect(result).toBe('resolved');
  });

  it('allows the exempt /install/fusion-runner/setup form POST with no Origin header', async () => {
    const resolve = vi.fn(() => 'resolved');
    const event = makeEvent({
      method: 'POST',
      pathname: '/install/fusion-runner/setup',
      contentType: 'application/x-www-form-urlencoded'
    });
    const result = await csrfCheck({ event, resolve });
    expect(result).toBe('resolved');
  });

  it('allows the exempt /install/fusion-runner/setup form POST with a mismatched Origin', async () => {
    const resolve = vi.fn(() => 'resolved');
    const event = makeEvent({
      method: 'POST',
      pathname: '/install/fusion-runner/setup',
      contentType: 'application/x-www-form-urlencoded',
      requestOrigin: 'null'
    });
    const result = await csrfCheck({ event, resolve });
    expect(result).toBe('resolved');
  });

  it('still blocks a different form POST route that merely starts with the exempt path', async () => {
    const resolve = vi.fn();
    const event = makeEvent({
      method: 'POST',
      pathname: '/install/fusion-runner/setup/extra',
      contentType: 'application/x-www-form-urlencoded',
      requestOrigin: 'https://attacker.example'
    });
    const response = await csrfCheck({ event, resolve });
    expect(response.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });
});
