import { placementHasEdgeClearance } from "./sheetModel.js";

function corners(placement, extra = 0) {
  const halfWidth = Number(placement.width_in) / 2 + extra;
  const halfHeight = Number(placement.height_in) / 2 + extra;
  const angle = Number(placement.rotation) || 0;
  const cosine = Math.cos(angle),
    sine = Math.sin(angle);
  return [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ].map(([x, y]) => ({
    x: placement.x + x * cosine - y * sine,
    y: placement.y + x * sine + y * cosine,
  }));
}

function axes(points) {
  return points.slice(0, 2).map((point, index) => {
    const next = points[(index + 1) % points.length];
    const length = Math.hypot(next.x - point.x, next.y - point.y) || 1;
    return { x: -(next.y - point.y) / length, y: (next.x - point.x) / length };
  });
}

function overlapsOnAxis(first, second, axis) {
  const project = (point) => point.x * axis.x + point.y * axis.y;
  const [firstMin, firstMax] = first
    .map(project)
    .reduce(
      ([min, max], value) => [Math.min(min, value), Math.max(max, value)],
      [Infinity, -Infinity],
    );
  const [secondMin, secondMax] = second
    .map(project)
    .reduce(
      ([min, max], value) => [Math.min(min, value), Math.max(max, value)],
      [Infinity, -Infinity],
    );
  // Treat edge contact as valid. The editor only calls this a collision when
  // two rotated bounds have a meaningful shared area.
  const epsilon = 0.005;
  return firstMax > secondMin + epsilon && secondMax > firstMin + epsilon;
}

export function placementsOverlap(first, second, clearance = 0) {
  const firstPoints = corners(first, Math.max(0, Number(clearance) || 0) / 2);
  const secondPoints = corners(second, Math.max(0, Number(clearance) || 0) / 2);
  return [...axes(firstPoints), ...axes(secondPoints)].every((axis) =>
    overlapsOnAxis(firstPoints, secondPoints, axis),
  );
}

export function placementCollisionPairs(placements, clearance = 0) {
  const pairs = [];
  for (let firstIndex = 0; firstIndex < placements.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < placements.length;
      secondIndex += 1
    ) {
      if (
        placementsOverlap(
          placements[firstIndex],
          placements[secondIndex],
          clearance,
        )
      )
        pairs.push([placements[firstIndex], placements[secondIndex]]);
    }
  }
  return pairs;
}

export function validateCut({
  sheet,
  placements = [],
  programPaths = [],
  clearance = 0,
  holeEdgeClearance = 0.05,
} = {}) {
  const availablePrograms = new Set(programPaths);
  const issues = [];
  for (const placement of placements) {
    if (
      placement.kind === "hole" &&
      !placementHasEdgeClearance(sheet, placement, holeEdgeClearance)
    )
      issues.push({
        type: "hole-edge-clearance",
        placementId: placement.id,
        message: `${placement.label} is too close to a sheet edge`,
      });
    if (
      placement.kind === "part" &&
      placement.part_library_path &&
      !availablePrograms.has(placement.part_library_path)
    )
      issues.push({
        type: "missing-program",
        placementId: placement.id,
        message: `${placement.label} is missing from the part library`,
      });
  }
  if (!placements.length)
    issues.push({ type: "empty-cut", message: "This cut has no placements" });
  return issues;
}

export function placementIssueIds(issues = []) {
  return new Set(
    issues
      .flatMap((issue) => [issue.placementId, issue.relatedPlacementId])
      .filter(Boolean),
  );
}
