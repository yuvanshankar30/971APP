import { describe, it, expect } from 'vitest';
import { camelBreakHtml } from './camel_break.js';

describe('camelBreakHtml', () => {
  it('inserts a <wbr> before each internal CamelCase word boundary', () => {
    // Every boundary gets an optional break point - the browser only uses
    // whichever one it actually needs to fit the available width (so
    // "2026ThirdRobot" stays on one line when it fits, wrapping only
    // "Hopper" to the next), rather than this function guessing in advance
    // which single break point will end up being the useful one.
    expect(camelBreakHtml('2026ThirdRobotHopper')).toBe('2026<wbr>Third<wbr>Robot<wbr>Hopper');
  });

  it('does not insert a break at the very start of the string', () => {
    expect(camelBreakHtml('Hopper')).toBe('Hopper');
  });

  it('leaves a string with no CamelCase boundaries untouched', () => {
    expect(camelBreakHtml('drivetrain')).toBe('drivetrain');
    expect(camelBreakHtml('DRIVETRAIN')).toBe('DRIVETRAIN');
  });

  it('escapes HTML-significant characters', () => {
    expect(camelBreakHtml('<Team> & "Robot"')).toBe('&lt;Team&gt; &amp; "Robot"');
  });

  it('handles null/undefined/empty input safely', () => {
    expect(camelBreakHtml(null)).toBe('');
    expect(camelBreakHtml(undefined)).toBe('');
    expect(camelBreakHtml('')).toBe('');
  });

  it('breaks after a digit run immediately before a capital letter', () => {
    expect(camelBreakHtml('2026Indexer')).toBe('2026<wbr>Indexer');
  });
});
