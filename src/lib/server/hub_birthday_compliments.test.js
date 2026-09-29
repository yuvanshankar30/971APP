import { describe, it, expect } from 'vitest';
import {
  COMPLIMENT_POOL,
  CELEBRATED_PEOPLE,
  findCelebratedPerson,
  pickCompliments,
  birthdayComplimentBlock
} from './hub_birthday_compliments.js';

// A deterministic stand-in for Math.random so a test can pin which
// compliments come out; production passes nothing and gets a real handful.
const fixedRandom = (value) => () => value;

describe('COMPLIMENT_POOL', () => {
  it('has the fifty that were asked for, all distinct', () => {
    expect(COMPLIMENT_POOL).toHaveLength(50);
    expect(new Set(COMPLIMENT_POOL).size).toBe(50);
  });

  it('writes every line with a {name} slot so one pool serves everyone', () => {
    for (const line of COMPLIMENT_POOL) expect(line).toContain('{name}');
  });
});

describe('findCelebratedPerson', () => {
  it('finds each of them by full name or first name', () => {
    expect(findCelebratedPerson('rate yuvan shankar out of 10').name).toBe('Yuvan Shankar');
    expect(findCelebratedPerson('what do you think of Arnav?').name).toBe('Arnav Gathani');
    expect(findCelebratedPerson('how good is omer').name).toBe('Omer Har Gill');
  });

  it('prefers the longest alias so a full name never resolves to someone else', () => {
    expect(findCelebratedPerson('omer har gill').name).toBe('Omer Har Gill');
  });

  it('does not fire on a word that merely contains a name', () => {
    // A part number or an unrelated word must not drag a birthday into an
    // answer that had nothing to do with it.
    expect(findCelebratedPerson('what is the omerta protocol')).toBeNull();
    expect(findCelebratedPerson('part ARNAVX-12 status')).toBeNull();
  });

  it('returns null for everyone else', () => {
    expect(findCelebratedPerson('what do you think of Casey Scout?')).toBeNull();
    expect(findCelebratedPerson('')).toBeNull();
    expect(findCelebratedPerson(null)).toBeNull();
  });
});

describe('pickCompliments', () => {
  const person = { name: 'Test Person' };

  it('picks between five and ten', () => {
    for (const value of [0, 0.25, 0.5, 0.75, 0.999]) {
      const picked = pickCompliments(person, { random: fixedRandom(value) });
      expect(picked.length).toBeGreaterThanOrEqual(5);
      expect(picked.length).toBeLessThanOrEqual(10);
    }
  });

  it('never repeats one within a single answer', () => {
    const picked = pickCompliments(person, { random: Math.random });
    expect(new Set(picked).size).toBe(picked.length);
  });

  it('substitutes the name everywhere, leaving no placeholder behind', () => {
    const picked = pickCompliments(person, { random: Math.random });
    for (const line of picked) {
      expect(line).toContain('Test Person');
      expect(line).not.toContain('{name}');
    }
  });

  it('gives a different handful on different draws - the point of sampling', () => {
    const draws = new Set(
      Array.from({ length: 12 }, () => pickCompliments(person, { random: Math.random }).join('|'))
    );
    expect(draws.size).toBeGreaterThan(1);
  });

  it('cannot ask for more than the pool holds', () => {
    const picked = pickCompliments(person, { random: fixedRandom(0.999), pool: COMPLIMENT_POOL.slice(0, 3) });
    expect(picked).toHaveLength(3);
  });
});

describe('birthdayComplimentBlock', () => {
  it('is empty for a question about anybody else, so the prompt stays lean', () => {
    expect(birthdayComplimentBlock('what does a router job track?')).toBe('');
    expect(birthdayComplimentBlock('what do you think of Casey Scout?')).toBe('');
  });

  it('carries the 100/10 rating and the sampled compliments', () => {
    const block = birthdayComplimentBlock('rate Arnav Gathani out of 10', { random: fixedRandom(0.5) });
    expect(block).toContain('ABOUT ARNAV GATHANI');
    expect(block).toContain('100/10');
    expect(block).toContain('Arnav Gathani');
    expect(block).not.toContain('{name}');
  });

  it('states the creator fact for Yuvan and claims nothing extra for the others', () => {
    // Only one of these is a fact about the codebase. Inventing biography
    // for the other two is not something a joke justifies.
    expect(birthdayComplimentBlock('who is yuvan', { random: fixedRandom(0.5) }))
      .toContain('created Spartans Hub');
    expect(birthdayComplimentBlock('who is omer', { random: fixedRandom(0.5) }))
      .not.toContain('created Spartans Hub');
    expect(CELEBRATED_PEOPLE.filter((person) => person.signature)).toHaveLength(1);
  });

  it('keeps the carve-out explicitly limited to the person named', () => {
    const block = birthdayComplimentBlock('how good is omer', { random: fixedRandom(0.5) });
    expect(block).toContain('and to nobody else');
    expect(block).toContain('responsibilities, not character');
  });
});
