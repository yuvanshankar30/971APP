import { describe, expect, it } from 'vitest';
import { emitNestingGcode } from './gcodeEmit.js';
import {
  assertProgramTypeCompatible,
  dialectForProgramType,
  nextCutProgramType,
  singleProgramType
} from './programType.js';

// End-to-end simulation of the real JProg user flow this feature enables:
// one sheet, two cuts, each cut independently locked to its own G-code type
// (LinuxCNC .ngc vs WinCNC .tap), each emitting a correctly self-consistent
// document, and a cut's lock releasing once it's emptied back out so the
// other type becomes placeable again. Walks through the same sequence of
// decisions +page.svelte makes on every placement/deletion, using the same
// pure functions it calls, rather than re-implementing the logic.
describe('JProg: mixed .ngc/.tap program types across cuts on one sheet', () => {
  it('lets two cuts on the same sheet lock to different program types independently', () => {
    // Cut A: place a router971 (.ngc) part.
    let cutAType = null;
    const ngcType = singleProgramType(['plate.ngc']);
    assertProgramTypeCompatible(cutAType, ngcType); // does not throw - cut is unlocked
    cutAType = ngcType;
    expect(cutAType).toBe('ngc');

    // Cut B: place a WinCNC (.tap) part. Must not be blocked by Cut A's lock.
    let cutBType = null;
    const tapType = singleProgramType(['plate.tap']);
    assertProgramTypeCompatible(cutBType, tapType);
    cutBType = tapType;
    expect(cutBType).toBe('tap');

    // Each cut now rejects the OTHER type, independently.
    expect(() => assertProgramTypeCompatible(cutAType, 'tap')).toThrow('uses .ngc');
    expect(() => assertProgramTypeCompatible(cutBType, 'ngc')).toThrow('uses .tap');
    // But each cut still accepts more of its own type.
    expect(() => assertProgramTypeCompatible(cutAType, 'ngc')).not.toThrow();
    expect(() => assertProgramTypeCompatible(cutBType, 'tap')).not.toThrow();
  });

  it('emits each cut as its own self-consistent document in its own dialect, never cross-contaminated', () => {
    const cutADialect = dialectForProgramType('ngc');
    const cutBDialect = dialectForProgramType('tap');
    expect(cutADialect).toBe('linuxcnc');
    expect(cutBDialect).toBe('wincnc');

    const cutAResult = emitNestingGcode({
      name: 'Sheet 1',
      filenameSuffix: 'Cut A',
      suffixCount: 2,
      dialect: cutADialect,
      placements: [{ label: 'RouterPart', x: 2, y: 3, part_library_path: 'router-part' }],
      programs: { 'router-part': { source: 'G1 X1 Y2\nM30' } }
    });
    const cutBResult = emitNestingGcode({
      name: 'Sheet 1',
      filenameSuffix: 'Cut B',
      suffixCount: 2,
      dialect: cutBDialect,
      placements: [{ label: 'WinPart', x: 2, y: 3, part_library_path: 'win-part' }],
      programs: { 'win-part': { source: 'T1\nG1 X1 Y2\nM5' } }
    });

    // Filenames follow each cut's own type.
    expect(cutAResult.filename).toBe('Sheet_1_Cut_A.ngc');
    expect(cutBResult.filename).toBe('Sheet_1_Cut_B.tap');

    // LinuxCNC document: percent-bracketed header/footer, G59.3 work-offset
    // placement, single M30 - and NONE of WinCNC's tool-block syntax.
    expect(cutAResult.text).toContain('%\nG90 G94 G17 G91.1');
    expect(cutAResult.text).toContain('G59.3');
    expect(cutAResult.text.match(/M30/g)).toHaveLength(1);
    expect(cutAResult.text).not.toContain('[Tool');
    expect(cutAResult.text).not.toContain('G53 P10');

    // WinCNC document: bracket comments, explicit tool block, G53 P10 park -
    // and none of LinuxCNC's G59.3/percent framing.
    expect(cutBResult.text).toContain('[Tool 1]\nT1');
    expect(cutBResult.text).toContain('G53 P10');
    expect(cutBResult.text).not.toContain('G59.3');
    expect(cutBResult.text).not.toContain('%\nG90 G94');
  });

  it('releases a cut\'s type lock once every part is removed, so the other type becomes placeable again', () => {
    const ngcPart = { kind: 'part', part_library_path: 'a' };
    const hole = { kind: 'hole' };

    // Locked with a part present: stays locked.
    expect(nextCutProgramType('ngc', [ngcPart])).toBe('ngc');
    // Deleting the last part, even with a hole still on the cut: unlocks.
    // Holes are dialect-neutral (bundled hole program) and never keep the
    // file-type lock held on their own.
    expect(nextCutProgramType('ngc', [hole])).toBeNull();
    // Deleting everything: unlocks.
    expect(nextCutProgramType('ngc', [])).toBeNull();
    // A cut that was never locked stays unlocked regardless of placements.
    expect(nextCutProgramType(null, [])).toBeNull();
    expect(nextCutProgramType(null, [ngcPart])).toBeNull();

    // Simulate the real sequence: Cut A is placed with .ngc, then that part
    // is deleted, then a .tap part is placed on the SAME cut - this must
    // succeed now that the cut emptied out, where it would have thrown
    // before this fix (the type used to never release).
    let cutAType = 'ngc';
    cutAType = nextCutProgramType(cutAType, []); // last part just deleted
    expect(cutAType).toBeNull();
    const nextType = singleProgramType(['other-plate.tap']);
    expect(() => assertProgramTypeCompatible(cutAType, nextType)).not.toThrow();
    cutAType = nextType;
    expect(cutAType).toBe('tap');
  });
});
