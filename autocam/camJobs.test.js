import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getSession: vi.fn(),
  single: vi.fn(),
  updateMaybeSingle: vi.fn(),
  readMaybeSingle: vi.fn(),
  updateQueries: [],
  updates: []
}));

vi.mock('$lib/supabase.js', () => ({
  supabase: {
    auth: { getSession: mocks.getSession },
    from: mocks.from
  }
}));

import {
  camJobStatusLabel,
  gcodeFileNameFor,
  jobDisplayName,
  TERMINAL_CAM_JOB_STATUSES,
  triggerGenerationAndRefetch
} from './camJobs.js';

describe('camJobs display helpers', () => {
  it.each([
    ['Upper Control Arm.step', 'ngc', 'upper-control-arm-step.ngc'],
    ['  weird---name!!.STP  ', 'tap', 'weird-name-stp.tap'],
    ['éø', 'invalid', 'part.ngc'],
    ['', undefined, 'part.ngc']
  ])('builds a safe filename from %j', (name, extension, expected) => {
    expect(gcodeFileNameFor(name, extension)).toBe(expected);
  });

  it.each([
    ['queued', 'Generating CAM'],
    ['claimed', 'Generating CAM'],
    ['processing', 'Generating CAM'],
    ['completed', 'Completed'],
    ['failed', 'Autocam Failed'],
    ['rejected', 'Job Rejected'],
    ['future-status', 'future-status'],
    [null, '']
  ])('labels status %j as %j', (status, expected) => {
    expect(camJobStatusLabel(status)).toBe(expected);
  });

  it('uses the documented display-name fallback order', () => {
    expect(jobDisplayName({ name: 'Operator name', source_type: 'part', parts: { name: 'Part name' } })).toBe('Operator name');
    expect(jobDisplayName({ source_type: 'part', parts: { name: 'Part name' }, part_id: 7 })).toBe('Part name');
    expect(jobDisplayName({ source_type: 'part', part_id: 7 })).toBe('Part #7');
    expect(jobDisplayName({ source_type: 'upload', step_file_name: 'cam-jobs/folder/Bracket.step' })).toBe('Bracket.step');
    expect(jobDisplayName({})).toBe('Untitled job');
  });
});

describe('triggerGenerationAndRefetch terminal status guarantee', () => {
  beforeEach(() => {
    mocks.updates.length = 0;
    mocks.updateQueries.length = 0;
    mocks.getSession.mockReset().mockResolvedValue({ data: { session: { access_token: 'test-token' } } });
    mocks.single.mockReset();
    mocks.updateMaybeSingle.mockReset().mockImplementation(async (payload) => ({ data: { id: 'failed-job', ...payload }, error: null }));
    mocks.readMaybeSingle.mockReset().mockResolvedValue({ data: null, error: null });
    mocks.from.mockReset().mockImplementation(() => ({
      select: () => ({ eq: () => ({ single: mocks.single, maybeSingle: mocks.readMaybeSingle }) }),
      update: (payload) => {
        mocks.updates.push(payload);
        const query = {};
        for (const method of ['eq', 'in', 'select']) query[method] = vi.fn(() => query);
        query.maybeSingle = () => mocks.updateMaybeSingle(payload);
        mocks.updateQueries.push(query);
        return query;
      }
    }));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function expectTerminal(job) {
    expect(TERMINAL_CAM_JOB_STATUSES).toContain(job.status);
  }

  it.each(['completed', 'failed', 'rejected'])('returns a polled %s status unchanged', async (status) => {
    mocks.single.mockResolvedValue({ data: { id: 'job-1', status }, error: null });
    const result = await triggerGenerationAndRefetch('job-1', null, { pollMs: 0, timeoutMs: 20 });
    expect(result).toEqual({ id: 'job-1', status });
    expectTerminal(result);
    expect(mocks.updates).toEqual([]);
  });

  it('turns a missing progress row into a persisted failure', async () => {
    mocks.single.mockResolvedValue({ data: null, error: null });
    const result = await triggerGenerationAndRefetch('missing', null, { pollMs: 0, timeoutMs: 20 });
    expectTerminal(result);
    expect(mocks.updates.at(-1).errors[0]).toContain('could not be found');
    expect(mocks.updates.at(-1)).toMatchObject({ status: 'failed' });
    expect(mocks.updateQueries.at(-1).in).toHaveBeenCalledWith('status', ['queued', 'claimed', 'processing']);
  });

  it('turns a session lookup failure into a terminal result before fetching', async () => {
    mocks.getSession.mockResolvedValue({ data: null, error: { message: 'auth storage unavailable' } });
    const result = await triggerGenerationAndRefetch('auth-error', null, { pollMs: 0, timeoutMs: 20 });
    expectTerminal(result);
    expect(result.errors[0]).toContain('auth storage unavailable');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('times out a server request that never settles and persists failed', async () => {
    vi.useFakeTimers();
    globalThis.fetch.mockImplementation(() => new Promise(() => {}));
    mocks.single.mockResolvedValue({ data: { id: 'slow', status: 'queued' }, error: null });
    const pending = triggerGenerationAndRefetch('slow', null, { pollMs: 10, timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(30);
    const result = await pending;
    expectTerminal(result);
    expect(result.errors[0]).toContain('within 0.02s');
    expect(mocks.updates.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('turns a rejected polling query into a terminal failure', async () => {
    mocks.single.mockRejectedValue(new Error('database offline'));
    const result = await triggerGenerationAndRefetch('poll-error', null, { pollMs: 0, timeoutMs: 20 });
    expectTerminal(result);
    expect(result.errors[0]).toContain('database offline');
  });

  it('turns an HTTP generation failure into a terminal failure', async () => {
    globalThis.fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'generator exploded' }) });
    mocks.single.mockResolvedValue({ data: { id: 'http-error', status: 'queued' }, error: null });
    const result = await triggerGenerationAndRefetch('http-error', null, { pollMs: 0, timeoutMs: 20 });
    expectTerminal(result);
    expect(result.errors[0]).toContain('generator exploded');
  });

  it('returns failed even when the terminal database write also fails', async () => {
    mocks.single.mockResolvedValue({ data: null, error: { message: 'row missing' } });
    mocks.updateMaybeSingle.mockRejectedValue(new Error('write unavailable'));
    const result = await triggerGenerationAndRefetch('write-error', null, { pollMs: 0, timeoutMs: 20 });
    expectTerminal(result);
    expect(result.status).toBe('failed');
  });

  it('returns a terminal row that wins the timeout race instead of overwriting it', async () => {
    mocks.single.mockResolvedValue({ data: null, error: { message: 'poll raced' } });
    mocks.updateMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.readMaybeSingle.mockResolvedValue({ data: { id: 'race', status: 'completed', gcode: 'M30' }, error: null });
    const result = await triggerGenerationAndRefetch('race', null, { pollMs: 0, timeoutMs: 20 });
    expect(result).toMatchObject({ id: 'race', status: 'completed', gcode: 'M30' });
  });
});
