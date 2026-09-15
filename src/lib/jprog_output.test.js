import { describe, expect, it } from 'vitest';
import { isJprogOutputPath, jprogOutputUploadPath } from './jprog_output.js';

describe('isJprogOutputPath', () => {
	it('accepts dated JProg G-code output', () => {
		expect(isJprogOutputPath('JustinProgOutput/20260913/main_plate.ngc')).toBe(true);
		expect(isJprogOutputPath('JustinProgOutput/20260913/holes.tap')).toBe(true);
	});

	it('rejects files outside the JProg dated output convention', () => {
		expect(isJprogOutputPath('JustinProgOutput/main_plate.ngc')).toBe(false);
		expect(isJprogOutputPath('JustinProgOutput/20260913/main plate.ngc')).toBe(true);
		expect(isJprogOutputPath('Manufacturing/main_plate.ngc')).toBe(false);
	});
});

describe('jprogOutputUploadPath', () => {
	it('uses the Pacific calendar day for files uploaded at the JProg root', () => {
		expect(jprogOutputUploadPath('JustinProgOutput', 'manual.tap', new Date('2026-09-15T02:00:00Z')))
			.toBe('JustinProgOutput/20260914/manual.tap');
	});

	it('keeps manual files in an existing date folder', () => {
		expect(jprogOutputUploadPath('JustinProgOutput/20260912', 'extra.ngc'))
			.toBe('JustinProgOutput/20260912/extra.ngc');
	});

	it('leaves other Files-tab folders alone', () => {
		expect(jprogOutputUploadPath('AutoCAM', 'job.tap')).toBeNull();
	});

	it('rejects unsupported files in JProg Output', () => {
		expect(() => jprogOutputUploadPath('JustinProgOutput', 'notes.txt')).toThrow(/only \.ngc or \.tap/);
		expect(() => jprogOutputUploadPath('JustinProgOutput', 'nested/file.tap')).toThrow(/without path separators/);
	});
});
