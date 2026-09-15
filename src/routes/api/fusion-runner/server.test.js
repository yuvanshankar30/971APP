import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks=vi.hoisted(()=>({from:vi.fn(),payload:vi.fn(),storageUpload:vi.fn(async()=>({error:null})),isAuthorized:vi.fn(()=>true)}));
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({from:mocks.from,storage:{from:()=>({upload:mocks.storageUpload})}})}));
vi.mock('$env/dynamic/private',()=>({env:{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_KEY:'service-key'}}));
vi.mock('$lib/server/fusion_runner_auth.js',()=>({isAuthorizedFusionRunnerRequest:mocks.isAuthorized,getBearerToken:(headers)=>{const auth=String(headers?.get?.('authorization')||'').trim();const m=/^Bearer\s+(.+)$/i.exec(auth);return m?m[1].trim():'';}}));
vi.mock('$autocam/fusion/jobPayload.js',()=>({buildJobPayload:mocks.payload}));
import { POST } from './+server.js';
const call=(action,body={},authorization)=>POST({url:new URL(`http://localhost/api/fusion-runner?action=${action}`),request:new Request('http://localhost',{method:'POST',body:JSON.stringify(body),headers:authorization?{authorization}:undefined})});
let queries;
const machineId='11111111-1111-4111-8111-111111111111';
const plateId='22222222-2222-4222-8222-222222222222';
beforeEach(()=>{queries=[];mocks.from.mockReset();mocks.payload.mockReset();mocks.storageUpload.mockReset();mocks.storageUpload.mockResolvedValue({error:null});mocks.isAuthorized.mockReset();mocks.isAuthorized.mockReturnValue(true);});
function chain(result){
 const q={};for(const method of ['select','insert','update','upsert','eq','in','ilike','order','limit','or','lt','is'])q[method]=vi.fn(()=>q);
 q.single=vi.fn(async()=>result);q.maybeSingle=vi.fn(async()=>result);q.then=(resolve)=>resolve(result);queries.push(q);return q;
}
describe('Fusion Data Panel folder sync',()=>{
 it('rejects a tree that claims one project while rooted in another',async()=>{
  const result=await call('sync-folders',{projectName:'2026 Season CAM',tree:{name:'AutoCAM'}});
  expect(result.status).toBe(422);
  expect(mocks.from).not.toHaveBeenCalled();
 });
 it('accepts only a tree rooted at its named project',async()=>{
  mocks.from.mockReturnValue(chain({error:null}));
  const result=await call('sync-folders',{projectName:'2026 Season CAM',tree:{name:'2026 Season CAM',children:[]}});
  expect(result.status).toBe(200);
  expect(queries[0].upsert).toHaveBeenCalledWith(expect.objectContaining({project_name:'2026 Season CAM'}));
 });
});
describe('Fusion Runner machine self-registration',()=>{
 it('creates a disabled machine profile for a name that does not exist yet',async()=>{
  mocks.from
   .mockReturnValueOnce(chain({data:null,error:null}))
   .mockReturnValueOnce(chain({data:{id:'new-machine',name:'ShopSabre Router 1'},error:null}));
  const result=await call('register-machine',{name:'ShopSabre Router 1'});
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({machine:{id:'new-machine',name:'ShopSabre Router 1'},created:true});
  expect(queries[0].ilike).toHaveBeenCalledWith('name','ShopSabre Router 1');
  expect(queries[1].insert).toHaveBeenCalledWith({name:'ShopSabre Router 1',enabled:false});
 });
 it('reuses the existing machine instead of creating a duplicate on re-run',async()=>{
  mocks.from.mockReturnValueOnce(chain({data:{id:'existing-machine',name:'ShopSabre Router 1'},error:null}));
  const result=await call('register-machine',{name:'ShopSabre Router 1'});
  expect(await result.json()).toEqual({machine:{id:'existing-machine',name:'ShopSabre Router 1'},created:false});
  expect(mocks.from).toHaveBeenCalledTimes(1);
 });
 it('requires a name',async()=>{
  const result=await call('register-machine',{});
  expect(result.status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
 });
});
describe('Fusion Runner managed updates',()=>{
 it('returns the deployment-local checksum manifest without querying Supabase',async()=>{
  const result=await call('update-manifest');
  expect(result.status).toBe(200);
  expect((await result.json()).manifestUrl).toMatch(/^http:\/\/localhost\/downloads\/SpartanRoboticsAutoCAM-FusionAddIn\.manifest\.json\?check=\d+$/);
  expect(mocks.from).not.toHaveBeenCalled();
 });
});
describe('Fusion Runner per-machine tokens',()=>{
 it('does not expose the retired unauthenticated token-minting action',async()=>{
  mocks.isAuthorized.mockReturnValue(false);
  const result=await call('register-runner',{name:'ShopSabre Router 1'});
  expect(result.status).toBe(401);
  expect(mocks.from).not.toHaveBeenCalled();
 });
 it('accepts a self-issued token the static shared secret does not recognize',async()=>{
  mocks.isAuthorized.mockReturnValue(false);
  mocks.from.mockReturnValueOnce(chain({data:{id:'row-1'},error:null}));
  const result=await call('update-manifest',{},'Bearer frt_unique-machine-key');
  expect(result.status).toBe(200);
  expect(queries[0].eq).toHaveBeenCalledWith('token','frt_unique-machine-key');
 });
 it('rejects a token that matches nothing on file',async()=>{
  mocks.isAuthorized.mockReturnValue(false);
  mocks.from.mockReturnValueOnce(chain({data:null,error:null}));
  const result=await call('update-manifest',{},'Bearer nope');
  expect(result.status).toBe(401);
 });
 it('rejects every action with no credentials at all',async()=>{
  mocks.isAuthorized.mockReturnValue(false);
  const result=await call('update-manifest');
  expect(result.status).toBe(401);
  expect(mocks.from).not.toHaveBeenCalled(); // no bearer token presented - never even queries runner_tokens
 });
});
describe('Fusion Runner grouping lifecycle',()=>{
 it('marks unresolved claimed inputs failed instead of leaving a stranded claim',async()=>{
  mocks.from.mockReturnValueOnce(chain({error:null})).mockReturnValueOnce(chain({data:[{id:machineId,authorized_runner_id:null}]})).mockReturnValueOnce(chain({data:[{id:'job'}]})).mockReturnValueOnce(chain({data:{id:'job'}})).mockReturnValueOnce(chain({data:[]}));
  mocks.payload.mockRejectedValue(new Error('Part b is missing its STEP file'));
  const result=await call('claim',{runnerId:'runner',machineId});
  expect(await result.json()).toEqual({job:null,error:'Part b is missing its STEP file'});
  expect(queries[4].update).toHaveBeenCalledWith(expect.objectContaining({status:'failed'}));
  expect(queries[4].eq).toHaveBeenCalledWith('status','claimed');
  expect(queries[4].eq).toHaveBeenCalledWith('claimed_by','runner');
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
  mocks.from.mockReturnValueOnce(chain({error:null})).mockReturnValueOnce(chain({data:[{id:machineId,authorized_runner_id:null}]})).mockReturnValueOnce(chain({data:[]}));
  expect((await call('claim',{runnerId:'runner',machineId})).status).toBe(200);
  expect(queries[0].update).toHaveBeenCalledWith(expect.objectContaining({status:'queued',claimed_by:null,claimed_at:null}));
  expect(queries[0].eq).toHaveBeenCalledWith('status','claimed');
  expect(queries[0].lt).toHaveBeenCalledWith('claimed_at',expect.any(String));
 });
 it('retries recovering stale claims past a transient Supabase fetch failure',async()=>{
  mocks.from
   .mockReturnValueOnce(chain({error:{message:'TypeError: fetch failed'}}))
   .mockReturnValueOnce(chain({error:null}))
   .mockReturnValueOnce(chain({data:[{id:machineId,authorized_runner_id:null}]}))
   .mockReturnValueOnce(chain({data:[]}));
  const result=await call('claim',{runnerId:'runner',machineId});
  expect(result.status).toBe(200);
  expect(queries).toHaveLength(4);
 });
 it('only claims unassigned jobs when this runner is not the machine\'s authorized one',async()=>{
  mocks.from
   .mockReturnValueOnce(chain({error:null}))
   .mockReturnValueOnce(chain({data:[{id:machineId,authorized_runner_id:'the-real-computer'}]}))
   .mockReturnValueOnce(chain({data:[]}));
  expect((await call('claim',{runnerId:'a-different-computer',machineId})).status).toBe(200);
  expect(queries[2].is).toHaveBeenCalledWith('machine_id',null);
  expect(queries[2].or).not.toHaveBeenCalled();
 });
 it('claims machine-specific jobs normally once the runner id matches the authorized one',async()=>{
  mocks.from
   .mockReturnValueOnce(chain({error:null}))
   .mockReturnValueOnce(chain({data:[{id:machineId,authorized_runner_id:'the-real-computer'}]}))
   .mockReturnValueOnce(chain({data:[]}));
  expect((await call('claim',{runnerId:'the-real-computer',machineId})).status).toBe(200);
  expect(queries[2].or).toHaveBeenCalledWith(`machine_id.is.null,machine_id.in.(${machineId})`);
 });
 it('accepts the plural machineIds array and claims jobs for any authorized machine in it',async()=>{
  const otherMachineId='33333333-3333-4333-8333-333333333333';
  mocks.from
   .mockReturnValueOnce(chain({error:null}))
   .mockReturnValueOnce(chain({data:[{id:machineId,authorized_runner_id:null},{id:otherMachineId,authorized_runner_id:'the-real-computer'}]}))
   .mockReturnValueOnce(chain({data:[]}));
  expect((await call('claim',{runnerId:'the-real-computer',machineIds:[machineId,otherMachineId]})).status).toBe(200);
  expect(queries[1].in).toHaveBeenCalledWith('id',[machineId,otherMachineId]);
  expect(queries[2].or).toHaveBeenCalledWith(`machine_id.is.null,machine_id.in.(${machineId},${otherMachineId})`);
 });
 it('excludes only the one machineId this runner is not authorized for, from a multi-machine claim',async()=>{
  const otherMachineId='33333333-3333-4333-8333-333333333333';
  mocks.from
   .mockReturnValueOnce(chain({error:null}))
   .mockReturnValueOnce(chain({data:[{id:machineId,authorized_runner_id:'a-different-computer'},{id:otherMachineId,authorized_runner_id:null}]}))
   .mockReturnValueOnce(chain({data:[]}));
  expect((await call('claim',{runnerId:'the-real-computer',machineIds:[machineId,otherMachineId]})).status).toBe(200);
  expect(queries[2].or).toHaveBeenCalledWith(`machine_id.is.null,machine_id.in.(${otherMachineId})`);
 });
 it('rejects machineIds containing anything that is not a UUID',async()=>{
  expect((await call('claim',{runnerId:'runner',machineIds:[machineId,'invalid']})).status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
 });
 it('rejects an empty machineIds array the same as a missing one',async()=>{
  expect((await call('claim',{runnerId:'runner',machineIds:[]})).status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
 });
 it('does not retry a real database error recovering stale claims',async()=>{
  mocks.from.mockReturnValueOnce(chain({error:{message:'permission denied for table cam_jobs'}}));
  const result=await call('claim',{runnerId:'runner',machineId});
  expect(result.status).toBe(500);
  expect(await result.json()).toEqual({error:'Could not recover stale Fusion jobs: permission denied for table cam_jobs'});
  expect(queries).toHaveLength(1);
 });
 it('stores exact Fusion output artifacts without synthesizing a combined program',async()=>{
  const contentBase64=Buffer.from('N10 G90\r\nM30\r\n','utf8').toString('base64');
  mocks.from
  .mockReturnValueOnce(chain({data:{id:'job',params:{fusionJobKind:'plate:cam',fusionFileName:'X44 Stiffener',fusionPlateSnapshot:{name:'x44 stiffner'}}}}))
   .mockReturnValueOnce(chain({data:[{id:'job'}]}));
  const result=await call('complete',{jobId:'job',runnerId:'runner',ncFiles:[{name:'plate.nc',contentBase64}]});
  expect(result.status).toBe(200);
  expect(queries[1].update).toHaveBeenCalledWith(expect.objectContaining({
   gcode:null,
   gcode_file_name:null,
   fusion_nc_files:[expect.objectContaining({name:'plate.nc',contentBase64,size:14})]
  }));
  expect(mocks.storageUpload).toHaveBeenCalledWith(
   'AutoCAM/X44Stiffener(AUTOCAM).ngc',
   expect.any(Buffer),
   {upsert:true,contentType:'text/plain'}
  );
  expect(mocks.storageUpload).toHaveBeenCalledWith(
   'Nesting Parts Library/AutoCAM/X44Stiffener(AUTOCAM)/X44Stiffener(AUTOCAM).ngc',
   expect.any(Buffer),
   {upsert:true,contentType:'text/plain'}
  );
 });
 it('posts all four separate tube-face programs inside one Files/AutoCAM folder before completing',async()=>{
  const side12=Buffer.from('G20\nM30\n','utf8').toString('base64');
  const side3=Buffer.from('G20\nM30\n','utf8').toString('base64');
  const side6=Buffer.from('G20\nM30\n','utf8').toString('base64');
  const side9=Buffer.from('G20\nM30\n','utf8').toString('base64');
  mocks.from
   .mockReturnValueOnce(chain({data:{id:'tube-job',params:{fusionJobKind:'box_tube',fusionFileName:'Bottom Tube'}}}))
   .mockReturnValueOnce(chain({data:[{id:'tube-job'}]}));
  expect((await call('complete',{jobId:'tube-job',runnerId:'runner',ncFiles:[
   {name:'Bottom Tube-side-12.tap',contentBase64:side12},
   {name:'Bottom Tube-side-3.tap',contentBase64:side3},
   {name:'Bottom Tube-side-6.tap',contentBase64:side6},
   {name:'Bottom Tube-side-9.tap',contentBase64:side9}
  ]})).status).toBe(200);
  expect(mocks.storageUpload.mock.calls.map(([path])=>path)).toEqual([
   'AutoCAM/tube-job/BottomTubetubeside12(AUTOCAM).tap',
   'Nesting Parts Library/AutoCAM/BottomTubetubeside12(AUTOCAM)/BottomTubetubeside12(AUTOCAM).tap',
   'AutoCAM/tube-job/BottomTubetubeside3(AUTOCAM).tap',
   'Nesting Parts Library/AutoCAM/BottomTubetubeside3(AUTOCAM)/BottomTubetubeside3(AUTOCAM).tap',
   'AutoCAM/tube-job/BottomTubetubeside6(AUTOCAM).tap',
   'Nesting Parts Library/AutoCAM/BottomTubetubeside6(AUTOCAM)/BottomTubetubeside6(AUTOCAM).tap',
   'AutoCAM/tube-job/BottomTubetubeside9(AUTOCAM).tap',
   'Nesting Parts Library/AutoCAM/BottomTubetubeside9(AUTOCAM)/BottomTubetubeside9(AUTOCAM).tap'
  ]);
 });
 it('rejects a tube completion that is missing a setup program',async()=>{
  mocks.from.mockReturnValueOnce(chain({data:{id:'tube-job',params:{fusionJobKind:'box_tube'}}}));
  const program=Buffer.from('G20\nM30\n','utf8').toString('base64');
  const result=await call('complete',{jobId:'tube-job',runnerId:'runner',ncFiles:[
   {name:'tube-side-12.nc',contentBase64:program}, {name:'tube-side-3.nc',contentBase64:program}, {name:'tube-side-6.nc',contentBase64:program}
  ]});
  expect(result.status).toBe(500);
  expect((await result.json()).error).toMatch(/exactly four/i);
  expect(mocks.storageUpload).not.toHaveBeenCalled();
 });
 it('does not mark a job complete when publishing Files/AutoCAM fails',async()=>{
  mocks.storageUpload.mockResolvedValueOnce({error:{message:'storage unavailable'}});
  mocks.from.mockReturnValueOnce(chain({data:{id:'job',params:{fusionJobKind:'plate:cam',fusionFileName:'Bracket'}}}));
  const result=await call('complete',{jobId:'job',runnerId:'runner',ncFiles:[{name:'plate.nc',contentBase64:'TTAw'}]});
  expect(result.status).toBe(500);
  expect((await result.json()).error).toMatch(/AutoCAM\/Bracket\(AUTOCAM\)\.ngc/);
  expect(queries).toHaveLength(1);
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
});
describe('Fusion Runner own-job recovery on restart',()=>{
 it('requires a runner identifier',async()=>{
  expect((await call('recover-own-jobs',{})).status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
 });
 it('requeues its own never-started claims and fails its own interrupted processing jobs',async()=>{
  mocks.from
   .mockReturnValueOnce(chain({data:[{id:'job-claimed'}],error:null}))
   .mockReturnValueOnce(chain({data:[{id:'job-processing'}],error:null}));
  const result=await call('recover-own-jobs',{runnerId:'runner'});
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({success:true,requeued:1,failed:1});
  expect(queries[0].update).toHaveBeenCalledWith(expect.objectContaining({status:'queued',claimed_by:null,claimed_at:null}));
  expect(queries[0].eq).toHaveBeenCalledWith('claimed_by','runner');
  expect(queries[0].eq).toHaveBeenCalledWith('status','claimed');
  expect(queries[1].update).toHaveBeenCalledWith(expect.objectContaining({status:'failed'}));
  expect(queries[1].eq).toHaveBeenCalledWith('claimed_by','runner');
  expect(queries[1].eq).toHaveBeenCalledWith('status','processing');
 });
 it('never touches another runner\'s claims',async()=>{
  mocks.from.mockReturnValue(chain({data:[],error:null}));
  await call('recover-own-jobs',{runnerId:'runner-a'});
  expect(queries[0].eq).not.toHaveBeenCalledWith('claimed_by','runner-b');
  expect(queries[0].eq).toHaveBeenCalledWith('claimed_by','runner-a');
 });
});
describe('Fusion Runner plate growth',()=>{
 it('rejects a malformed plate ID',async()=>{
  const result=await call('grow-plate',{plateId:'not-a-uuid',length:34,width:34});
  expect(result.status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
 });
 it('rejects a non-positive or missing length/width',async()=>{
  expect((await call('grow-plate',{plateId,length:0,width:34})).status).toBe(400);
  expect((await call('grow-plate',{plateId,length:34})).status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
 });
 it('reports 404 for a plate that no longer exists',async()=>{
  mocks.from.mockReturnValueOnce(chain({data:null,error:null}));
  const result=await call('grow-plate',{plateId,length:34,width:34});
  expect(result.status).toBe(404);
 });
 it('grows a plate to the requested size when it is bigger than the current one',async()=>{
  mocks.from
   .mockReturnValueOnce(chain({data:{id:plateId,width:24,length:24},error:null}))
   .mockReturnValueOnce(chain({error:null}));
  const result=await call('grow-plate',{plateId,length:34,width:34});
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({success:true,grown:true,length:34,width:34});
  expect(queries[1].update).toHaveBeenCalledWith({length:34,width:34});
  expect(queries[1].eq).toHaveBeenCalledWith('id',plateId);
 });
 it('never shrinks a plate that is already at least as big as requested',async()=>{
  mocks.from.mockReturnValueOnce(chain({data:{id:plateId,width:100,length:100},error:null}));
  const result=await call('grow-plate',{plateId,length:34,width:34});
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({success:true,grown:false});
  expect(mocks.from).toHaveBeenCalledTimes(1);
 });
 it('grows only the dimension that actually needs it, keeping the other at its current (possibly larger) size',async()=>{
  mocks.from
   .mockReturnValueOnce(chain({data:{id:plateId,width:100,length:24},error:null}))
   .mockReturnValueOnce(chain({error:null}));
  const result=await call('grow-plate',{plateId,length:34,width:34});
  expect(await result.json()).toEqual({success:true,grown:true,length:34,width:100});
  expect(queries[1].update).toHaveBeenCalledWith({length:34,width:100});
 });
});
