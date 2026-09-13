import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('match scouting field cues and rating controls', () => {
  it('has no standalone Unknown rating button or schematic fallback', () => {
    expect(source).not.toMatch(/>Unknown<\/button>/);
    expect(source).not.toContain('Schematic cue');
    expect(source).toContain('aria-pressed={ratings[field] === value}');
  });

  it('keeps click-again deselection and clears the unjudged marker when re-rated', () => {
    const toggle = source.match(/function toggleRating\(field, value\) \{[\s\S]*?\n  \}/)[0];
    const run = new Function(`let ratings = { 'Shot accuracy': 0 }; let ratingsUnknown = [];
      ${toggle}
      toggleRating('Shot accuracy', 3);
      const selected = { ...ratings };
      toggleRating('Shot accuracy', 3);
      const cleared = { ratings: { ...ratings }, unknown: [...ratingsUnknown] };
      toggleRating('Shot accuracy', 4);
      return { selected, cleared, ratings, ratingsUnknown };`);
    expect(run()).toEqual({
      selected: { 'Shot accuracy': 3 },
      cleared: { ratings: { 'Shot accuracy': 0 }, unknown: ['Shot accuracy'] },
      ratings: { 'Shot accuracy': 4 }, ratingsUnknown: []
    });
  });

  it('bundles a real field image with alliance-relative orientation and custom photo overrides', () => {
    const image = readFileSync(new URL('../../../static/rebuilt-2026-field.png', import.meta.url));
    expect(image.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(source).toContain('href="/rebuilt-2026-field.png"');
    expect(source).toContain("alliance === 'red' ? 'translate(100 48.5) rotate(180)'");
    expect(source).toContain('startPhotos[`${alliance}:${position}`]');
  });
});
