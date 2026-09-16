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

  it("keeps a release-only tool out of the reorderable tool list", () => {
    const input = {
      name: "release-only-tool",
      dialect: "wincnc",
      placements: [{ label: "Bracket", x: 2, y: 2, part_library_path: "bracket" }],
      programs: {
        bracket: {
          source: ["G90", "T6", "G0 X0 Y0", "T2", "[Slot Cut for Edges]", "G0 X1 Y1", "M5"].join("\n"),
        },
      },
    };
    // T2 here is entirely the release cut - nothing ordinary uses it, so it
    // must not appear as a user-reorderable tool.
    expect(nestingEmissionTools(input)).toEqual([6]);
    const result = emitNestingGcode(input);
    expect(result.toolOrder).toEqual([6]);
    expect(result.text.indexOf("[Tool 6]")).toBeLessThan(result.text.indexOf("[Slot Cut for Edges]"));
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
