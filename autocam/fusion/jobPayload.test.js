import { describe, expect, it, vi } from 'vitest';
import { buildJobPayload } from './jobPayload.js';
const job = () => ({params:{fusionJobKind:'plate:cam',plateId:'plate',fusionPlateSnapshot:{version:1,plate_id:'plate',length:24,width:12,true_depth:0.125,thickness:0.125,assignments:[{part_id:'a',quantity:2,step_file_name:'a.step'},{part_id:'b',quantity:3,step_file_name:'b.step'}]}}});
const db = () => ({storage:{from:()=>({createSignedUrl:vi.fn(async f=>({data:{signedUrl:`https://example.invalid/${f}`}}))})}});
describe('Fusion plate payloads',()=>{
 it('resolves all copies from the snapshot without querying mutable tables',async()=>{
  const payload=await buildJobPayload(db(),job());
  expect(payload.assignments.map(p=>[p.part_id,p.quantity])).toEqual([['a',2],['b',3]]);
 });
 it('fails the entire plate when any file is missing or cannot be signed',async()=>{
  const j=job(); j.params.fusionPlateSnapshot.assignments[1].step_file_name=null;
  await expect(buildJobPayload(db(),j)).rejects.toThrow(/Part b/);
  const broken={storage:{from:()=>({createSignedUrl:async f=>f==='a.step'?{data:{signedUrl:'valid'}}:{error:{message:'missing'}}})}};
  await expect(buildJobPayload(broken,job())).rejects.toThrow(/part b/);
 });
 it('rejects legacy unsnapshotted jobs, wrong plates, invalid quantities and dimensions',async()=>{
  const j=job(); delete j.params.fusionPlateSnapshot;
  await expect(buildJobPayload(db(),j)).rejects.toThrow(/Queue a new job/);
  for(const change of [j=>j.params.plateId='other',j=>j.params.fusionPlateSnapshot.width=0,j=>j.params.fusionPlateSnapshot.assignments[0].quantity=1.5]){
   const value=job();change(value);await expect(buildJobPayload(db(),value)).rejects.toThrow();
  }
 });
});
