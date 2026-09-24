import { describe, expect, it } from "vitest";
import { buildEmitFilename } from "./emitFilename.js";
import { emitNestingGcode, nestingEmissionTools } from "./gcodeEmit.js";
import { parseGcodeDocument } from "./gcodeDocument.js";
import {
  clampPlacementToSheet,
  placementContains,
  placementHasEdgeClearance,
  rotatePlacement,
  sheetContains,
} from "./sheetModel.js";
import { screenToSheet, sheetToScreen, zoomAt } from "./coords.js";
import { createUndoStack } from "./undoStack.js";
import { emittedGcodePath, sheetPartLibraryRoot } from "./storage.js";
import { parseGcodeToolpath, toolpathBounds } from "./gcodeToolpath.js";
import { HOLE_HEAD_SIZE_IN, holeProgramForThickness } from "./holePrograms.js";
import {
  placementCollisionPairs,
  placementsOverlap,
  validateCut,
} from "./validation.js";

describe("nesting geometry", () => {
  it("parses linear and arc G-code into a contour preview", () => {
    const segments = parseGcodeToolpath(
      "G90\nG0 X0 Y0\nG1 X2 Y0\nG3 X2 Y2 I0 J1",
    );
    expect(segments).toHaveLength(3);
    expect(segments[2].points.length).toBeGreaterThan(6);
    expect(toolpathBounds(segments)).toMatchObject({
      minX: 0,
      minY: 0,
      maxX: 3,
      maxY: 2,
    });
  });
  it("excludes rapid transit moves from placement bounds", () => {
    const segments = parseGcodeToolpath("G0 X100 Y100\nG1 X101 Y100\nG0 X0 Y0");
    expect(toolpathBounds(segments)).toMatchObject({ minX: 100, maxX: 101, minY: 100, maxY: 100 });
    expect(toolpathBounds(segments, { includeRapid: true })).toMatchObject({ minX: 0, maxX: 101, minY: 0, maxY: 100 });
  });
  it("excludes rapid transit moves from a parsed document's bounds", () => {
    const document = parseGcodeDocument("G0 X100 Y100\nG1 X101 Y100\nG0 X0 Y0");
    expect(document.bounds).toMatchObject({ minX: 100, maxX: 101 });
  });
  it("round-trips positive sheet coordinates through the canvas view", () => {
    const view = { scale: 20, originX: 10, originY: 300 };
    expect(screenToSheet(sheetToScreen({ x: 4.5, y: 8 }, view), view)).toEqual({
      x: 4.5,
      y: 8,
    });
  });
  it("keeps the point under the cursor fixed while zooming", () => {
    const view = { scale: 20, originX: 10, originY: 300 },
      cursor = { x: 210, y: 160 };
    expect(screenToSheet(cursor, zoomAt(view, cursor, 1.5))).toEqual(
      screenToSheet(cursor, view),
    );
  });
  it("uses rotation-aware bounds for sheet containment without mutating part dimensions", () => {
    // x is negative - sheet (0,0) is the lower-right corner, matching real
    // JProg (see sheetModel.js's own header comment).
    const item = rotatePlacement({
      x: -3,
      y: 3,
      width_in: 3,
      height_in: 1,
      rotation: 0,
    });
    expect(item.width_in).toBe(3);
    expect(item.height_in).toBe(1);
    expect(sheetContains({ width_in: 4, height_in: 4 }, item)).toBe(false);
    expect(placementContains(item, -3, 3)).toBe(true);
  });
  it("supports rotating in either direction without snapping the stored angle", () => {
    const item = rotatePlacement({ rotation: 0 }, -0.25);
    expect(item.rotation).toBeCloseTo(-Math.PI / 8);
  });
  it("snaps a valid edge placement inside the stock rather than rejecting it", () => {
    // Near the LEFT edge (-48) this time, since (0,0) is the lower-right
    // corner - mirrors the old near-right-edge case under the new convention.
    const result = clampPlacementToSheet(
      { width_in: 48, height_in: 24 },
      { x: -0.1, y: 23.9, width_in: 2, height_in: 2, rotation: 0 },
    );
    expect(result).toMatchObject({ x: -1, y: 23 });
    expect(sheetContains({ width_in: 48, height_in: 24 }, result)).toBe(true);
  });
  it("rejects only a placement that is larger than the sheet itself", () => {
    expect(
      clampPlacementToSheet(
        { width_in: 4, height_in: 4 },
        { x: -2, y: 2, width_in: 5, height_in: 1, rotation: 0 },
      ),
    ).toBeNull();
  });
  it("requires holes to stay clear of sheet edges", () => {
    const sheet = { width_in: 48, height_in: 24 };
    expect(
      placementHasEdgeClearance(sheet, {
        x: -47.85,
        y: 12,
        width_in: 0.3,
        height_in: 0.3,
      }),
    ).toBe(false);
    expect(
      placementHasEdgeClearance(
        sheet,
        { x: -47.75, y: 12, width_in: 0.3, height_in: 0.3 },
        0.05,
      ),
    ).toBe(true);
  });
});

