import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';

let db;
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const migration = (name) => readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
const run = (sql, values = []) => db.query(sql, values);
const assign = (qty, plate = 10, part = 20, cat = 1) => run(`INSERT INTO fusion_part_category_assignments VALUES ($1,$2,$3,$4)
 ON CONFLICT (plate_id,part_id) DO UPDATE SET quantity=excluded.quantity`, [id(cat),id(plate),id(part),qty]);
const remaining = async () => (await run('SELECT quantity FROM fusion_parts WHERE id=$1', [id(20)])).rows[0]?.quantity;
const queue = (mode = 'grouped', selectedPartId = null, selectedPartIds = mode === 'grouped' ? [id(20), id(21)] : null) => run(`INSERT INTO cam_jobs (operation_type,params,machine_id,tool_id,status) VALUES
 ('milling',$1,$2,$3,'queued') RETURNING *`, [{
   fusionJobKind:'plate:cam', plateId:id(10), fusionGroupingMode:mode,
   ...(selectedPartId ? { selectedPartId } : {}), ...(selectedPartIds ? { selectedPartIds } : {})
 }, id(30), id(40)]);

beforeAll(async () => {
 db = new PGlite();
 await db.exec(`CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.uid',true),'')::uuid $$;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE TABLE user_profiles(id uuid PRIMARY KEY, role text, general_role text, team_role text, banned boolean);
 CREATE FUNCTION approved_user() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.approved',true),'false')='true' $$;
 CREATE FUNCTION update_cam_studio_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
 CREATE TABLE cam_materials(id uuid PRIMARY KEY, name text);
 CREATE TABLE cam_machines(id uuid PRIMARY KEY, enabled boolean, name text);
 CREATE TABLE cam_tools(id uuid PRIMARY KEY, tool_type text);
 CREATE TABLE cam_machine_tools(machine_id uuid,tool_id uuid);
 CREATE TABLE cam_jobs(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, name text, source_type text, operation_type text, params jsonb, machine_id uuid, tool_id uuid, material_id uuid, part_id bigint, status text, requested_by uuid);
 `);
 await db.exec(migration('20260820_fusion_cam.sql'));
 await db.exec('ALTER TABLE fusion_parts ADD COLUMN fusion_file_name text');
 await db.exec(migration('20260906_fusion_grouping_integrity.sql'));
 await db.exec(migration('20260909_fusion_multi_tool_snapshot_check.sql'));
 await db.exec(migration('20260909_fusion_atomic_plate_queue.sql'));
 await db.exec(migration('20260909_fusion_atomic_plate_queue.sql'));
 await db.exec('GRANT USAGE ON SCHEMA public, auth TO authenticated; GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated');
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
 await db.exec(`RESET ROLE; TRUNCATE cam_jobs, cam_materials, cam_machines, cam_tools, cam_machine_tools, user_profiles CASCADE;
 SET test.approved='true'; SET test.uid='${id(100)}';
 INSERT INTO user_profiles VALUES ('${id(100)}','admin','lead',NULL,false);
 INSERT INTO cam_materials VALUES ('${id(50)}','Aluminum 6061');
 INSERT INTO fusion_part_categories(id,material_id,thickness) VALUES ('${id(1)}','${id(50)}',0.125),('${id(2)}','${id(50)}',0.25);
 INSERT INTO fusion_plates(id,name,width,length,true_depth,category_id) VALUES
 ('${id(10)}','Plate A',12,24,0.125,'${id(1)}'),('${id(11)}','Plate B',12,24,0.125,'${id(1)}');
 INSERT INTO fusion_parts(id,name,quantity,original_quantity,category_id,step_file_name) VALUES
 ('${id(20)}','Part A',5,5,'${id(1)}','a.step'),('${id(21)}','Part B',4,4,'${id(1)}','b.step');
 INSERT INTO cam_machines(id,enabled,name) VALUES ('${id(30)}',true,'New Router');
 INSERT INTO cam_tools VALUES ('${id(40)}','flat end mill');
 INSERT INTO cam_machine_tools VALUES ('${id(30)}','${id(40)}');`);
});

