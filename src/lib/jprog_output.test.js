import { describe, expect, it } from 'vitest';
import { isJprogOutputPath } from './jprog_output.js';

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
