import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks=vi.hoisted(()=>({from:vi.fn(),payload:vi.fn(),storageUpload:vi.fn(async()=>({error:null}))}));
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({from:mocks.from,storage:{from:()=>({upload:mocks.storageUpload})}})}));
vi.mock('$env/dynamic/private',()=>({env:{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_KEY:'service-key'}}));
vi.mock('$lib/server/fusion_runner_auth.js',()=>({isAuthorizedFusionRunnerRequest:()=>true}));
vi.mock('$autocam/fusion/jobPayload.js',()=>({buildJobPayload:mocks.payload}));
import { POST } from './+server.js';
const call=(action,body={})=>POST({url:new URL(`http://localhost/api/fusion-runner?action=${action}`),request:new Request('http://localhost',{method:'POST',body:JSON.stringify(body)})});
let queries;
const machineId='11111111-1111-4111-8111-111111111111';
beforeEach(()=>{queries=[];mocks.from.mockReset();mocks.payload.mockReset();mocks.storageUpload.mockReset();mocks.storageUpload.mockResolvedValue({error:null});});
function chain(result){
 const q={};for(const method of ['select','update','eq','in','order','limit','or','lt'])q[method]=vi.fn(()=>q);
 q.single=vi.fn(async()=>result);q.then=(resolve)=>resolve(result);queries.push(q);return q;
}
describe('Fusion Runner grouping lifecycle',()=>{
 it('marks unresolved claimed inputs failed instead of leaving a stranded claim',async()=>{
  mocks.from.mockReturnValueOnce(chain({error:null})).mockReturnValueOnce(chain({data:[{id:'job'}]})).mockReturnValueOnce(chain({data:{id:'job'}})).mockReturnValueOnce(chain({data:[]}));
  mocks.payload.mockRejectedValue(new Error('Part b is missing its STEP file'));
  const result=await call('claim',{runnerId:'runner',machineId});
  expect(await result.json()).toEqual({job:null,error:'Part b is missing its STEP file'});
  expect(queries[3].update).toHaveBeenCalledWith(expect.objectContaining({status:'failed'}));
  expect(queries[3].eq).toHaveBeenCalledWith('status','claimed');
 });
 it('does not let a late failure overwrite terminal or non-Fusion jobs',async()=>{
  mocks.from.mockReturnValue(chain({data:[]}));
  expect((await call('fail',{jobId:'job',runnerId:'runner',error:'late'})).status).toBe(409);
  expect(queries[0].eq).toHaveBeenCalledWith('operation_type','milling');
  expect(queries[0].in).toHaveBeenCalledWith('status',['claimed','processing']);
 });
 it('requires the runner that claimed a job to advance it',async()=>{
  mocks.from.mockReturnValue(chain({data:[]}));
  expect((await call('processing',{jobId:'job',runnerId:'other-runner'})).status).toBe(409);
  expect(queries[0].eq).toHaveBeenCalledWith('claimed_by','other-runner');
 });
 it('requires a runner identifier for every post-claim transition',async()=>{
  expect((await call('processing',{jobId:'job'})).status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
 });
 it('rejects a malformed machine ID rather than claiming another machine’s jobs',async()=>{
  expect((await call('claim',{runnerId:'runner',machineId:'invalid'})).status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
 });
 it('requires a machine ID instead of falling back to claim-anything',async()=>{
  expect((await call('claim',{runnerId:'runner'})).status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
 });
 it('refreshes the ownership timestamp only for the active claiming runner',async()=>{
  mocks.from.mockReturnValue(chain({data:[{id:'job'}]}));
  expect((await call('heartbeat',{jobId:'job',runnerId:'runner'})).status).toBe(200);
  expect(queries[0].update).toHaveBeenCalledWith(expect.objectContaining({claimed_at:expect.any(String)}));
  expect(queries[0].eq).toHaveBeenCalledWith('claimed_by','runner');
  expect(queries[0].in).toHaveBeenCalledWith('status',['claimed','processing']);
 });
 it('requeues only stale unstarted claims before claiming new work',async()=>{
  mocks.from.mockReturnValueOnce(chain({error:null})).mockReturnValueOnce(chain({data:[]}));
  expect((await call('claim',{runnerId:'runner',machineId})).status).toBe(200);
  expect(queries[0].update).toHaveBeenCalledWith(expect.objectContaining({status:'queued',claimed_by:null,claimed_at:null}));
  expect(queries[0].eq).toHaveBeenCalledWith('status','claimed');
  expect(queries[0].lt).toHaveBeenCalledWith('claimed_at',expect.any(String));
 });
 it('stores exact Fusion output artifacts without synthesizing a combined program',async()=>{
  const contentBase64=Buffer.from('N10 G90\r\nM30\r\n','utf8').toString('base64');
  mocks.from
   .mockReturnValueOnce(chain({data:{id:'job',params:{fusionJobKind:'plate:cam',fusionPlateSnapshot:{name:'x44 stiffner'}}}}))
   .mockReturnValueOnce(chain({data:[{id:'job'}]}));
  const result=await call('complete',{jobId:'job',runnerId:'runner',ncFiles:[{name:'plate.nc',contentBase64}]});
  expect(result.status).toBe(200);
  expect(queries[1].update).toHaveBeenCalledWith(expect.objectContaining({
   gcode:null,
   gcode_file_name:null,
   fusion_nc_files:[expect.objectContaining({name:'plate.nc',contentBase64,size:14})]
  }));
  // Direct instruction: a completed job's G-code should land in Files
  // automatically, named from the plate/part it was run against, spaces
  // stripped - same convention the manual "Post to Files" button already
  // used, just no longer requiring someone to click through to it.
  expect(mocks.storageUpload).toHaveBeenCalledTimes(1);
  expect(mocks.storageUpload).toHaveBeenCalledWith(
   'AutoCAM/x44stiffner.ngc',
   expect.any(Buffer),
   expect.objectContaining({upsert:true,contentType:'text/plain'})
  );
 });
 it('records how far the posted program travels so a machine-limit report can be triaged',async()=>{
  // Issue #359: "program exceeds machine maximum" kept being reported when
  // the program's own span was modest and the machine's G54 offset was the
  // real cause. Measuring it on completion means nobody has to parse the
  // .ngc by hand to rule the program out.
  const contentBase64=Buffer.from('G20\nG0 X1 Y2\nG1 X9 Y2 Z-0.25\n','utf8').toString('base64');
  mocks.from
   .mockReturnValueOnce(chain({data:{id:'job',params:{fusionJobKind:'plate:cam'}}}))
   .mockReturnValueOnce(chain({data:[{id:'job'}]}));
  expect((await call('complete',{jobId:'job',runnerId:'runner',ncFiles:[{name:'plate.nc',contentBase64}],stats:{total_machining_time:12}})).status).toBe(200);
  const update=queries[1].update.mock.calls[0][0];
  // Existing stats are preserved, not replaced by the measurement.
  expect(update.stats.total_machining_time).toBe(12);
  expect(update.stats.program_extents.units).toBe('in');
  expect(update.stats.program_extents.combined.X).toEqual({min:1,max:9,span:8});
 });
 it('rejects malformed Fusion output before completing the job',async()=>{
  mocks.from.mockReturnValueOnce(chain({data:{id:'job',params:{fusionJobKind:'plate:cam'}}}));
  const result=await call('complete',{jobId:'job',runnerId:'runner',ncFiles:[{name:'../plate.nc',contentBase64:'eA=='}]});
  expect(result.status).toBe(500);
  expect((await result.json()).error).toMatch(/filenames/);
  expect(mocks.from).toHaveBeenCalledTimes(1);
  expect(mocks.storageUpload).not.toHaveBeenCalled();
 });
 it('still reports the job completed even if posting to Files fails',async()=>{
  const contentBase64=Buffer.from('N10 G90\r\nM30\r\n','utf8').toString('base64');
  mocks.from
   .mockReturnValueOnce(chain({data:{id:'job',params:{fusionJobKind:'plate:cam'}}}))
   .mockReturnValueOnce(chain({data:[{id:'job'}]}));
  mocks.storageUpload.mockResolvedValue({error:{message:'bucket unreachable'}});
  const result=await call('complete',{jobId:'job',runnerId:'runner',ncFiles:[{name:'plate.nc',contentBase64}]});
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({success:true});
 });
});