describe("nesting edit history", () => {
  it("undoes and redoes a committed placement state", () => {
    const stack = createUndoStack([]);
    stack.commit([{ id: "a" }]);
    expect(stack.undo()).toEqual([]);
    expect(stack.redo()).toEqual([{ id: "a" }]);
  });
  it("restores persisted undo history after a refresh", () => {
    const stack = createUndoStack([]);
    stack.commit([{ id: "a" }]);
    stack.commit([{ id: "a" }, { id: "b" }]);
    const restored = createUndoStack([], stack.snapshot);
    expect(restored.undo()).toEqual([{ id: "a" }]);
    expect(restored.redo()).toEqual([{ id: "a" }, { id: "b" }]);
  });
});

describe("nesting validation", () => {
  const sheet = { width_in: 10, height_in: 10 };
  it("detects genuinely overlapping rotated parts", () => {
    const first = {
      id: "a",
      label: "A",
      x: 3,
      y: 4,
      width_in: 2,
      height_in: 1,
      rotation: Math.PI / 4,
    };
    const second = {
      id: "b",
      label: "B",
      x: 4.2,
      y: 4,
      width_in: 2,
      height_in: 1,
      rotation: 0,
    };
    expect(placementsOverlap(first, second, 0.1)).toBe(true);
    expect(placementCollisionPairs([first, second], 0.1)).toHaveLength(1);
  });
  it("allows parts that only touch at their bounds", () => {
    expect(
      placementsOverlap(
        { x: 1, y: 1, width_in: 2, height_in: 2, rotation: 0 },
        { x: 3, y: 1, width_in: 2, height_in: 2, rotation: 0 },
      ),
    ).toBe(false);
  });
  it("allows parts to extend beyond the sheet for machining offsets", () => {
    const issues = validateCut({
      sheet,
      programPaths: ["kept"],
      placements: [
        {
          id: "outside",
          kind: "part",
          label: "Outside",
          x: 9.5,
          y: 5,
          width_in: 2,
          height_in: 2,
          part_library_path: "kept",
        },
        {
          id: "missing",
          kind: "part",
          label: "Missing",
          x: 3,
          y: 3,
          width_in: 1,
          height_in: 1,
          part_library_path: "gone",
        },
      ],
    });
    expect(issues.map((issue) => issue.type)).not.toContain("outside-sheet");
    expect(issues.map((issue) => issue.type)).toContain("missing-program");
  });
  it("does not treat overlapping toolpath envelopes as export errors", () => {
    const issues = validateCut({
      sheet,
      programPaths: ["first", "second"],
      placements: [
        { id: "first", kind: "part", label: "First", x: 4, y: 4, width_in: 4, height_in: 4, part_library_path: "first" },
        { id: "second", kind: "part", label: "Second", x: 5, y: 4, width_in: 4, height_in: 4, part_library_path: "second" }
      ]
    });
    expect(issues.map((issue) => issue.type)).not.toContain("collision");
  });
});

