#!/usr/bin/env node
/**
 * Standalone AutoCAM validation tool - checks whether a STEP file can
 * actually be turned into G-code, without needing the web app, a browser
 * login, or a live database. Useful for:
 *   - Diagnosing "why did this part fail to generate" before/without
 *     attaching it to a real part in the app.
 *   - Regression-testing autocam/*.js changes against real files.
 *
 * Usage:
 *   node autocam/scripts/test-cam-extraction.mjs turning "/path/to/part.step"
 *   node autocam/scripts/test-cam-extraction.mjs routing "/path/to/part.step" [targetDepth]
 *   node autocam/scripts/test-cam-extraction.mjs routing "/path/to/part.step" [targetDepth] --tools=0.25,0.125
 *     (multi-tool router mode - see autocam/docs/toolchange-gcode-plan.md - diameters
 *     largest first; the real part's contours still decide which tool each
 *     one actually needs)
 *
 * Exit code 0 = extraction + G-code generation succeeded, 1 = failed.
 */
import fs from 'fs';
import { readStepMeshes, extractTurningProfileFromMeshes, extractRoutingContoursFromMeshes } from '../stepProfile.js';
import { generateTurningGcode } from '../inprocess/turning.js';
import { generateRoutingGcode } from '../inprocess/routing.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--tools='));
const toolsArg = process.argv.find((a) => a.startsWith('--tools='));
const [operation, filePath, extra] = args;

function usageAndExit() {
  console.error('Usage: node scripts/test-cam-extraction.mjs <turning|routing> <path-to-step-file> [routing:targetDepth] [--tools=0.25,0.125]');
  process.exit(1);
}

if (!operation || !filePath || !['turning', 'routing'].includes(operation)) usageAndExit();
if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

console.log(`\n=== AutoCAM test: ${operation} on "${filePath}" ===\n`);

function printBoundingBox(meshes) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const mesh of meshes) {
    const pos = mesh.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
      minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i]);
      minY = Math.min(minY, pos[i + 1]); maxY = Math.max(maxY, pos[i + 1]);
      minZ = Math.min(minZ, pos[i + 2]); maxZ = Math.max(maxZ, pos[i + 2]);
    }
  }
  console.log('Bounding box (in):');
  console.log(`  X: ${minX.toFixed(4)} to ${maxX.toFixed(4)}  (span ${(maxX - minX).toFixed(4)})`);
  console.log(`  Y: ${minY.toFixed(4)} to ${maxY.toFixed(4)}  (span ${(maxY - minY).toFixed(4)})`);
  console.log(`  Z: ${minZ.toFixed(4)} to ${maxZ.toFixed(4)}  (span ${(maxZ - minZ).toFixed(4)})`);
}

try {
  const fileContent = fs.readFileSync(filePath);
  const meshes = await readStepMeshes(fileContent);
  console.log(`Loaded ${meshes.length} mesh(es):`);
  for (const m of meshes) {
    console.log(`  "${m.name}": ${m.attributes.position.array.length / 3} verts, ${m.index.array.length / 3} tris, ${m.brep_faces?.length || 0} faces`);
  }
  console.log();
  printBoundingBox(meshes);
  console.log();

  let result;
  if (operation === 'turning') {
    const profile = extractTurningProfileFromMeshes(meshes);
    const maxRadius = Math.max(...profile.map((p) => p.x));
    console.log(`Extracted profile: ${profile.length} points`);
    console.log(`  Length: ${(profile[profile.length - 1].z - profile[0].z).toFixed(4)}"`);
    console.log(`  Max radius: ${maxRadius.toFixed(4)}" (diameter ${(maxRadius * 2).toFixed(4)}")`);
    const stockDiameter = maxRadius * 2 * 1.05;
    result = generateTurningGcode(profile, {
      stockDiameter, stepDown: 0.05, finishAllowance: 0.02, feedRough: 0.008, feedFinish: 0.004
    });
    console.log(`\nGenerated G-code with a ${stockDiameter.toFixed(3)}" stock estimate (5% over max radius - use your real stock size in the app).`);
  } else {
    const { contours, thickness } = extractRoutingContoursFromMeshes(meshes);
    console.log(`Extracted ${contours.length} contour(s), thickness ${thickness?.toFixed(4)}"`);
    for (const c of contours) console.log(`  ${c.isHole ? 'hole' : 'outer'}: ${c.points.length} points`);
    const targetDepth = extra ? Number(extra) : thickness;
    if (toolsArg) {
      const toolSequence = toolsArg.replace('--tools=', '').split(',').map((d, i) => ({ toolDiameter: Number(d), toolNumber: i + 1, label: `${d}" tool` }));
      console.log(`Multi-tool mode: ${toolSequence.map((t) => t.label).join(' -> ')}`);
      result = generateRoutingGcode(contours, { stepDown: 0.1, targetDepth, toolSequence });
    } else {
      result = generateRoutingGcode(contours, { toolDiameter: 0.25, stepDown: 0.1, targetDepth });
    }
  }

  console.log(`\n✅ SUCCESS - ${result.gcode.split('\n').length} lines of G-code, stats:`, result.stats);
  console.log('\n--- First 15 lines of G-code ---');
  console.log(result.gcode.split('\n').slice(0, 15).join('\n'));
  process.exit(0);
} catch (e) {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
}
