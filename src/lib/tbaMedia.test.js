import { describe, expect, it } from 'vitest';
import { bestTeamPhoto, matchVideoSources, matchVideoUrl, mediaImageUrl } from './tbaMedia.js';

describe('TBA media helpers', () => {
  it('prefers a robot photo over an avatar', () => {
    const avatar = { type: 'avatar', preferred: true, details: { base64Image: 'abc' } };
    const photo = { type: 'smugmug-photo', direct_url: 'https://img.example/robot.jpg' };
    expect(bestTeamPhoto([avatar, photo])).toBe(photo);
    expect(mediaImageUrl(photo)).toBe('https://img.example/robot.jpg');
  });

  it('uses YouTube when a match has video and TBA otherwise', () => {
    expect(matchVideoUrl({ key: '2026cc_qm1', videos: [{ type: 'youtube', key: 'abc123' }] })).toBe('https://www.youtube.com/watch?v=abc123');
    expect(matchVideoUrl({ key: '2026cc_qm2', videos: [] })).toBe('https://www.thebluealliance.com/match/2026cc_qm2');
  });

  it('resolves zero, one, and multiple supported match videos with provenance', () => {
    expect(matchVideoSources({ key: '2026cc_qm1', videos: [] })).toEqual([]);
    expect(matchVideoSources({ key: '2026cc_qm1', videos: [{ type: 'youtube', key: 'abc' }] })).toEqual([
      expect.objectContaining({ provider: 'youtube', external_id: 'abc', review_only: true, calibrated: false })
    ]);
    expect(matchVideoSources({ key: '2026cc_qm1', videos: [
      { type: 'youtube', key: 'abc' }, { type: 'twitch', key: '123' }, { type: 'unknown', key: 'x' }
    ] })).toHaveLength(2);
  });
});
