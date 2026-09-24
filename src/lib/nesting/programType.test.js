import { describe, expect, it } from 'vitest';
import { assertProgramTypeCompatible, dialectForProgramType, programTypeForName, singleProgramType } from './programType.js';
import { parseGcodeDocument } from './gcodeDocument.js';

describe('JProg program types', () => {
	it('identifies supported program extensions without case sensitivity', () => {
		expect(programTypeForName('plate.NGC')).toBe('ngc');
		expect(programTypeForName('plate.tap')).toBe('tap');
	});

	it('rejects a mixed upload batch', () => {
		expect(() => singleProgramType(['plate.ngc', 'plate.tap'])).toThrow('cannot mix');
	});

	it('locks a cut to its initial program type and derives its dialect', () => {
		expect(() => assertProgramTypeCompatible('tap', 'ngc')).toThrow('uses .tap');
		expect(dialectForProgramType('tap')).toBe('wincnc');
		expect(dialectForProgramType('ngc')).toBe('linuxcnc');
	});

	it('treats .tap inspection programs as ShopSabre WinCNC', () => {
		expect(parseGcodeDocument('G20\nG00 X0 Y0', 'part.tap').dialect).toBe('wincnc');
	});
});