describe("nesting emission", () => {
  it("uses the Pacific calendar day for emitted output paths", () => {
    expect(emittedGcodePath("plate.tap", new Date("2026-09-15T02:00:00Z"))).toBe("JustinProgOutput/20260914/plate.tap");
  });
  it("uses the original JProg screw-head envelope and thickness hole routine", () => {
    expect(HOLE_HEAD_SIZE_IN).toBe(0.4);
    expect(holeProgramForThickness("0.125")).toContain(".3 CIRCLUAR THROUGH HOLE");
  });
  it("writes each emission into the JustinProgOutput folder for its UTC day", () => {
    expect(emittedGcodePath("nest.ngc", new Date("2026-09-12T18:00:00Z"))).toBe(
      "JustinProgOutput/20260912/nest.ngc",
    );
  });

  it("keeps each sheet part library in its own named folder", () => {
    expect(sheetPartLibraryRoot("Drive Side")).toBe(
      "Nesting Parts Library/Drive Side",
    );
  });
  it("prevents suffix filename collisions", () => {
    expect(buildEmitFilename("My Sheet", "router", 2, ".tap")).toBe(
      "My_Sheet_router.tap",
    );
    expect(buildEmitFilename("My Sheet", "router", 1, "tap")).toBe(
      "My_Sheet.tap",
    );
  });
  it("uses the selected cut label in an emitted filename", () => {
    const result = emitNestingGcode({
      name: "Main Plate",
      filenameSuffix: "Cut 1",
      suffixCount: 2,
      placements: [{ label: "A", x: 2, y: 3, part_library_path: "a" }],
      programs: { a: { source: "G1 X1 Y2\nM30" } },
    });
    expect(result.filename).toBe("Main_Plate_Cut_1.ngc");
  });
  it("uses the legacy 971 work offset and leaves one program terminator", () => {
    const result = emitNestingGcode({
      name: "nest",
      placements: [{ label: "A", x: 2, y: 3, part_library_path: "a" }],
      programs: { a: { source: "G1 X1 Y2\nM30" } },
    });
    expect(result.text).toContain("G10 L2 P9 X[#5221+1.5000] Y[#5222+2.0000] Z[#5223] R0.0000");
    expect(result.text).toContain("G59.3\nG1 X1 Y2");
    expect(result.text.match(/M30/g)).toHaveLength(1);
  });
  it("uses the legacy 971 work offset rotation when a part is rotated", () => {
    const result = emitNestingGcode({
      name: "nest",
      placements: [
        {
          label: "A",
          x: 2,
          y: 3,
          rotation: Math.PI / 2,
          part_library_path: "a",
        },
      ],
      programs: { a: { source: "G1 X1 Y0 I1 J0" } },
    });
    expect(result.text).toContain("G10 L2 P9 X[#5221+2.0000] Y[#5222+2.5000] Z[#5223] R90.0000");
    expect(result.text).toContain("G1 X1 Y0 I1 J0");
  });
  it("keeps a rotated source bounds center at the selected sheet coordinate", () => {
    const result = emitNestingGcode({
      name: "nest",
      placements: [
        {
          label: "A",
          x: 10,
          y: 20,
          rotation: Math.PI / 2,
          part_library_path: "a",
        },
      ],
      programs: { a: { source: "G0 X2 Y4\nG1 X4 Y8" } },
    });
    // The leading G0 is a transit move, not part geometry, so the center
    // must come from the cutting-only box (the same one the editor
    // displays and spaces placements against): the single G1 segment runs
    // (2,4) to (4,8), centered at (3, 6). After a 90-degree rotation that
    // is (-6, 3), so the G59.3 translation must be (16, 17) - not a center
    // that also folds in the rapid's (0,0) start point.
    expect(result.text).toContain("G10 L2 P9 X[#5221+16.0000] Y[#5222+17.0000] Z[#5223] R90.0000");
  });
  it("only transforms XY cutting motion, not router control parameters", () => {
    const result = emitNestingGcode({
      name: "router-safe",
      dialect: "wincnc",
      placements: [{ label: "A", x: 2, y: 3, rotation: Math.PI / 2, part_library_path: "a" }],
      programs: {
        a: {
          bounds: { centerX: 0, centerY: 0 },
          source: [
            "G90",
            "G4 X4.",
            "G53 G0 X0 Y0",
            "G0 X1 Y0",
            "G18 G3 X-0.003 Z0.05 I-0.0158 K0.",
            "G17 G3 X0 Y1 I0 J1",
          ].join("\n"),
        },
      },
    });
    expect(result.text).toContain("G4 X4.");
    expect(result.text).toContain("G53 Z\nM5\n[Tool 1]\nT1");
    expect(result.text).toContain("G18 G3 X-0.003 Z0.05 I-0.0158 K0.");
    expect(result.text).toContain("G17 G3 X1.0000 Y3.0000 I-1.0000 J0.0000");
  });
  it("emits complete rotated XY and IJ words for AutoCAM-style modal arcs", () => {
    const result = emitNestingGcode({
      name: "rotated-autocam",
      dialect: "wincnc",
      placements: [{ label: "A", x: 2, y: 3, rotation: Math.PI / 2, part_library_path: "a" }],
      programs: {
        a: {
          bounds: { centerX: 0, centerY: 0 },
          source: [
            "G90",
            "T1",
            "G0 X1 Y0",
            // Fusion/AutoCAM commonly omits the unchanged endpoint axis and
            // zero arc-center component. Both are required after rotation.
            "G3 X-1 I-1",
            "M5",
          ].join("\n"),
        },
      },
    });
    expect(result.text).toContain("G0 X2.0000 Y4.0000");
    expect(result.text).toContain("G3 X2.0000 Y2.0000 I0.0000 J-1.0000");
  });
  it("groups WinCNC parts by tool before emitting them", () => {
    const result = emitNestingGcode({
      name: "tool-order",
      dialect: "wincnc",
      placements: [
        { label: "Tool two", x: 2, y: 2, part_library_path: "two" },
        { label: "Tool one", x: 4, y: 2, part_library_path: "one" },
      ],
      programs: {
        two: { source: "G90\nT2\nS18000\nG0 X0 Y0\nM5" },
        one: { source: "G90\nT1\nS22000\nG0 X0 Y0\nM5" },
      },
    });
    expect(result.text.indexOf("[Tool 1]")).toBeLessThan(result.text.indexOf("[Tool 2]"));
    expect(result.text).toContain("[Part: Tool one]");
    expect(result.text).toContain("[Part: Tool two]");
  });
  it("uses the configured WinCNC tool order and requires a complete order", () => {
    const input = {
      name: "tool-order",
      dialect: "wincnc",
      placements: [
        { label: "Tool two", x: 2, y: 2, part_library_path: "two" },
        { label: "Tool one", x: 4, y: 2, part_library_path: "one" },
      ],
      programs: {
        two: { source: "G90\nT2\nG0 X0 Y0\nM5" },
        one: { source: "G90\nT1\nG0 X0 Y0\nM5" },
      },
    };
    expect(nestingEmissionTools(input)).toEqual([1, 2]);
    const result = emitNestingGcode({ ...input, toolOrder: [2, 1] });
    expect(result.toolOrder).toEqual([2, 1]);
    expect(result.text.indexOf("[Tool 2]")).toBeLessThan(result.text.indexOf("[Tool 1]"));
    expect(() => emitNestingGcode({ ...input, toolOrder: [2] })).toThrow(/each detected tool exactly once/);
  });
  it("always runs the release/slot cut last, even when its tool is ordered first", () => {
    const result = emitNestingGcode({
      name: "release-last",
      dialect: "wincnc",
      toolOrder: [6, 2],
      placements: [{ label: "Bracket", x: 2, y: 2, part_library_path: "bracket" }],
      programs: {
        // S-speed lines are not coordinate motion, so transformedProgram
        // passes them through unchanged - safe unique markers to locate
        // each segment by, unlike the G0 X/Y lines around them (rotated/
        // translated into placement coordinates by the time they're
        // emitted, so their literal source text won't appear verbatim).
        bracket: {
          source: [
            "G90",
            "T6",
            "[.3 Circular Through Hole]",
            "S1111",
            "G0 X0 Y0",
            "[Slot Cut for Edges]",
            "S2222",
            "G0 X1 Y1",
            "T2",
            "[Shape Through Hole]",
            "S3333",
            "G0 X2 Y2",
            "M5",
          ].join("\n"),
        },
      },
    });
    const releaseIndex = result.text.indexOf("[Slot Cut for Edges]");
    const t6Index = result.text.indexOf("[Tool 6]");
    const t2Index = result.text.indexOf("[Tool 2]");
    expect(releaseIndex).toBeGreaterThan(-1);
    // Both the ordinary T6 work and the ordinary T2 work (run before the
    // release segment despite T6 being configured first) must precede it.
    expect(t6Index).toBeLessThan(releaseIndex);
    expect(t2Index).toBeLessThan(releaseIndex);
    // The release segment gets its own tool section - a second "[Tool 6]"
    // header, after the T2 group, immediately preceding the release line.
    const secondT6Index = result.text.indexOf("[Tool 6]", t6Index + 1);
    expect(secondT6Index).toBeGreaterThan(t2Index);
    expect(result.text.indexOf("S2222")).toBeGreaterThan(secondT6Index);
    // The ordinary T6 hole work still ran in its own (first) T6 section,
    // not deferred alongside the release cut.
    expect(result.text.indexOf("S1111")).toBeLessThan(secondT6Index);
    expect(result.text.indexOf("S3333")).toBeLessThan(secondT6Index);
  });

  it("keeps the complete slot operation when the marker precedes its T-word", () => {
    const result = emitNestingGcode({
      name: "autocam-slot",
      dialect: "wincnc",
      placements: [{ label: "AutoCAM part", x: 2, y: 2, part_library_path: "part" }],
      programs: {
        part: {
          source: [
            "G90",
            "T1",
            "[Shape Through Hole]",
            "G0 X0 Y0",
            "M5",
            "[Slot Cut for Edges]",
            "T6",
            "S14553",
            "G0 X1 Y1",
            "G1 X2 Y1",
            "M5",
            "G53 P10",
          ].join("\n"),
        },
      },
    });
    const slotIndex = result.text.indexOf("[Slot Cut for Edges]");
    expect(slotIndex).toBeGreaterThan(result.text.indexOf("[Tool 1]"));
    expect(result.text.lastIndexOf("[Tool 6]", slotIndex)).toBeGreaterThan(-1);
    expect(result.text.slice(slotIndex)).toContain("G1 X2.5000 Y2.0000");
  });

  it("attaches an ordinary operation's own name to the tool that actually runs it, not the previous one", () => {
    // Real bug, confirmed against a real posted job (1001.tap): AutoCAM's
    // WinCNC post writes every operation's name comment BEFORE that
    // operation's own T-word, same as the release cut's own label. Before
    // the fix, only the release cut got the "look at the next line" lookahead
    // - every other operation's label was swept into whichever tool was
    // still active from the PREVIOUS operation, so JProg's own re-grouped
    // multi-tool output printed the wrong operation name over each tool's
    // real work (e.g. the sized-hole tool's section printed the big-endmill
    // operation's name, and vice versa).
    const result = emitNestingGcode({
      name: "label-before-tool",
      dialect: "wincnc",
      placements: [{ label: "Part", x: 2, y: 2, part_library_path: "part" }],
      programs: {
        part: {
          source: [
            "G90",
            "T1",
            "[.3 Circluar Through Hole]",
            "S22000",
            "G0 X0 Y0",
            "[Shape Through Hole big endmill]",
            "T2",
            "S22000",
            "G0 X1 Y1",
            "[Shape Through Hole]",
            "T1",
            "S22000",
            "G0 X2 Y2",
            "M5",
          ].join("\n"),
        },
      },
    });
    // Real JProg behavior this test relies on: winCncToolBlocks buckets by
    // tool NUMBER, so every T1 stretch from anywhere in the source (both
    // before and after the T2 detour) merges into one "[Tool 1]" section -
    // there is exactly one of each tool header, not one per source
    // occurrence.
    const tool1Index = result.text.indexOf("[Tool 1]");
    const tool2Index = result.text.indexOf("[Tool 2]");
    const tool1Body = result.text.slice(tool1Index, tool2Index);
    const tool2Body = result.text.slice(tool2Index);
    // T2's own section carries its own real label ("Shape Through Hole big
    // endmill"), not the label that happened to precede its T-word... wait,
    // the label that precedes T2's own T-word IS "Shape Through Hole big
    // endmill" (correct already), and the label that precedes the LATER
    // "T1" re-entry is "Shape Through Hole" - that one must land in T1's
    // merged section, not stay behind in T2's.
    expect(tool2Body).toContain("[Shape Through Hole big endmill]");
    expect(tool2Body).not.toContain("[Shape Through Hole]\n");
    expect(tool1Body).toContain("[Shape Through Hole]");
    expect(tool1Body).not.toContain("[Shape Through Hole big endmill]");
  });

  it("keeps a release-only tool out of the reorderable tool list", () => {
    const input = {
      name: "release-only-tool",
      dialect: "wincnc",
      placements: [{ label: "Bracket", x: 2, y: 2, part_library_path: "bracket" }],
      programs: {
        bracket: {
          source: ["G90", "T1", "G0 X0 Y0", "T6", "[Slot Cut for Edges]", "G0 X1 Y1", "M5"].join("\n"),
        },
      },
    };
    // T6 here is entirely the release cut - nothing ordinary uses it, so it
    // must not appear as a user-reorderable tool.
    expect(nestingEmissionTools(input)).toEqual([1]);
    const result = emitNestingGcode(input);
    expect(result.toolOrder).toEqual([1]);
    expect(result.text.indexOf("[Tool 1]")).toBeLessThan(result.text.indexOf("[Slot Cut for Edges]"));
  });

  it("refuses to emit a release/slot cut assigned any tool other than Tool 6 or Tool 1", () => {
    // Direct operator report, with a real posted G-code snippet: a plate
    // part's release cut ran under "[Tool 2]" / T2. Only Tool 6 or Tool 1
    // are approved to cut a release/slot cut - this must fail emission
    // loudly, before JProg ever writes a file a router would run, rather
    // than shipping an unapproved tool to the machine.
    const input = {
      name: "wrong-release-tool",
      dialect: "wincnc",
      placements: [{ label: "FrontSupportPlate-AUTOCAM", x: 2, y: 2, part_library_path: "plate" }],
      programs: {
        plate: {
          source: ["G90", "T6", "G0 X0 Y0", "T2", "[Slot Cut for Edges]", "G0 X1 Y1", "M5"].join("\n"),
        },
      },
    };
    expect(() => emitNestingGcode(input)).toThrow(/Tool 2.*only Tool 6 or Tool 1/s);
  });

  it("allows a release/slot cut assigned Tool 1, not just Tool 6", () => {
    const input = {
      name: "t1-release-tool",
      dialect: "wincnc",
      placements: [{ label: "FrontSupportPlate-AUTOCAM", x: 2, y: 2, part_library_path: "plate" }],
      programs: {
        plate: {
          source: ["G90", "T2", "G0 X0 Y0", "T1", "[Slot Cut for Edges]", "G0 X1 Y1", "M5"].join("\n"),
        },
      },
    };
    const result = emitNestingGcode(input);
    expect(result.text).toContain("Slot Cut for Edges");
  });

  it("does not re-swap to the same tool for a release cut that shares its main-work tool", () => {
    // Direct instruction, matching the original Java JProg (which groups
    // every occurrence of a tool into a single pass and never swaps back to
    // a tool it's already on): a release cut on the SAME tool as the main
    // work immediately before it must not get its own redundant
    // G53 Z / M5 / [Tool N] / TN block - the machine is already on that
    // tool, nothing physically needs to change.
    const input = {
      name: "same-tool-release",
      dialect: "wincnc",
      placements: [{ label: "Plate-AUTOCAM", x: 2, y: 2, part_library_path: "plate" }],
      programs: {
        plate: {
          source: ["G90", "T1", "G0 X0 Y0", "[Slot Cut for Edges]", "G0 X1 Y1", "M5"].join("\n"),
        },
      },
    };
    const result = emitNestingGcode(input);
    const toolHeaders = result.text.match(/^\[Tool \d+\]$/gm) || [];
    expect(toolHeaders).toEqual(["[Tool 1]"]);
  });

  it("still swaps to a different tool for a release cut, even after this optimization", () => {
    const input = {
      name: "different-tool-release",
      dialect: "wincnc",
      placements: [{ label: "Plate-AUTOCAM", x: 2, y: 2, part_library_path: "plate" }],
      programs: {
        plate: {
          source: ["G90", "T1", "G0 X0 Y0", "T6", "[Slot Cut for Edges]", "G0 X1 Y1", "M5"].join("\n"),
        },
      },
    };
    const result = emitNestingGcode(input);
    const toolHeaders = result.text.match(/^\[Tool \d+\]$/gm) || [];
    expect(toolHeaders).toEqual(["[Tool 1]", "[Tool 6]"]);
    // The release cut must still land after every line of Tool 1's work.
    const tool1Index = result.text.indexOf("[Tool 1]");
    const tool6Index = result.text.indexOf("[Tool 6]");
    const releaseIndex = result.text.indexOf("Slot Cut for Edges");
    expect(tool1Index).toBeLessThan(tool6Index);
    expect(tool6Index).toBeLessThan(releaseIndex);
  });

  it("skips the redundant release-tool swap even with a user-reordered toolOrder", () => {
    // Two parts: one whose only tool is 6 (Tool 6 loaded last by the custom
    // order below), one single-tool part whose release cut is also Tool 6 -
    // the machine is already on Tool 6 by the time the release cut runs, so
    // no second swap should appear regardless of which tool the user put
    // last in toolOrder.
    const input = {
      name: "custom-order-same-tool-release",
      dialect: "wincnc",
      placements: [
        { label: "OnlyTool6-AUTOCAM", x: 2, y: 2, part_library_path: "onlyTool6" },
        { label: "Tool6Release-AUTOCAM", x: 10, y: 2, part_library_path: "tool6Release" },
      ],
      programs: {
        onlyTool6: { source: ["G90", "T6", "G0 X0 Y0", "M5"].join("\n") },
        tool6Release: { source: ["G90", "T6", "G0 X0 Y0", "[Slot Cut for Edges]", "G0 X1 Y1", "M5"].join("\n") },
      },
      toolOrder: [6],
    };
    const result = emitNestingGcode(input);
    const toolHeaders = result.text.match(/^\[Tool \d+\]$/gm) || [];
    expect(toolHeaders).toEqual(["[Tool 6]"]);
  });

  it("orders release tools to match whichever tool is already loaded, even with several release tools", () => {
    // Custom order ends on Tool 6. Release work exists for BOTH Tool 1 and
    // Tool 6 - Tool 6's release must be processed first (no swap, matches
    // what's already loaded), Tool 1's release still needs its own real
    // swap after that. A naive ascending sort of release tools (1 before 6)
    // would instead force two swaps here instead of one.
    const input = {
      name: "custom-order-multi-release",
      dialect: "wincnc",
      placements: [
        { label: "Tool1Body-AUTOCAM", x: 2, y: 2, part_library_path: "tool1Body" },
        { label: "Tool6Body-AUTOCAM", x: 10, y: 2, part_library_path: "tool6Body" },
        { label: "Tool1Release-AUTOCAM", x: 18, y: 2, part_library_path: "tool1Release" },
        { label: "Tool6Release-AUTOCAM", x: 26, y: 2, part_library_path: "tool6Release" },
      ],
      programs: {
        tool1Body: { source: ["G90", "T1", "G0 X0 Y0", "M5"].join("\n") },
        tool6Body: { source: ["G90", "T6", "G0 X0 Y0", "M5"].join("\n") },
        tool1Release: { source: ["G90", "T1", "G0 X0 Y0", "[Slot Cut for Edges]", "G0 X1 Y1", "M5"].join("\n") },
        tool6Release: { source: ["G90", "T6", "G0 X0 Y0", "[Slot Cut for Edges]", "G0 X1 Y1", "M5"].join("\n") },
      },
      toolOrder: [1, 6],
    };
    const result = emitNestingGcode(input);
    const toolHeaders = result.text.match(/^\[Tool \d+\]$/gm) || [];
    // Main pass: Tool 1 then Tool 6 (as configured). Release pass: Tool 6
    // first (already loaded, free), then Tool 1 (one real swap back).
    expect(toolHeaders).toEqual(["[Tool 1]", "[Tool 6]", "[Tool 1]"]);
  });

  it("orders parts sharing a tool by nearest-neighbor travel distance, matching Java's getOptimizedPartOrder", () => {
    // Three parts on a line at x = 0, 10, 20. Placed in the input in the
    // "wrong" order (middle, far, near) - nearest-neighbor from the best
    // starting point must still visit them in spatial order (0, 10, 20 or
    // its reverse), not the input's insertion order.
    const input = {
      name: "nearest-neighbor-order",
      dialect: "wincnc",
      placements: [
        { label: "Middle-AUTOCAM", x: 10, y: 0, part_library_path: "plate" },
        { label: "Far-AUTOCAM", x: 20, y: 0, part_library_path: "plate" },
        { label: "Near-AUTOCAM", x: 0, y: 0, part_library_path: "plate" },
      ],
      programs: { plate: { source: "G90\nT1\nG0 X0 Y0\nM5" } },
    };
    const result = emitNestingGcode(input);
    const order = [...result.text.matchAll(/\[Part: (\S+)-AUTOCAM\]/g)].map((m) => m[1]);
    const spatialOrder = ["Near", "Middle", "Far"];
    const isSpatialOrder = order.join() === spatialOrder.join() || order.join() === [...spatialOrder].reverse().join();
    expect(isSpatialOrder).toBe(true);
  });

  it("still runs a program with no release cut exactly as before", () => {
    const result = emitNestingGcode({
      name: "no-release",
      dialect: "wincnc",
      placements: [{ label: "Plain", x: 2, y: 2, part_library_path: "plain" }],
      programs: { plain: { source: "G90\nT1\nG0 X0 Y0\nM5" } },
    });
    expect(result.text).toContain("[Tool 1]");
    expect(result.text).not.toContain("Slot Cut");
  });

  it("emits the bundled hole template only in the holes group", () => {
    const result = emitNestingGcode({
      name: "nest",
      suffix: "holes",
      thickness: "0.125",
      placements: [{ kind: "hole", label: "Hole", x: 2, y: 3 }],
      programs: {},
    });
    expect(result.emitted).toBe(1);
    expect(result.text).toContain("(Part: Hole)");
    expect(result.text).toContain("M30");
  });
  it("preserves the bundled router hole-controller commands while nesting", () => {
    const placement = [{ kind: "hole", label: "Hole", x: 2, y: 3 }];
    const winCnc = emitNestingGcode({
      name: "router-hole",
      suffix: "holes",
      dialect: "wincnc",
      thickness: "0.125",
      placements: placement,
      programs: {},
    });
    const router971 = emitNestingGcode({
      name: "router-hole",
      suffix: "holes",
      dialect: "linuxcnc",
      thickness: "0.125",
      placements: placement,
      programs: {},
    });
    expect(winCnc.text).toContain("G4 X4.");
    expect(winCnc.text).toContain("G53 Z");
    expect(router971.text).toContain("G18 G3 X-0.003 Z0.05 I-0.0158 K0.");
    expect(router971.text).toContain("G53 G0 Z0.");
  });
});
