#!/usr/bin/env node
// Queues a Fusion CAM "plate:cam" job against a fresh plate/part, the same
// way the /autocam/fusion UI's Parts/Plates tabs do (see
// src/lib/fusionCam.js's createPart/createPlate/assignPartToPlate/
// queueFusionJob) - a scriptable shortcut for repeat local Runner testing
// instead of clicking through the UI each time. See
// autocam/fusion/runner/docs/local-testing-handoff.md for the full local
// testing workflow this fits into.
//
// Usage:
//   node --env-file=.env autocam/scripts/queue-fusion-plate-job.mjs <step-file-path> [part-name]
//
// Requires in .env: SUPABASE_URL, SUPABASE_SERVICE_KEY (service role -
// needed to upload to the manufacturing-files bucket and insert rows
// without going through the browser's authenticated session).
//
// Defaults to this project's known-good local testing preset: a fresh
// 12x12x0.25in Aluminum 6061 plate, the 0.1575" 971 Main Bit, and the UNC
// Router - override any of them with the env vars below if you need a
// different combination.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [, , stepPath, partNameArg] = process.argv;
if (!stepPath) {
  console.error('Usage: node --env-file=.env autocam/scripts/queue-fusion-plate-job.mjs <step-file-path> [part-name]');
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY - run with --env-file=.env');
  process.exit(1);
}

// This project's known-good local testing preset (see
// autocam/fusion/runner/docs/local-testing-handoff.md's catalog ID table) -
// override via env vars for a different plate/material/tool/machine.
const CATEGORY_ID = process.env.FUSION_TEST_CATEGORY_ID || 'ec177f74-28e2-4edb-828c-bdd6b0002bba'; // Aluminum 6061 @ 0.25in
const MATERIAL_ID = process.env.FUSION_TEST_MATERIAL_ID || '819af897-16d3-4f22-9e01-d0be32fd23ad'; // Aluminum 6061
const TOOL_ID = process.env.FUSION_TEST_TOOL_ID || '60ef32c0-d76d-4549-a4a6-3cf4a7aee115'; // 0.1575" 971 Main Bit
const MACHINE_ID = process.env.FUSION_TEST_MACHINE_ID || '517ba89c-7167-4415-b6fd-cfc7be1e59e1'; // UNC Router
const PLATE_WIDTH = Number(process.env.FUSION_TEST_PLATE_WIDTH || 12);
const PLATE_LENGTH = Number(process.env.FUSION_TEST_PLATE_LENGTH || 12);
const PLATE_TRUE_DEPTH = Number(process.env.FUSION_TEST_PLATE_TRUE_DEPTH || 0.25);
// Whoever is running this against their own local dev server - the account
// that requested the job. Defaults to the account this preset has been
// tested under; override for a different Supabase project/user.
const REQUESTED_BY = process.env.FUSION_TEST_REQUESTED_BY || '0b6f27f7-d746-4d03-803c-7093194ad525';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function main() {
  const partName = partNameArg || basename(stepPath).replace(/\.(step|stp)$/i, '');
  const fileBuffer = readFileSync(stepPath);
  const stepFileName = `${Date.now()}_${partName.replace(/[^a-zA-Z0-9]/g, '_')}_fusion.step`;

  const { error: uploadError } = await supabase.storage
    .from('manufacturing-files')
    .upload(stepFileName, fileBuffer, { cacheControl: '3600', upsert: false, contentType: 'model/step' });
  if (uploadError) throw new Error(`upload failed: ${uploadError.message}`);
  console.log('Uploaded STEP file as', stepFileName);

  const { data: part, error: partError } = await supabase
    .from('fusion_parts')
    .insert({
      name: partName,
      quantity: 1,
      original_quantity: 1,
      category_id: CATEGORY_ID,
      step_file_name: stepFileName,
      created_by: REQUESTED_BY
    })
    .select()
    .single();
  if (partError) throw new Error(`part insert failed: ${partError.message}`);
  console.log('Created fusion_parts row', part.id);

  const { data: plate, error: plateError } = await supabase
    .from('fusion_plates')
    .insert({
      name: `${partName} Test Plate`,
      width: PLATE_WIDTH,
      length: PLATE_LENGTH,
      true_depth: PLATE_TRUE_DEPTH,
      category_id: CATEGORY_ID
    })
    .select()
    .single();
  if (plateError) throw new Error(`plate insert failed: ${plateError.message}`);
  console.log('Created fusion_plates row', plate.id);

  const { error: assignError } = await supabase
    .from('fusion_part_category_assignments')
    .upsert({ category_id: CATEGORY_ID, plate_id: plate.id, part_id: part.id, quantity: 1 }, { onConflict: 'plate_id,part_id' });
  if (assignError) throw new Error(`assignment failed: ${assignError.message}`);
  console.log('Assigned part to plate');

  const { error: partQtyError } = await supabase
    .from('fusion_parts')
    .update({ quantity: 0 })
    .eq('id', part.id);
  if (partQtyError) throw new Error(`part quantity update failed: ${partQtyError.message}`);

  const { data: job, error: jobError } = await supabase
    .from('cam_jobs')
    .insert({
      name: `Plate CAM: ${partName}`,
      source_type: 'upload',
      operation_type: 'milling',
      params: { fusionJobKind: 'plate:cam', plateId: plate.id, boxTubeId: null },
      material_id: MATERIAL_ID,
      tool_id: TOOL_ID,
      machine_id: MACHINE_ID,
      status: 'queued',
      requested_by: REQUESTED_BY,
      part_id: null
    })
    .select()
    .single();
  if (jobError) throw new Error(`job insert failed: ${jobError.message}`);
  console.log('Queued cam_jobs row', job.id);
  console.log(JSON.stringify({ partId: part.id, plateId: plate.id, jobId: job.id }, null, 2));
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
