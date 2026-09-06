#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const JOB_ID = process.argv[2];
async function main() {
  for (;;) {
    const { data, error } = await supabase.from('cam_jobs').select('status, errors, warnings').eq('id', JOB_ID).single();
    if (error) throw error;
    if (data.status === 'completed' || data.status === 'failed') {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
main().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
