import { describe, expect, it } from 'vitest';
import { githubContentsPayload, githubJprogOutputPath } from './jprog_output_github.js';

describe('JProg GitHub output', () => {
  it('maps the Manufacturing Files path to the repository daily folder', () => {
    expect(githubJprogOutputPath('Jprog Output/20260912/plate.ngc')).toBe('20260912/plate.ngc');
  });
  it('rejects paths outside the JProg output convention', () => {
    expect(() => githubJprogOutputPath('Nesting Output/20260912/plate.ngc')).toThrow('JProg output');
    expect(() => githubJprogOutputPath('Jprog Output/20260912/../secrets.txt')).toThrow('Invalid');
  });
  it('creates a GitHub Contents API payload with base64 G-code', () => {
    expect(githubContentsPayload('20260912/plate.ngc', 'G20\nM30')).toEqual({ message: 'Add JProg output 20260912/plate.ngc', content: 'RzIwCk0zMA==' });
  });
});