describe('Fusion grouping PostgreSQL migration', () => {
 it('applies insert, total-quantity upsert, retry, removal, and plate deletion exactly once', async () => {
   await assign(3); expect(await remaining()).toBe(2);
   await assign(3); expect(await remaining()).toBe(2);
   await assign(2); expect(await remaining()).toBe(3);
   await assign(3,11); expect(await remaining()).toBe(0);
   await run('DELETE FROM fusion_plates WHERE id=$1',[id(10)]); expect(await remaining()).toBe(2);
   await run('DELETE FROM fusion_part_category_assignments WHERE plate_id=$1',[id(11)]); expect(await remaining()).toBe(5);
 });
 it('rolls back an over-reservation and invalid stock without writing assignments', async () => {
   await assign(4);
   await expect(assign(2,11)).rejects.toThrow(/Insufficient/);
   await expect(assign(1,11,20,2)).rejects.toThrow(/same material/);
   await expect(assign(0,11)).rejects.toThrow(/positive/);
   expect(await remaining()).toBe(1);
   expect((await run('SELECT * FROM fusion_part_category_assignments')).rows).toHaveLength(1);
 });
 it('rolls back the assignment if an inventory write fails', async () => {
   await db.exec(`CREATE FUNCTION test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$;
     CREATE TRIGGER z_test_failure BEFORE UPDATE ON fusion_parts FOR EACH ROW EXECUTE FUNCTION test_failure();`);
   try { await expect(assign(3)).rejects.toThrow(/simulated failure/); }
   finally { await db.exec('DROP TRIGGER z_test_failure ON fusion_parts; DROP FUNCTION test_failure()'); }
   expect(await remaining()).toBe(5);
   expect((await run('SELECT * FROM fusion_part_category_assignments')).rows).toHaveLength(0);
 });
 it('cannot bypass inventory bookkeeping or change assigned stock', async () => {
   await expect(run('UPDATE fusion_parts SET quantity=4')).rejects.toThrow(/maintained/);
   await assign(2);
   await run('UPDATE fusion_parts SET original_quantity=8, quantity=6 WHERE id=$1', [id(20)]);
   expect((await run('SELECT quantity, original_quantity FROM fusion_parts WHERE id=$1', [id(20)])).rows[0]).toMatchObject({ quantity: 6, original_quantity: 8 });
   await expect(run('UPDATE fusion_parts SET original_quantity=9, quantity=6 WHERE id=$1', [id(20)])).rejects.toThrow(/preserve already nested/);
   await expect(run('UPDATE fusion_plates SET category_id=$1 WHERE id=$2',[id(2),id(10)])).rejects.toThrow(/Remove nested/);
   await expect(run('UPDATE fusion_parts SET category_id=$1',[id(2)])).rejects.toThrow(/immutable/);
 });
 it('rejects empty, missing-file, and invalid-machine queues', async () => {
   await expect(queue(null)).rejects.toThrow(/explicitly/);
   await expect(queue()).rejects.toThrow(/Nest at least/);
   await assign(2);
   await run('UPDATE fusion_parts SET step_file_name=NULL WHERE id=$1',[id(20)]);
   await expect(queue()).rejects.toThrow(/STEP file/);
   await run('UPDATE fusion_parts SET step_file_name=$1',['a.step']);
   await run('UPDATE cam_machines SET enabled=false');
   await expect(queue()).rejects.toThrow(/enabled plate machine/);
 });
 it('allows a null tool_id only when multiToolMode is set, but still requires a real enabled machine', async () => {
   // Real, confirmed live case: New Router's Auto multi-tool mode
   // deliberately sends tool_id=null (the planner resolves from every
   // loaded cutter server-side, not one manual selection) - this trigger's
   // machine/tool check predates that mode and required a real tool_id
   // match unconditionally, rejecting every multi-tool job at insert time
   // regardless of any application-layer fix.
   await assign(2);
   await expect(run(`INSERT INTO cam_jobs (operation_type,params,machine_id,tool_id,status) VALUES
     ('milling',$1,$2,NULL,'queued') RETURNING *`, [{
       fusionJobKind: 'plate:cam', plateId: id(10), fusionGroupingMode: 'single', selectedPartId: id(20), multiToolMode: true
     }, id(30)])).resolves.toBeTruthy();
   // Still requires the machine itself to be real and enabled - only the
   // specific tool_id match is skipped in multi-tool mode.
   await run('UPDATE cam_machines SET enabled=false');
   await expect(run(`INSERT INTO cam_jobs (operation_type,params,machine_id,tool_id,status) VALUES
     ('milling',$1,$2,NULL,'queued') RETURNING *`, [{
       fusionJobKind: 'plate:cam', plateId: id(10), fusionGroupingMode: 'single', selectedPartId: id(20), multiToolMode: true
     }, id(30)])).rejects.toThrow(/enabled plate machine/);
 });
 it('atomically replaces the shared plate assignments and snapshots exactly that queued selection', async () => {
   await assign(1);
   const result = await run(`SELECT (public.queue_fusion_plate_job(
     $1, $2, $3, $4, $5, NULL, NULL, NULL, NULL, 'grouped', false, false
   )).*`, [id(10), [{ partId: id(20), quantity: 2 }, { partId: id(21), quantity: 3 }], id(30), id(40), 'Grouped job']);
   expect(result.rows).toHaveLength(1);
   const assignments = (await run('SELECT part_id,quantity FROM fusion_part_category_assignments WHERE plate_id=$1 ORDER BY part_id',[id(10)])).rows;
   expect(assignments).toEqual([{ part_id: id(20), quantity: 2 }, { part_id: id(21), quantity: 3 }]);
   expect(result.rows[0].params.fusionPlateSnapshot.assignments).toEqual([
     expect.objectContaining({ part_id: id(20), quantity: 2 }),
     expect.objectContaining({ part_id: id(21), quantity: 3 })
   ]);
 });
 it('attributes browser-queued jobs to the authenticated caller, not a supplied user id', async () => {
   await db.exec('SET ROLE authenticated');
   const result = await run(`SELECT (public.queue_fusion_plate_job(
     $1, $2, $3, $4, $5, $6, NULL, NULL, NULL, 'single', false, false
   )).*`, [id(10), [{ partId: id(20), quantity: 1 }], id(30), id(40), 'Owned job', id(999)]);
   expect(result.rows[0].requested_by).toBe(id(100));
   await db.exec('RESET ROLE');
 });
 it('rolls back every assignment change when the atomic job insert fails', async () => {
   await assign(2);
   await expect(run(`SELECT public.queue_fusion_plate_job(
     $1, $2, $3, $4, $5, NULL, NULL, NULL, NULL, 'single', false, false
   )`, [id(10), [{ partId: id(21), quantity: 3 }], id(31), id(40), 'Invalid machine'])).rejects.toThrow(/enabled plate machine/);
   expect((await run('SELECT part_id,quantity FROM fusion_part_category_assignments WHERE plate_id=$1',[id(10)])).rows)
     .toEqual([{ part_id: id(20), quantity: 2 }]);
   expect((await run('SELECT * FROM cam_jobs')).rows).toHaveLength(0);
 });
 it('rejects an atomic queue quantity above the part request without changing the nest', async () => {
   await assign(2);
   await expect(run(`SELECT public.queue_fusion_plate_job(
     $1, $2, $3, $4, $5, NULL, NULL, NULL, NULL, 'single', false, false
   )`, [id(10), [{ partId: id(20), quantity: 6 }], id(30), id(40), 'Too many'])).rejects.toThrow(/not exceed/);
   expect((await run('SELECT part_id,quantity FROM fusion_part_category_assignments WHERE plate_id=$1',[id(10)])).rows)
     .toEqual([{ part_id: id(20), quantity: 2 }]);
 });
 it('enforces New Router and Aluminum 6061 for automatic tool swaps in the database', async () => {
   await assign(2);
   await run("UPDATE cam_materials SET name='SRPP' WHERE id=$1", [id(50)]);
   await expect(run(`INSERT INTO cam_jobs (operation_type,params,machine_id,tool_id,status) VALUES
     ('milling',$1,$2,NULL,'queued')`, [{
       fusionJobKind:'plate:cam', plateId:id(10), fusionGroupingMode:'single', selectedPartId:id(20), multiToolMode:true
     }, id(30)])).rejects.toThrow(/only for Aluminum 6061/);
   await run("UPDATE cam_materials SET name='Aluminum 6061' WHERE id=$1", [id(50)]);
   await run("UPDATE cam_machines SET name='UNC Router' WHERE id=$1", [id(30)]);
   await expect(run(`INSERT INTO cam_jobs (operation_type,params,machine_id,tool_id,status) VALUES
     ('milling',$1,$2,NULL,'queued')`, [{
       fusionJobKind:'plate:cam', plateId:id(10), fusionGroupingMode:'single', selectedPartId:id(20), multiToolMode:true
     }, id(30)])).rejects.toThrow(/only on New Router/);
 });
 it('rejects invalid tube machines, materials, and cutter types in the database', async () => {
   await expect(run(`INSERT INTO cam_jobs(operation_type,params,machine_id,tool_id,material_id,status)
     VALUES ('milling',$1,$2,$3,$4,'queued')`, [
       { fusionJobKind:'box_tube', boxTubeId:id(60), singleToolMode:true }, id(30), id(40), id(50)
     ])).rejects.toThrow(/enabled tube machine/);
   await run('UPDATE cam_machines SET can_run_box_tubes=true WHERE id=$1',[id(30)]);
   await run("UPDATE cam_materials SET name='SRPP' WHERE id=$1",[id(50)]);
   await expect(run(`INSERT INTO cam_jobs(operation_type,params,machine_id,tool_id,material_id,status)
     VALUES ('milling',$1,$2,$3,$4,'queued')`, [
       { fusionJobKind:'box_tube', boxTubeId:id(60), singleToolMode:true }, id(30), id(40), id(50)
     ])).rejects.toThrow(/aluminum material/);
   await run("UPDATE cam_materials SET name='Aluminum 6061' WHERE id=$1",[id(50)]);
   await run("UPDATE cam_tools SET tool_type='drill' WHERE id=$1",[id(40)]);
   await expect(run(`INSERT INTO cam_jobs(operation_type,params,machine_id,tool_id,material_id,status)
     VALUES ('milling',$1,$2,$3,$4,'queued')`, [
       { fusionJobKind:'box_tube', boxTubeId:id(60), singleToolMode:true }, id(30), id(40), id(50)
     ])).rejects.toThrow(/requires an endmill/);
 });
 it('finds historical plate jobs through immutable snapshots after the live nest changes', async () => {
   await assign(2);
   const job = (await queue('single', id(20))).rows[0];
   await run('DELETE FROM fusion_part_category_assignments WHERE plate_id=$1',[id(10)]);
   const links = await run('SELECT * FROM public.fusion_plate_job_links($1)', [[id(20)]]);
   expect(links.rows).toEqual([{ fusion_part_id: id(20), job_id: job.id }]);
 });
 it('captures every assignment and protects queued inputs from later edits', async () => {
   await assign(2); await assign(3,10,21);
   const job = (await queue()).rows[0];
   expect(job.params.fusionPlateSnapshot.assignments.map(p=>p.quantity)).toEqual([2,3]);
   await assign(1);
   await run('UPDATE fusion_plates SET width=18 WHERE id=$1',[id(10)]);
   const saved = (await run('SELECT params FROM cam_jobs WHERE id=$1',[job.id])).rows[0].params;
   expect(saved.fusionPlateSnapshot.width).toBe(12);
   expect(saved.fusionPlateSnapshot.assignments[0].quantity).toBe(2);
   await expect(run("UPDATE cam_jobs SET params='{}' WHERE id=$1",[job.id])).rejects.toThrow(/immutable/);
   await run("UPDATE cam_jobs SET status='completed' WHERE id=$1",[job.id]);
 });
 it('keeps single-part and grouped plate snapshots unambiguous', async () => {
   await assign(2); await assign(3,10,21);
   const single = (await queue('single', id(21))).rows[0];
   expect(single.params.fusionPlateSnapshot.grouping_mode).toBe('single');
   expect(single.params.fusionPlateSnapshot.assignments).toEqual([
     expect.objectContaining({ part_id: id(21), name: 'Part B', quantity: 3 })
   ]);
   await expect(queue('single', id(99))).rejects.toThrow(/Nest at least/);
   const grouped = (await queue()).rows[0];
   expect(grouped.params.fusionPlateSnapshot.grouping_mode).toBe('grouped');
   expect(grouped.params.fusionPlateSnapshot.assignments).toHaveLength(2);
   await run(`INSERT INTO fusion_parts(id,name,quantity,original_quantity,category_id,step_file_name)
     VALUES ($1,'Part C',2,2,$2,'c.step')`, [id(22), id(1)]);
   await assign(1,10,22);
   const subset = (await queue('grouped', null, [id(20), id(22)])).rows[0];
   expect(subset.params.fusionPlateSnapshot.assignments.map((part) => part.part_id)).toEqual([id(20), id(22)]);
   await expect(queue('grouped', id(20))).rejects.toThrow(/selected part list/);
   await expect(queue('grouped', null, [id(20), id(99)])).rejects.toThrow(/must be nested/);
   await expect(queue('grouped', null, [id(20), id(20)])).rejects.toThrow(/distinct/);
 });
 it('enforces read approval and manager writes in database policies', async () => {
   await db.exec("SET ROLE authenticated");
   await assign(1); // manager succeeds, including trigger-driven inventory update
   await db.exec('RESET ROLE');
   await run("UPDATE user_profiles SET role='member', general_role='member'");
   await db.exec('SET ROLE authenticated');
   expect((await run('SELECT * FROM fusion_parts')).rows).toHaveLength(2);
   await expect(assign(2)).rejects.toThrow(/row-level security/);
   await db.exec("SET test.approved='false'");
   expect((await run('SELECT * FROM fusion_parts')).rows).toHaveLength(0);
   await expect(assign(2)).rejects.toThrow(/row-level security/);
 });
});
