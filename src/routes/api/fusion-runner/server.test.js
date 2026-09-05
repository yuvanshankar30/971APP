import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks=vi.hoisted(()=>({from:vi.fn(),payload:vi.fn()}));
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({from:mocks.from})}));
vi.mock('$env/dynamic/private',()=>({env:{}}));
vi.mock('$lib/server/fusion_runner_auth.js',()=>({isAuthorizedFusionRunnerRequest:()=>true}));
vi.mock('$autocam/fusion/jobPayload.js',()=>({buildJobPayload:mocks.payload}));
import { POST } from './+server.js';
const call=(action,body={})=>POST({url:new URL(`http://localhost/api/fusion-runner?action=${action}`),request:new Request('http://localhost',{method:'POST',body:JSON.stringify(body)})});
let queries;
beforeEach(()=>{queries=[];mocks.from.mockReset();mocks.payload.mockReset();});
function chain(result){
 const q={};for(const method of ['select','update','eq','in','order','limit','or'])q[method]=vi.fn(()=>q);
 q.single=vi.fn(async()=>result);q.then=(resolve)=>resolve(result);queries.push(q);return q;
}
describe('Fusion Runner grouping lifecycle',()=>{
 it('marks unresolved claimed inputs failed instead of leaving a stranded claim',async()=>{
  mocks.from.mockReturnValueOnce(chain({data:[{id:'job'}]})).mockReturnValueOnce(chain({data:{id:'job'}})).mockReturnValueOnce(chain({data:[]}));
  mocks.payload.mockRejectedValue(new Error('Part b is missing its STEP file'));
  const result=await call('claim',{runnerId:'runner'});
  expect(await result.json()).toEqual({job:null,error:'Part b is missing its STEP file'});
  expect(queries[2].update).toHaveBeenCalledWith(expect.objectContaining({status:'failed'}));
  expect(queries[2].eq).toHaveBeenCalledWith('status','claimed');
 });
 it('does not let a late failure overwrite terminal or non-Fusion jobs',async()=>{
  mocks.from.mockReturnValue(chain({data:[]}));
  expect((await call('fail',{jobId:'job',error:'late'})).status).toBe(409);
  expect(queries[0].eq).toHaveBeenCalledWith('operation_type','milling');
  expect(queries[0].in).toHaveBeenCalledWith('status',['claimed','processing']);
 });
 it('rejects a malformed machine ID rather than claiming another machine’s jobs',async()=>{
  expect((await call('claim',{runnerId:'runner',machineId:'invalid'})).status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
 });
});
