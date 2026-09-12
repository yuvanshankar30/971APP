import { describe, it, expect } from 'vitest';
import { scheduleOnshapeRequest } from './onshape_rate_limiter.js';

describe('scheduleOnshapeRequest', () => {
  it('resolves with the scheduled function\'s return value', async () => {
    const result = await scheduleOnshapeRequest(() => 'ok');
    expect(result).toBe('ok');
  });

  it('runs requests in the order they were scheduled', async () => {
    const order = [];
    const a = scheduleOnshapeRequest(() => { order.push('a'); return 'a'; });
    const b = scheduleOnshapeRequest(() => { order.push('b'); return 'b'; });
    const c = scheduleOnshapeRequest(() => { order.push('c'); return 'c'; });
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('spaces successive requests apart instead of firing them all at once', async () => {
    const timestamps = [];
    const requests = [1, 2, 3].map(() =>
      scheduleOnshapeRequest(() => { timestamps.push(Date.now()); })
    );
    await Promise.all(requests);
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(190);
    expect(timestamps[2] - timestamps[1]).toBeGreaterThanOrEqual(190);
  }, 10000);

  it('does not let one failing request wedge the queue for requests behind it', async () => {
    const failing = scheduleOnshapeRequest(() => { throw new Error('boom'); });
    const after = scheduleOnshapeRequest(() => 'still runs');

    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('still runs');
  });
});
