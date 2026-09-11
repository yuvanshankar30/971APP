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
 it('sends only the selected cutter to Fusion for a single-tool plate job',async()=>{
  const value=job(); value.machine_id='router'; value.tool_id='main-bit'; value.params.singleToolMode=true; value.cam_tools={tool_type:'flat end mill'};
  const database={
   storage:db().storage,
   from:(table)=>table==='cam_machine_tools'?{select:()=>({eq:async()=>({data:[
    {tool_id:'main-bit',cam_tools:{tool_library_guid:'main-guid',tool_type:'flat end mill'}},
    {tool_id:'detail-bit',cam_tools:{tool_library_guid:'detail-guid',tool_type:'flat end mill'}}
   ]})})}:null
  };
  await expect(buildJobPayload(database,value)).resolves.toMatchObject({
   single_tool_mode:true, tool_items:[{tool_id:'main-bit',tool_guid:'main-guid'}]
  });
 });
 it('accepts a loaded single tool that has no tool_library_guid, like UNC Router\'s own bit',async()=>{
  // Real, confirmed live regression: UNC Router's single tool ("UNC
  // Router 0.1575 in Flat End Mill") has never had a tool_library_guid
  // and is still genuinely loaded (present in cam_machine_tools) - a job
  // queued against it must succeed, with an empty tool_items (nothing to
  // hand Fusion a guid for), not fail "not loaded on this machine".
  const value=job(); value.machine_id='unc-router'; value.tool_id='unc-bit'; value.params.singleToolMode=true; value.cam_tools={tool_type:'flat end mill'};
  const database={
   storage:db().storage,
   from:(table)=>table==='cam_machine_tools'?{select:()=>({eq:async()=>({data:[
    {tool_id:'unc-bit',cam_tools:{tool_library_guid:null,tool_type:'flat end mill'}}
   ]})})}:null
  };
  await expect(buildJobPayload(database,value)).resolves.toMatchObject({
   single_tool_mode:true, tool_items:[]
  });
 });
 it('sends loaded endmill and drill candidates, not every installed tool, for auto multi-tool CAM',async()=>{
  const value=job(); value.machine_id='router'; value.tool_id='endmill'; value.params.multiToolMode=true;
  value.cam_machines={name:'New Router'}; value.params.fusionPlateSnapshot.material='Aluminum 6061';
  const database={
   storage:db().storage,
   from:(table)=>table==='cam_machine_tools'?{select:()=>({eq:async()=>({data:[
    {tool_id:'endmill',cam_tools:{tool_library_guid:'endmill-guid',tool_type:'flat end mill'}},
    {tool_id:'drill',cam_tools:{tool_library_guid:'drill-guid',tool_type:'drill'}}
   ]})})}:null
  };
  await expect(buildJobPayload(database,value)).resolves.toMatchObject({
   multi_tool_mode:true, tool_items:[{tool_guid:'endmill-guid'},{tool_guid:'drill-guid'}]
  });
 });
 it('ignores a stale tool_id in multi-tool mode instead of failing the whole job',async()=>{
  // Real, confirmed case: a job queued in multi-tool mode still carried an
  // old single-tool selection (a tool with no tool_library_guid - e.g. a
  // legacy pre-import tool row) - multi-tool mode doesn't use that field at
  // all, so it must not be validated against the loaded candidate set.
  const value=job(); value.machine_id='router'; value.tool_id='stale-legacy-tool'; value.params.multiToolMode=true;
  value.cam_machines={name:'New Router'}; value.params.fusionPlateSnapshot.material='Aluminum 6061';
  const database={
   storage:db().storage,
   from:(table)=>table==='cam_machine_tools'?{select:()=>({eq:async()=>({data:[
    {tool_id:'endmill',cam_tools:{tool_library_guid:'endmill-guid',tool_type:'flat end mill'}},
    {tool_id:'stale-legacy-tool',cam_tools:{tool_library_guid:null,tool_type:'flat end mill'}}
   ]})})}:null
  };
  await expect(buildJobPayload(database,value)).resolves.toMatchObject({
   multi_tool_mode:true, tool_items:[{tool_guid:'endmill-guid'}]
  });
 });
 it('rejects multi-tool mode away from New Router or Aluminum 6061',async()=>{
  const wrongMachine=job(); wrongMachine.params.multiToolMode=true; wrongMachine.cam_machines={name:'UNC Router'};
  wrongMachine.params.fusionPlateSnapshot.material='Aluminum 6061';
  await expect(buildJobPayload(db(),wrongMachine)).rejects.toThrow(/only on New Router/);
  const wrongMaterial=job(); wrongMaterial.params.multiToolMode=true; wrongMaterial.cam_machines={name:'New Router'};
  wrongMaterial.params.fusionPlateSnapshot.material='SRPP';
  await expect(buildJobPayload(db(),wrongMaterial)).rejects.toThrow(/only for Aluminum 6061/);
 });
 it('rejects contradictory single-tool and multi-tool modes',async()=>{
  const value=job(); value.params.singleToolMode=true; value.params.multiToolMode=true;
  await expect(buildJobPayload(db(),value)).rejects.toThrow(/cannot both/);
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
 it('is null when the queue explicitly stores its unset value as null',async()=>{
  const j=job(); j.params.tabCount=null;
  const payload=await buildJobPayload(db(),j);
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
 const tubeJob=()=>({machine_id:'router',tool_id:'main-bit',cam_tools:{tool_type:'flat end mill'},cam_machines:{name:'UNC Router'},params:{fusionJobKind:'box_tube',boxTubeId:'tube-1',fusionFileName:'BottomTube',fusionFolderPath:'Offseason Projects/AutoCAM/Tubes'}});
 const tubeDb=()=>({
  storage:{from:()=>({createSignedUrl:vi.fn(async()=>({data:{signedUrl:'https://example.invalid/tube.step'}}))})},
  from:(table)=>table==='cam_machine_tools'
   ?{select:()=>({eq:async()=>({data:[{tool_id:'main-bit',cam_tools:{tool_library_guid:'main-guid',tool_type:'flat end mill'}}]})})}
   :{select:()=>({eq:()=>({single:async()=>({data:{id:'tube-1',step_file_name:'tube.step'}})})})}
 });
 it('forwards the requested Fusion document name and folder to the runner',async()=>{
  await expect(buildJobPayload(tubeDb(),tubeJob())).resolves.toMatchObject({
   box_tube_id:'tube-1', fusion_file_name:'BottomTube', fusion_folder_path:'Offseason Projects/AutoCAM/Tubes', orientation:'vertical'
  });
 });
 it('forwards a valid tube orientation and normalizes invalid legacy values',async()=>{
  const horizontal=tubeJob(); horizontal.params.orientation=' HORIZONTAL ';
  await expect(buildJobPayload(tubeDb(),horizontal)).resolves.toMatchObject({orientation:'horizontal'});
  const invalid=tubeJob(); invalid.params.orientation='diagonal';
  await expect(buildJobPayload(tubeDb(),invalid)).resolves.toMatchObject({orientation:'vertical'});
 });
 it('keeps old tube jobs compatible when no save destination was selected',async()=>{
  const value=tubeJob(); delete value.params.fusionFileName; delete value.params.fusionFolderPath;
  await expect(buildJobPayload(tubeDb(),value)).resolves.toMatchObject({fusion_file_name:null,fusion_folder_path:null});
 });
 it('never includes tab_count - TabPlacement never runs for tube stock',async()=>{
  const payload=await buildJobPayload(tubeDb(),tubeJob());
  expect(payload).not.toHaveProperty('tab_count');
 });
 it('queues successfully with UNC Router\'s real fixed tool, which has no tool_library_guid',async()=>{
  // Real, confirmed shape: every UNC Router box-tube job uses the exact
  // same fixed tool ("UNC Router 0.1575 in Flat End Mill") which has
  // never had a tool_library_guid - tubes never swap tools, but
  // buildJobPayload's tool_items resolution runs for ANY job carrying a
  // tool_id, tube or plate, single-tool or not. Must stay unaffected by
  // the guid requirement that only matters for tool_items' own contents.
  const value=tubeJob(); value.machine_id='unc-router'; value.tool_id='unc-bit'; value.params.singleToolMode=true; value.cam_tools={tool_type:'flat end mill'};
  const database={
   storage:tubeDb().storage,
   from:(table)=>table==='cam_machine_tools'
    ?{select:()=>({eq:async()=>({data:[{tool_id:'unc-bit',cam_tools:{tool_library_guid:null,tool_type:'flat end mill'}}]})})}
    :{select:()=>({eq:()=>({single:async()=>({data:{id:'tube-1',step_file_name:'tube.step'}})})})}
  };
  await expect(buildJobPayload(database,value)).resolves.toMatchObject({
   box_tube_id:'tube-1', tool_id:'unc-bit', tool_items:[]
  });
 });
 it('sends only the selected tube cutter to Fusion',async()=>{
  const value=tubeJob(); value.machine_id='new-router'; value.tool_id='main-bit'; value.params.singleToolMode=true;
  value.cam_tools={tool_type:'flat end mill'}; value.cam_machines={name:'New Router'};
  const database={
   storage:tubeDb().storage,
   from:(table)=>table==='cam_machine_tools'
    ?{select:()=>({eq:async()=>({data:[
      {tool_id:'main-bit',cam_tools:{tool_library_guid:'main-guid',tool_type:'flat end mill'}},
      {tool_id:'other-bit',cam_tools:{tool_library_guid:'other-guid',tool_type:'flat end mill'}}
    ]})})}
    :{select:()=>({eq:()=>({single:async()=>({data:{id:'tube-1',step_file_name:'tube.step'}})})})}
  };
  await expect(buildJobPayload(database,value)).resolves.toMatchObject({
   single_tool_mode:true, tool_items:[{tool_id:'main-bit',tool_guid:'main-guid'}]
  });
 });
 it('rejects a New Router single tool with no Fusion library identity',async()=>{
  const value=tubeJob(); value.machine_id='new-router'; value.tool_id='bad-bit'; value.params.singleToolMode=true;
  value.cam_tools={tool_type:'flat end mill'}; value.cam_machines={name:'New Router'};
  const database={
   storage:tubeDb().storage,
   from:(table)=>table==='cam_machine_tools'
    ?{select:()=>({eq:async()=>({data:[{tool_id:'bad-bit',cam_tools:{tool_library_guid:null,tool_type:'flat end mill'}}]})})}
    :{select:()=>({eq:()=>({single:async()=>({data:{id:'tube-1',step_file_name:'tube.step'}})})})}
  };
  await expect(buildJobPayload(database,value)).rejects.toThrow(/no bundled Fusion tool-library identity/i);
 });
});

describe('Fusion turning payloads',()=>{
 const turningJob=()=>({machine_id:'lathe-1',params:{fusionJobKind:'turning',turningPartId:'shaft-1',fusionFileName:'Shaft1',fusionFolderPath:'Offseason Projects/AutoCAM/Turning'}});
 const turningDb=(row)=>({
  storage:{from:()=>({createSignedUrl:vi.fn(async()=>({data:{signedUrl:'https://example.invalid/shaft.step'}}))})},
  from:()=>({select:()=>({eq:()=>({single:async()=>({data:row})})})})
 });
 it('forwards cam_type and an optional tailstock length override to the runner',async()=>{
  await expect(buildJobPayload(
   turningDb({id:'shaft-1',cam_type:'hexShaft',tailstock_length_in:2.5,step_file_name:'shaft.step'}),
   turningJob()
  )).resolves.toMatchObject({
   turning_part_id:'shaft-1', cam_type:'hexShaft', tailstock_length_in:2.5,
   fusion_file_name:'Shaft1', fusion_folder_path:'Offseason Projects/AutoCAM/Turning'
  });
 });
 it('passes a null tailstock length through - both handlers default it themselves', async () => {
  await expect(buildJobPayload(
   turningDb({id:'shaft-1',cam_type:'spacer',tailstock_length_in:null,step_file_name:'shaft.step'}),
   turningJob()
  )).resolves.toMatchObject({tailstock_length_in:null});
 });
 it('keeps old turning jobs compatible when no save destination was selected',async()=>{
  const value=turningJob(); delete value.params.fusionFileName; delete value.params.fusionFolderPath;
  await expect(buildJobPayload(
   turningDb({id:'shaft-1',cam_type:'spacer',tailstock_length_in:null,step_file_name:'shaft.step'}),
   value
  )).resolves.toMatchObject({fusion_file_name:null,fusion_folder_path:null});
 });
 it('rejects a turning part that no longer exists',async()=>{
  await expect(buildJobPayload(turningDb(null),turningJob())).rejects.toThrow(/turning part not found/i);
 });
 it('never includes tool_items or single_tool_mode - turning has no mill tool catalog to select from',async()=>{
  const payload=await buildJobPayload(
   turningDb({id:'shaft-1',cam_type:'spacer',tailstock_length_in:null,step_file_name:'shaft.step'}),
   turningJob()
  );
  expect(payload).not.toHaveProperty('tool_items');
  expect(payload).not.toHaveProperty('single_tool_mode');
 });
});
