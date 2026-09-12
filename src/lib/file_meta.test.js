import { describe, it, expect } from 'vitest';
import { getFileMeta, getStepFileName, canViewCad, getPdfFileName, canViewPdf, fileRequirementError } from './file_meta.js';

describe('getFileMeta / getStepFileName / getPdfFileName', () => {
  it('parses a step_file meta blob', () => {
    const item = { file_url: JSON.stringify({ step_file: 'abc.step', step_valid: true }) };
    expect(getFileMeta(item)).toEqual({ step_file: 'abc.step', step_valid: true });
    expect(getStepFileName(item)).toBe('abc.step');
    expect(canViewCad(item)).toBe(true);
    expect(getPdfFileName(item)).toBeNull();
    expect(canViewPdf(item)).toBe(false);
  });

  it('parses a pdf_file meta blob', () => {
    const item = { file_url: JSON.stringify({ pdf_file: 'drawing.pdf' }) };
    expect(getPdfFileName(item)).toBe('drawing.pdf');
    expect(canViewPdf(item)).toBe(true);
    expect(canViewCad(item)).toBe(false);
  });

  it('falls back to file_name extension when file_url has no meta', () => {
    expect(getStepFileName({ file_name: 'part.stp' })).toBe('part.stp');
    expect(getPdfFileName({ file_name: 'drawing.PDF' })).toBe('drawing.PDF');
  });

  it('handles missing/blank/invalid file_url safely', () => {
    expect(getFileMeta({})).toEqual({});
    expect(getFileMeta({ file_url: '' })).toEqual({});
    expect(getFileMeta({ file_url: 'not json' })).toEqual({});
    expect(canViewCad({})).toBe(false);
    expect(canViewPdf(null)).toBe(false);
  });
});

describe('fileRequirementError', () => {
  it('requires a STEP file for router', () => {
    expect(fileRequirementError({ workflow: 'router' })).toMatch(/STEP/);
    expect(fileRequirementError({ workflow: 'router', file_url: JSON.stringify({ step_file: 'a.step' }) })).toBeNull();
  });

  it('requires a PDF for lathe, with STEP optional', () => {
    expect(fileRequirementError({ workflow: 'lathe' })).toMatch(/PDF/);
    expect(fileRequirementError({ workflow: 'lathe', file_url: JSON.stringify({ step_file: 'a.step' }) })).toMatch(/PDF/);
    expect(fileRequirementError({ workflow: 'lathe', file_url: JSON.stringify({ pdf_file: 'a.pdf' }) })).toBeNull();
    expect(fileRequirementError({ workflow: 'lathe', file_url: JSON.stringify({ step_file: 'a.step', pdf_file: 'a.pdf' }) })).toBeNull();
  });

  it('requires a STEP file for 3d-print', () => {
    expect(fileRequirementError({ workflow: '3d-print' })).toMatch(/STEP/);
    expect(fileRequirementError({ workflow: '3d-print', file_url: JSON.stringify({ step_file: 'a.step' }) })).toBeNull();
  });

  it('requires nothing for mill or laser-cut', () => {
    expect(fileRequirementError({ workflow: 'mill' })).toBeNull();
    expect(fileRequirementError({ workflow: 'laser-cut' })).toBeNull();
  });
});
