import { describe, expect, it } from 'vitest';
import { isJprogOutputPath, jprogOutputUploadPath } from './jprog_output.js';

describe('isJprogOutputPath', () => {
	it('accepts dated JProg G-code output', () => {
		expect(isJprogOutputPath('Jprog Output/20260913/main_plate.ngc')).toBe(true);
		expect(isJprogOutputPath('Jprog Output/20260913/holes.tap')).toBe(true);
	});

	it('rejects files outside the JProg dated output convention', () => {
		expect(isJprogOutputPath('Jprog Output/main_plate.ngc')).toBe(false);
		expect(isJprogOutputPath('Jprog Output/20260913/main plate.ngc')).toBe(false);
		expect(isJprogOutputPath('Manufacturing/main_plate.ngc')).toBe(false);
	});
});

describe('jprogOutputUploadPath', () => {
	it('puts files uploaded at the JProg root in the UTC date folder', () => {
		expect(jprogOutputUploadPath('Jprog Output', 'manual.tap', new Date('2026-09-13T23:59:00Z')))
			.toBe('Jprog Output/20260913/manual.tap');
	});

	it('keeps manual files in an existing date folder', () => {
		expect(jprogOutputUploadPath('Jprog Output/20260912', 'extra.ngc'))
			.toBe('Jprog Output/20260912/extra.ngc');
	});

	it('leaves other Files-tab folders alone', () => {
		expect(jprogOutputUploadPath('AutoCAM', 'job.tap')).toBeNull();
	});

	it('rejects unsupported files in JProg Output', () => {
		expect(() => jprogOutputUploadPath('Jprog Output', 'notes.txt')).toThrow(/only \.ngc or \.tap/);
	});
});
