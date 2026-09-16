import { describe, expect, it } from 'vitest';
import { addJob, buildJob, isQueueableFailure, markFailed, removeJobs } from './offlineQueue.js';

describe('buildJob', () => {
  it('carries the url/headers/body/label through, with a fresh id and zero attempts', () => {
    const job = buildJob({ url: '/api/matchscout', headers: { Authorization: 'Bearer x' }, body: { a: 1 }, label: 'Match 12 / Team 254' });
    expect(job.url).toBe('/api/matchscout');
    expect(job.headers).toEqual({ Authorization: 'Bearer x' });
    expect(job.body).toEqual({ a: 1 });
    expect(job.label).toBe('Match 12 / Team 254');
    expect(job.attempts).toBe(0);
    expect(typeof job.id).toBe('string');
    expect(job.id.length).toBeGreaterThan(0);
  });

  it('defaults headers to an empty object and label to an empty string', () => {
    const job = buildJob({ url: '/api/matchscout', body: {} });
    expect(job.headers).toEqual({});
    expect(job.label).toBe('');
  });

  it('gives two jobs distinct ids', () => {
    const a = buildJob({ url: '/x', body: {} });
    const b = buildJob({ url: '/x', body: {} });
    expect(a.id).not.toBe(b.id);
  });
});

describe('addJob / removeJobs', () => {
  it('appends without mutating the original array', () => {
    const original = [buildJob({ url: '/x', body: {} })];
    const next = addJob(original, buildJob({ url: '/y', body: {} }));
    expect(original.length).toBe(1);
    expect(next.length).toBe(2);
  });

  it('removes only the named ids, preserving order of the rest', () => {
    const a = buildJob({ url: '/a', body: {} });
    const b = buildJob({ url: '/b', body: {} });
    const c = buildJob({ url: '/c', body: {} });
    const next = removeJobs([a, b, c], [b.id]);
    expect(next.map((j) => j.url)).toEqual(['/a', '/c']);
  });

  it('is a no-op when the id is not present', () => {
    const a = buildJob({ url: '/a', body: {} });
    expect(removeJobs([a], ['does-not-exist'])).toEqual([a]);
  });
});

describe('markFailed', () => {
  it('increments attempts and records the error on only the matching job', () => {
    const a = buildJob({ url: '/a', body: {} });
    const b = buildJob({ url: '/b', body: {} });
    const next = markFailed([a, b], a.id, 'timed out');
    const updatedA = next.find((j) => j.id === a.id);
    const updatedB = next.find((j) => j.id === b.id);
    expect(updatedA.attempts).toBe(1);
    expect(updatedA.lastError).toBe('timed out');
    expect(updatedB.attempts).toBe(0);
    expect(updatedB.lastError).toBeUndefined();
  });

  it('accumulates across repeated failures of the same job', () => {
    const a = buildJob({ url: '/a', body: {} });
    let queue = markFailed([a], a.id, 'first');
    queue = markFailed(queue, a.id, 'second');
    expect(queue[0].attempts).toBe(2);
    expect(queue[0].lastError).toBe('second');
  });
});

describe('isQueueableFailure', () => {
  it('queues a timeout (AbortError)', () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    expect(isQueueableFailure(error)).toBe(true);
  });

  it('queues a connection-level failure (fetch throws TypeError)', () => {
    expect(isQueueableFailure(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('does not queue a real server error response (a plain Error from a non-ok response)', () => {
    expect(isQueueableFailure(new Error('match_key and team_key required'))).toBe(false);
  });

  it('does not queue when there is no error object at all', () => {
    expect(isQueueableFailure(undefined)).toBe(false);
  });
});
