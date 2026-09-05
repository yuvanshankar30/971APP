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
const queue = () => run(`INSERT INTO cam_jobs (operation_type,params,machine_id,tool_id,status) VALUES
 ('milling',$1,$2,$3,'queued') RETURNING *`, [{fusionJobKind:'plate:cam',plateId:id(10)}, id(30), id(40)]);

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
 CREATE TABLE cam_machines(id uuid PRIMARY KEY, enabled boolean);
 CREATE TABLE cam_machine_tools(machine_id uuid,tool_id uuid);
 CREATE TABLE cam_jobs(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, operation_type text, params jsonb, machine_id uuid, tool_id uuid, material_id uuid, part_id bigint, status text);
 `);
 await db.exec(migration('20260820_fusion_cam.sql'));
 await db.exec('ALTER TABLE fusion_parts ADD COLUMN fusion_file_name text');
 await db.exec(migration('20260906_fusion_grouping_integrity.sql'));
 await db.exec('GRANT USAGE ON SCHEMA public, auth TO authenticated; GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated');
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
 await db.exec(`RESET ROLE; TRUNCATE cam_jobs, cam_materials, cam_machines, cam_machine_tools, user_profiles CASCADE;
 SET test.approved='true'; SET test.uid='${id(100)}';
 INSERT INTO user_profiles VALUES ('${id(100)}','admin','lead',NULL,false);
 INSERT INTO cam_materials VALUES ('${id(50)}','Aluminum');
 INSERT INTO fusion_part_categories(id,material_id,thickness) VALUES ('${id(1)}','${id(50)}',0.125),('${id(2)}','${id(50)}',0.25);
 INSERT INTO fusion_plates(id,name,width,length,true_depth,category_id) VALUES
 ('${id(10)}','Plate A',12,24,0.125,'${id(1)}'),('${id(11)}','Plate B',12,24,0.125,'${id(1)}');
 INSERT INTO fusion_parts(id,name,quantity,original_quantity,category_id,step_file_name) VALUES
 ('${id(20)}','Part A',5,5,'${id(1)}','a.step'),('${id(21)}','Part B',4,4,'${id(1)}','b.step');
 INSERT INTO cam_machines(id,enabled) VALUES ('${id(30)}',true);
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
   await expect(run('UPDATE fusion_plates SET category_id=$1 WHERE id=$2',[id(2),id(10)])).rejects.toThrow(/Remove nested/);
   await expect(run('UPDATE fusion_parts SET category_id=$1',[id(2)])).rejects.toThrow(/immutable/);
 });
 it('rejects empty, missing-file, and invalid-machine queues', async () => {
   await expect(queue()).rejects.toThrow(/Nest at least/);
   await assign(2);
   await run('UPDATE fusion_parts SET step_file_name=NULL WHERE id=$1',[id(20)]);
   await expect(queue()).rejects.toThrow(/STEP file/);
   await run('UPDATE fusion_parts SET step_file_name=$1',['a.step']);
   await run('UPDATE cam_machines SET enabled=false');
   await expect(queue()).rejects.toThrow(/enabled plate machine/);
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
