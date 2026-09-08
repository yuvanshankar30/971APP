#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const libraryFile = 'Normal router tools (use this).tools';
const archive = new URL(`../fusion/runner/tools/${encodeURIComponent(libraryFile)}`, import.meta.url);
const entries = JSON.parse(execFileSync('unzip', ['-p', fileURLToPath(archive), 'tools.json'], { encoding: 'utf8' })).data || [];
const normalizeType = (type) => /end\s*mill/i.test(type) ? 'endmill' : /counter\s*sink/i.test(type) ? 'countersink' : /drill/i.test(type) ? 'drill' : 'unknown';
const tools = entries.map((tool) => ({
  name: `ShopSabre ${tool['post-process']?.number ?? '?'} ${tool.description || tool.type}`.trim(),
  tool_type: normalizeType(tool.type),
  diameter: tool.geometry?.DC ?? null,
  tool_number: tool['post-process']?.number ?? null,
  manual_tool_change: tool['post-process']?.['manual-tool-change'] ?? null,
  tip_angle: tool.geometry?.SIG ?? null,
  tool_library_guid: tool.guid,
  source_tool_library_file: libraryFile,
  fusion_tool_library_file: libraryFile,
  enabled: true
}));

if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify(tools, null, 2));
  console.log('\nDry run only. Use --apply with SUPABASE_URL and SUPABASE_SERVICE_KEY after the migration is deployed.');
  process.exit(0);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { error } = await supabase.from('cam_tools').upsert(tools, { onConflict: 'tool_library_guid' });
if (error) throw error;
console.log(`Imported ${tools.length} ShopSabre tool records. No cam_machine_tools rows were changed.`);
