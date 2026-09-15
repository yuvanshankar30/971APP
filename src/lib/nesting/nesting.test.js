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
  it("keeps rapid transit in the emission origin while excluding it from display bounds", () => {
    const document = parseGcodeDocument("G0 X100 Y100\nG1 X101 Y100\nG0 X0 Y0");
    expect(document.bounds).toMatchObject({ minX: 100, maxX: 101 });
    expect(document.emissionBounds).toMatchObject({ minX: 0, maxX: 101 });
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
    const item = rotatePlacement({
      x: 1,
      y: 3,
      width_in: 3,
      height_in: 1,
      rotation: 0,
    });
    expect(item.width_in).toBe(3);
    expect(item.height_in).toBe(1);
    expect(sheetContains({ width_in: 4, height_in: 4 }, item)).toBe(false);
    expect(placementContains(item, 1, 3)).toBe(true);
  });
  it("supports rotating in either direction without snapping the stored angle", () => {
    const item = rotatePlacement({ rotation: 0 }, -0.25);
    expect(item.rotation).toBeCloseTo(-Math.PI / 8);
  });
  it("snaps a valid edge placement inside the stock rather than rejecting it", () => {
    const result = clampPlacementToSheet(
      { width_in: 48, height_in: 24 },
      { x: 47.9, y: 23.9, width_in: 2, height_in: 2, rotation: 0 },
    );
    expect(result).toMatchObject({ x: 47, y: 23 });
    expect(sheetContains({ width_in: 48, height_in: 24 }, result)).toBe(true);
  });
  it("rejects only a placement that is larger than the sheet itself", () => {
    expect(
      clampPlacementToSheet(
        { width_in: 4, height_in: 4 },
        { x: 2, y: 2, width_in: 5, height_in: 1, rotation: 0 },
      ),
    ).toBeNull();
  });
  it("requires holes to stay clear of sheet edges", () => {
    const sheet = { width_in: 48, height_in: 24 };
    expect(
      placementHasEdgeClearance(sheet, {
        x: 0.15,
        y: 12,
        width_in: 0.3,
        height_in: 0.3,
      }),
    ).toBe(false);
    expect(
      placementHasEdgeClearance(
        sheet,
        { x: 0.25, y: 12, width_in: 0.3, height_in: 0.3 },
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
    // The source center is (2, 4); after a 90-degree rotation it is (-4, 2).
    // The G59.3 translation must therefore be (14, 18), not (8, 16).
    expect(result.text).toContain("G10 L2 P9 X[#5221+14.0000] Y[#5222+18.0000] Z[#5223] R90.0000");
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
