import { describe, expect, it, vi } from 'vitest';
import { buildJobPayload } from './jobPayload.js';
const job = () => ({params:{fusionJobKind:'plate:cam',plateId:'plate',fusionPlateSnapshot:{version:1,grouping_mode:'grouped',plate_id:'plate',length:24,width:12,true_depth:0.125,thickness:0.125,assignments:[{part_id:'a',quantity:2,step_file_name:'a.step'},{part_id:'b',quantity:3,step_file_name:'b.step'}]}}});
const db = () => ({storage:{from:()=>({createSignedUrl:vi.fn(async f=>({data:{signedUrl:`https://example.invalid/${f}`}}))})}});
describe('Fusion plate payloads',()=>{
 it('resolves all copies from the snapshot without querying mutable tables',async()=>{
  const payload=await buildJobPayload(db(),job());
  expect(payload.assignments.map(p=>[p.part_id,p.quantity])).toEqual([['a',2],['b',3]]);
 });
 it('signs independent STEP inputs concurrently instead of serializing storage latency',async()=>{
  const resolvers=[];
  const createSignedUrl=vi.fn((fileName)=>new Promise((resolve)=>resolvers.push(()=>resolve({data:{signedUrl:`https://example.invalid/${fileName}`}}))));
  const pending=buildJobPayload({storage:{from:()=>({createSignedUrl})}},job());
  await Promise.resolve();
  await Promise.resolve();
  expect(createSignedUrl).toHaveBeenCalledTimes(2);
  resolvers.forEach((resolve)=>resolve());
  await expect(pending).resolves.toMatchObject({assignments:[{part_id:'a'},{part_id:'b'}]});
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
 it('rejects snapshots whose assignment count contradicts their mode',async()=>{
  const grouped=job(); grouped.params.fusionPlateSnapshot.assignments.pop();
  await expect(buildJobPayload(db(),grouped)).rejects.toThrow(/at least two/);
  const single=job(); single.params.fusionPlateSnapshot.grouping_mode='single';
  await expect(buildJobPayload(db(),single)).rejects.toThrow(/exactly one/);
 });
 it('refuses a non-endmill before a single-tool job reaches the Runner',async()=>{
  const value=job(); value.params.singleToolMode=true; value.cam_tools={tool_type:'drill'};
  await expect(buildJobPayload(db(),value)).rejects.toThrow(/requires an endmill/i);
 });
 it('passes the single-tool safety contract through to a valid plate payload',async()=>{
  const value=job(); value.params.singleToolMode=true; value.cam_tools={tool_type:'endmill'};
  await expect(buildJobPayload(db(),value)).resolves.toMatchObject({single_tool_mode:true});
 });
 it('sends loaded endmill and drill candidates, not every installed tool, for auto multi-tool CAM',async()=>{
  const value=job(); value.machine_id='router'; value.tool_id='endmill'; value.params.multiToolMode=true;
  const database={
   storage:db().storage,
   from:(table)=>table==='cam_machine_tools'?{select:()=>({eq:async()=>({data:[
    {tool_id:'endmill',cam_tools:{tool_library_guid:'endmill-guid',tool_type:'flat end mill'}},
    {tool_id:'drill',cam_tools:{tool_library_guid:'drill-guid',tool_type:'drill'}},
    {tool_id:'counter',cam_tools:{tool_library_guid:'counter-guid',tool_type:'counter sink'}}
   ]})})}:null
  };
  await expect(buildJobPayload(database,value)).resolves.toMatchObject({
   multi_tool_mode:true, tool_items:[{tool_guid:'endmill-guid'},{tool_guid:'drill-guid'}]
  });
 });
 it('only passes a loaded, approved ShopSabre countersink to the Runner',async()=>{
  const j=job(); j.machine_id='router'; j.params.countersinkToolId='counter';
  const countersink={id:'counter',tool_type:'countersink',diameter:0.372,tool_number:5,tip_angle:82,tool_library_guid:'61a8645a-9015-4aba-958b-70297d26b19e',source_tool_library_file:'Normal router tools (use this).tools'};
  const database={
   storage:db().storage,
   from:(table)=>table==='cam_machine_tools'?{select:()=>({eq:()=>({eq:()=>({maybeSingle:async()=>({data:{cam_tools:countersink}})})})})}:null
  };
  await expect(buildJobPayload(database,j)).resolves.toMatchObject({countersink_tool:{guid:countersink.tool_library_guid,tool_number:5}});
 });
 it('rejects an unapproved countersink even if it is loaded',async()=>{
  const j=job(); j.machine_id='router'; j.params.countersinkToolId='counter';
  const database={
   storage:db().storage,
   from:()=>({select:()=>({eq:()=>({eq:()=>({maybeSingle:async()=>({data:{cam_tools:{tool_type:'countersink',diameter:0.25,tip_angle:82,tool_library_guid:'other',source_tool_library_file:'Normal router tools (use this).tools'}}})})})})})
  };
  await expect(buildJobPayload(database,j)).rejects.toThrow(/not an approved/i);
 });
});

describe('Fusion plate payload tab_count override',()=>{
 // Direct instruction: an operator can force an exact tab count instead
 // of the automatic perimeter-based target - "cannot be too much", so
 // this must clamp rather than pass a value through as-is.
 it('is null when the operator never set one - stays automatic',async()=>{
  const payload=await buildJobPayload(db(),job());
  expect(payload.tab_count).toBeNull();
 });
 it('passes a normal in-range value through unchanged',async()=>{
  const j=job(); j.params.tabCount=8;
  const payload=await buildJobPayload(db(),j);
  expect(payload.tab_count).toBe(8);
 });
 it('clamps an excessive value to the max instead of sending it as-is',async()=>{
  const j=job(); j.params.tabCount=500;
  const payload=await buildJobPayload(db(),j);
  expect(payload.tab_count).toBe(20);
 });
 it('clamps a too-low value up to the minimum',async()=>{
  const j=job(); j.params.tabCount=0;
  const payload=await buildJobPayload(db(),j);
  expect(payload.tab_count).toBe(4);
 });
 it('treats a non-numeric value the same as unset rather than sending garbage',async()=>{
  const j=job(); j.params.tabCount='not-a-number';
  const payload=await buildJobPayload(db(),j);
  expect(payload.tab_count).toBeNull();
 });
});

describe('Fusion box-tube payloads',()=>{
 const tubeJob=()=>({params:{fusionJobKind:'box_tube',boxTubeId:'tube-1',fusionFileName:'BottomTube',fusionFolderPath:'Offseason Projects/AutoCAM/Tubes'}});
 const tubeDb=()=>({
  storage:{from:()=>({createSignedUrl:vi.fn(async()=>({data:{signedUrl:'https://example.invalid/tube.step'}}))})},
  from:()=>({select:()=>({eq:()=>({single:async()=>({data:{id:'tube-1',step_file_name:'tube.step'}})})})})
 });
 it('forwards the requested Fusion document name and folder to the runner',async()=>{
  await expect(buildJobPayload(tubeDb(),tubeJob())).resolves.toMatchObject({
   box_tube_id:'tube-1', fusion_file_name:'BottomTube', fusion_folder_path:'Offseason Projects/AutoCAM/Tubes'
  });
 });
 it('keeps old tube jobs compatible when no save destination was selected',async()=>{
  const value=tubeJob(); delete value.params.fusionFileName; delete value.params.fusionFolderPath;
  await expect(buildJobPayload(tubeDb(),value)).resolves.toMatchObject({fusion_file_name:null,fusion_folder_path:null});
 });
 it('never includes tab_count - TabPlacement never runs for tube stock',async()=>{
  const payload=await buildJobPayload(tubeDb(),tubeJob());
  expect(payload).not.toHaveProperty('tab_count');
 });
});
