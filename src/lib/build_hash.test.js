import { describe, it, expect } from 'vitest';
import { computeBuildHash } from './build_hash.js';

describe('computeBuildHash', () => {
  it('produces a deterministic hash for the same inputs', () => {
    const a = computeBuildHash('doc123', 'subsys-uuid-abc', 'version-uuid-def');
    const b = computeBuildHash('doc123', 'subsys-uuid-abc', 'version-uuid-def');
    expect(a).toBe(b);
  });

  it('produces different hashes for different inputs', () => {
    const a = computeBuildHash('doc123', 'subsys-uuid-abc', 'version-1');
    const b = computeBuildHash('doc123', 'subsys-uuid-abc', 'version-2');
    expect(a).not.toBe(b);
  });

  it('stays well under the 64-character builds.build_hash column limit even with long UUID-shaped inputs', () => {
    const hash = computeBuildHash(
      '3f7f1c556cc08424648a9faa',
      'f6ca104a-8d00-49e5-a2c7-dca89c8f454d',
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
    );
    expect(hash.length).toBeLessThanOrEqual(64);
    expect(hash.length).toBe(16);
  });

  it('ignores undefined/null parts rather than baking the literal string "undefined" into the hash', () => {
    const withNull = computeBuildHash('doc123', null, 'v1');
    const withoutNull = computeBuildHash('doc123', 'v1');
    expect(withNull).toBe(withoutNull);
  });
});
