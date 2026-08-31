

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."approved_user"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(
    (
      SELECT (up.role = 'admin')
             OR (COALESCE(up.permissions, '{}'::text[]) @> ARRAY['CAN_SEE_ROUTES'])
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    ),
    FALSE
  );
$$;


ALTER FUNCTION "public"."approved_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_runtime_lease"("lease_key" "text", "lease_seconds" integer DEFAULT 120, "min_interval_seconds" integer DEFAULT 0) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  row_count integer := 0;
BEGIN
  INSERT INTO public.runtime_leases (key, lease_expires_at, last_started_at)
  VALUES (
    lease_key,
    now() + make_interval(secs => GREATEST(1, lease_seconds)),
    now()
  )
  ON CONFLICT (key) DO UPDATE
    SET lease_expires_at = EXCLUDED.lease_expires_at,
        last_started_at = EXCLUDED.last_started_at
    WHERE
      (runtime_leases.lease_expires_at IS NULL OR runtime_leases.lease_expires_at < now())
      AND (
        min_interval_seconds <= 0
        OR runtime_leases.last_finished_at IS NULL
        OR runtime_leases.last_finished_at < now() - make_interval(secs => min_interval_seconds)
      );

  GET DIAGNOSTICS row_count = ROW_COUNT;
  RETURN row_count > 0;
END;
$$;


ALTER FUNCTION "public"."claim_runtime_lease"("lease_key" "text", "lease_seconds" integer, "min_interval_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cots_stock_items_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."cots_stock_items_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cots_stock_locations_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."cots_stock_locations_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.user_profiles (id, email, full_name, general_role, purchasing_role)
  VALUES (
    new.id, 
    new.email, 
    COALESCE(new.raw_user_meta_data->>'name', new.email),
    'none',    -- Start as pending approval
    'basic'    -- Default purchasing role
  );
  RETURN new;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_any_permission"("required" "text"[]) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(
    (
      SELECT (up.role = 'admin')
             OR (required IS NOT NULL AND COALESCE(up.permissions, '{}'::text[]) && required)
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    ),
    FALSE
  );
$$;


ALTER FUNCTION "public"."has_any_permission"("required" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_permission"("required" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(
    (
      SELECT (up.role = 'admin')
             OR (COALESCE(up.permissions, '{}'::text[]) @> ARRAY[required])
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    ),
    FALSE
  );
$$;


ALTER FUNCTION "public"."has_permission"("required" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."invoke_planner_notification_cron"() RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
DECLARE
  app_url text;
  cron_token text;
  request_id bigint;
BEGIN
  SELECT decrypted_secret
  INTO app_url
  FROM vault.decrypted_secrets
  WHERE name = 'planner_notifications_app_url'
  ORDER BY created_at DESC
  LIMIT 1;

  SELECT decrypted_secret
  INTO cron_token
  FROM vault.decrypted_secrets
  WHERE name = 'planner_notifications_cron_token'
  ORDER BY created_at DESC
  LIMIT 1;

  app_url := regexp_replace(COALESCE(trim(app_url), ''), '/+$', '');
  cron_token := trim(COALESCE(cron_token, ''));

  IF app_url = '' OR cron_token = '' THEN
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url := app_url || '/api/planner/notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cron_token
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  )
  INTO request_id;

  RETURN request_id;
END;
$_$;


ALTER FUNCTION "public"."invoke_planner_notification_cron"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."invoke_planner_notification_cron"() IS 'Calls the planner notification endpoint using Vault secrets planner_notifications_app_url and planner_notifications_cron_token.';



CREATE OR REPLACE FUNCTION "public"."log_user_attendance"("p_user_id" "uuid", "p_external_ip" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_location_id uuid;
  v_schedule_id uuid;
  v_now timestamptz := now();
  v_current_time time := v_now::time;
  v_current_day int := EXTRACT(DOW FROM v_now)::int;
  v_today_date date := v_now::date;
  v_existing_count int;
BEGIN
  -- Validate input
  IF p_user_id IS NULL OR p_external_ip IS NULL OR p_external_ip = '' THEN
    RETURN false;
  END IF;

  -- Find matching active schedule and location based on:
  -- 1. Current day of week
  -- 2. Current time within schedule window
  -- 3. Network prefix match (text equality)
  -- 4. Both schedule and location are active
  SELECT 
    asl.location_id,
    asl.schedule_id
  INTO 
    v_location_id,
    v_schedule_id
  FROM public.attendance_schedule_locations asl
  INNER JOIN public.attendance_schedules asched 
    ON asl.schedule_id = asched.id
  INNER JOIN public.attendance_locations aloc 
    ON asl.location_id = aloc.id
  WHERE 
    asched.active = true
    AND aloc.active = true
    AND asched.day_of_week = v_current_day
    AND v_current_time >= asched.start_time
    AND v_current_time <= asched.end_time
    AND aloc.network_cidr = p_external_ip  -- Simple text equality match
  LIMIT 1;

  -- If no matching schedule/location found, return false
  IF v_location_id IS NULL OR v_schedule_id IS NULL THEN
    RETURN false;
  END IF;

  -- Check if user already has attendance logged today for this location
  SELECT COUNT(*)
  INTO v_existing_count
  FROM public.user_attendance_logs
  WHERE 
    user_id = p_user_id
    AND location_id = v_location_id
    AND recorded_at::date = v_today_date;

  -- If already logged today at this location, don't log again
  IF v_existing_count > 0 THEN
    RETURN false;
  END IF;

  -- Log the attendance
  INSERT INTO public.user_attendance_logs (
    user_id,
    location_id,
    schedule_id,
    recorded_at
  ) VALUES (
    p_user_id,
    v_location_id,
    v_schedule_id,
    v_now
  );

  RETURN true;
END;
$$;


ALTER FUNCTION "public"."log_user_attendance"("p_user_id" "uuid", "p_external_ip" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."log_user_attendance"("p_user_id" "uuid", "p_external_ip" "text") IS 'Logs user attendance based on three-octet network prefix matching. 
The p_external_ip parameter should be a three-octet prefix (e.g., "205.167.46") 
for IPv4 or four-hextet prefix for IPv6. This provides privacy by not storing 
or matching full IP addresses.';



CREATE OR REPLACE FUNCTION "public"."planner_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."planner_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_runtime_lease"("lease_key" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  row_count integer := 0;
BEGIN
  UPDATE public.runtime_leases
  SET lease_expires_at = NULL,
      last_finished_at = now()
  WHERE key = lease_key;

  GET DIAGNOSTICS row_count = ROW_COUNT;
  RETURN row_count > 0;
END;
$$;


ALTER FUNCTION "public"."release_runtime_lease"("lease_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."router_groups_set_name"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.name IS NULL OR NEW.name = '' THEN
    NEW.name := concat_ws('_', NEW.stock_type, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."router_groups_set_name"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_onshape_file_format"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    IF NEW.is_onshape_part = true AND NEW.file_format IS NULL THEN
        CASE NEW.workflow
            WHEN '3d-print' THEN
                NEW.file_format := 'stl';
            WHEN 'router' THEN
                NEW.file_format := 'parasolid';
            WHEN 'laser-cut' THEN
                NEW.file_format := 'parasolid';
            WHEN 'mill' THEN
                NEW.file_format := 'parasolid';
            WHEN 'lathe' THEN
                NEW.file_format := 'parasolid';
            ELSE
                NEW.file_format := 'step'; -- Default fallback
        END CASE;
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_onshape_file_format"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_purchasing_budget_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_purchasing_budget_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tasks_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."tasks_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."user_attendance_logs" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "location_id" bigint,
    "schedule_id" bigint,
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ip_address" "inet" NOT NULL,
    "notes" "text"
);


ALTER TABLE "public"."user_attendance_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_profiles" (
    "id" "uuid" NOT NULL,
    "email" character varying(255),
    "full_name" character varying(255),
    "role" character varying(100) DEFAULT 'member'::character varying,
    "permissions" "text"[],
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "banned" boolean DEFAULT false,
    "header_tabs" "jsonb",
    "dashboard_layout" "text" DEFAULT 'grid'::"text",
    "general_role" "text" DEFAULT 'member'::"text",
    "purchasing_role" "text" DEFAULT 'basic'::"text",
    "team_role" "text" DEFAULT 'other'::"text",
    "notification_settings" "jsonb" DEFAULT '{}'::"jsonb",
    "slack_user_id" "text",
    "slack_dm_channel" "text",
    "frc_team" "text",
    "task_general_categories" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    CONSTRAINT "user_profiles_frc_team_check" CHECK ((("frc_team" IS NULL) OR ("frc_team" = ANY (ARRAY['971'::"text", '9584'::"text", 'Mentor'::"text"])))),
    CONSTRAINT "user_profiles_task_general_categories_check" CHECK (("task_general_categories" <@ ARRAY['CAD'::"text", 'Mechanical'::"text", 'Electrical'::"text", 'Software'::"text", 'Other'::"text"]))
);


ALTER TABLE "public"."user_profiles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."user_profiles"."frc_team" IS 'FRC team affiliation: 971, 9584, or Mentor';



CREATE OR REPLACE VIEW "public"."attendance_leaderboard_30_days" AS
 SELECT "up"."id" AS "user_id",
    "up"."full_name",
    "up"."email",
    "count"(DISTINCT ("timezone"('America/Los_Angeles'::"text", "logs"."recorded_at"))::"date") AS "days_attended",
    "count"("logs"."id") AS "total_check_ins",
    "max"("logs"."recorded_at") AS "last_attended_at"
   FROM ("public"."user_profiles" "up"
     LEFT JOIN "public"."user_attendance_logs" "logs" ON ((("logs"."user_id" = "up"."id") AND ("logs"."recorded_at" >= ("now"() - '30 days'::interval)))))
  WHERE (COALESCE("up"."banned", false) = false)
  GROUP BY "up"."id", "up"."full_name", "up"."email";


ALTER TABLE "public"."attendance_leaderboard_30_days" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."attendance_locations" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "network_cidr" "text" NOT NULL,
    "description" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."attendance_locations" OWNER TO "postgres";


COMMENT ON COLUMN "public"."attendance_locations"."network_cidr" IS 'Network prefix for location matching. Should be three octets for IPv4 (e.g., "205.167.46") 
or four hextets for IPv6 (e.g., "2001:db8:1234:5678"). Despite the column name, 
this is NOT CIDR notation - it is a simple text prefix for privacy-focused matching.';



CREATE SEQUENCE IF NOT EXISTS "public"."attendance_locations_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE "public"."attendance_locations_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."attendance_locations_id_seq" OWNED BY "public"."attendance_locations"."id";



CREATE TABLE IF NOT EXISTS "public"."attendance_schedule_locations" (
    "schedule_id" bigint NOT NULL,
    "location_id" bigint NOT NULL
);


ALTER TABLE "public"."attendance_schedule_locations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."attendance_schedules" (
    "id" bigint NOT NULL,
    "label" "text" NOT NULL,
    "day_of_week" smallint NOT NULL,
    "start_time" time without time zone NOT NULL,
    "end_time" time without time zone NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "attendance_schedules_check" CHECK (("end_time" > "start_time")),
    CONSTRAINT "attendance_schedules_day_of_week_check" CHECK ((("day_of_week" >= 0) AND ("day_of_week" <= 6)))
);


ALTER TABLE "public"."attendance_schedules" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."attendance_schedules_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE "public"."attendance_schedules_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."attendance_schedules_id_seq" OWNED BY "public"."attendance_schedules"."id";



CREATE TABLE IF NOT EXISTS "public"."build_bom" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "build_id" "uuid" NOT NULL,
    "part_name" character varying NOT NULL,
    "part_number" character varying,
    "quantity" integer DEFAULT 1 NOT NULL,
    "part_type" character varying NOT NULL,
    "material" character varying,
    "stock_assignment" character varying,
    "workflow" character varying,
    "bounding_box_x" numeric,
    "bounding_box_y" numeric,
    "bounding_box_z" numeric,
    "onshape_part_id" character varying,
    "status" character varying DEFAULT 'pending'::character varying,
    "onshape_document_id" character varying,
    "onshape_wvm" character varying,
    "onshape_wvmid" character varying,
    "onshape_element_id" character varying,
    "file_format" character varying,
    "is_onshape_part" boolean DEFAULT false,
    "file_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "stock_assignment_custom" "text",
    "added" boolean DEFAULT false,
    "parts_id" bigint,
    "purchasing_id" bigint,
    "kitting_id" bigint,
    CONSTRAINT "build_bom_file_format_check" CHECK ((("file_format")::"text" = ANY (ARRAY[('stl'::character varying)::"text", ('parasolid'::character varying)::"text", ('step'::character varying)::"text", ('iges'::character varying)::"text"]))),
    CONSTRAINT "build_bom_part_type_check" CHECK ((("part_type")::"text" = ANY (ARRAY[('COTS'::character varying)::"text", ('manufactured'::character varying)::"text", ('other'::character varying)::"text"]))),
    CONSTRAINT "build_bom_single_relation" CHECK (((("parts_id" IS NOT NULL) AND ("purchasing_id" IS NULL) AND ("kitting_id" IS NULL)) OR (("parts_id" IS NULL) AND ("purchasing_id" IS NOT NULL) AND ("kitting_id" IS NULL)) OR (("parts_id" IS NULL) AND ("purchasing_id" IS NULL) AND ("kitting_id" IS NOT NULL)) OR (("parts_id" IS NULL) AND ("purchasing_id" IS NULL) AND ("kitting_id" IS NULL)))),
    CONSTRAINT "build_bom_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('pending'::character varying)::"text", ('ordered'::character varying)::"text", ('delivered'::character varying)::"text", ('manufactured'::character varying)::"text", ('in-progress'::character varying)::"text", ('cammed'::character varying)::"text", ('complete'::character varying)::"text"])))
);


ALTER TABLE "public"."build_bom" OWNER TO "postgres";


COMMENT ON COLUMN "public"."build_bom"."added" IS 'Whether this BOM item was selected for inclusion in the build';



COMMENT ON COLUMN "public"."build_bom"."parts_id" IS 'Reference to the parts table entry (created immediately when build is created)';



COMMENT ON COLUMN "public"."build_bom"."purchasing_id" IS 'Reference to the purchasing table entry (created immediately when build is created)';



COMMENT ON COLUMN "public"."build_bom"."kitting_id" IS 'Reference to the kitting table entry (created immediately when build is created)';



CREATE TABLE IF NOT EXISTS "public"."builds" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subsystem_id" "uuid",
    "release_id" character varying(255) NOT NULL,
    "release_name" character varying(255) NOT NULL,
    "build_hash" character varying(64) NOT NULL,
    "status" character varying(50) DEFAULT 'pending'::character varying,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "assembled_at" timestamp with time zone,
    "assembled_by" "uuid",
    "project_id" "text",
    "frc_team" "text",
    "quantity" integer DEFAULT 1 NOT NULL,
    CONSTRAINT "builds_frc_team_check" CHECK ((("frc_team" IS NULL) OR ("frc_team" = ANY (ARRAY['971'::"text", '9584'::"text", 'Mentor'::"text"])))),
    CONSTRAINT "builds_quantity_check" CHECK (("quantity" > 0)),
    CONSTRAINT "builds_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('pending'::character varying)::"text", ('manufacturing'::character varying)::"text", ('ready_to_assemble'::character varying)::"text", ('assembled'::character varying)::"text"])))
);


ALTER TABLE "public"."builds" OWNER TO "postgres";


COMMENT ON COLUMN "public"."builds"."frc_team" IS 'Originating FRC team (971, 9584, Mentor) based on the student who created the build.';



CREATE TABLE IF NOT EXISTS "public"."cots_stock_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "canonical_name" "text" NOT NULL,
    "canonical_key" "text" NOT NULL,
    "quantity" integer DEFAULT 0 NOT NULL,
    "aliases" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "item_category" "text",
    "track_mode" "text" DEFAULT 'count'::"text" NOT NULL,
    CONSTRAINT "cots_stock_items_quantity_check" CHECK (("quantity" >= 0)),
    CONSTRAINT "cots_stock_items_track_mode_check" CHECK (("track_mode" = ANY (ARRAY['count'::"text", 'level'::"text"])))
);


ALTER TABLE "public"."cots_stock_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cots_stock_locations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "item_id" "uuid" NOT NULL,
    "section" "text",
    "drawer" "text",
    "subsection" "text",
    "quantity" integer,
    "stock_level" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cots_stock_locations_quantity_check" CHECK ((("quantity" IS NULL) OR ("quantity" >= 0))),
    CONSTRAINT "cots_stock_locations_stock_level_check" CHECK ((("stock_level" IS NULL) OR ("stock_level" = ANY (ARRAY['low'::"text", 'mid'::"text", 'lots'::"text"])))),
    CONSTRAINT "cots_stock_locations_track_check" CHECK (((("quantity" IS NOT NULL) AND ("stock_level" IS NULL)) OR (("quantity" IS NULL) AND ("stock_level" IS NOT NULL))))
);


ALTER TABLE "public"."cots_stock_locations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."kitting" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "requester" "text" NOT NULL,
    "project_id" "text" NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "material" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "workflow" "text" DEFAULT 'kit'::"text" NOT NULL,
    "kitting_bin" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "kitting_quantity_check" CHECK (("quantity" > 0)),
    CONSTRAINT "kitting_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'kitted'::"text"]))),
    CONSTRAINT "kitting_workflow_check" CHECK (("workflow" = 'kit'::"text"))
);


ALTER TABLE "public"."kitting" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."kitting_bins" (
    "bin_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."kitting_bins" OWNER TO "postgres";


ALTER TABLE "public"."kitting" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."kitting_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" bigint NOT NULL,
    "order_number" "text" NOT NULL,
    "vendor" "text",
    "total_items" integer DEFAULT 0 NOT NULL,
    "total_cost" numeric DEFAULT 0 NOT NULL,
    "shipping_cost" numeric DEFAULT 0 NOT NULL,
    "placed_by" "uuid",
    "placed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "notes" "text",
    "order_total" numeric DEFAULT 0 NOT NULL,
    "delivery_date" "date"
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


ALTER TABLE "public"."orders" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."orders_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."parts" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "requester" "text" NOT NULL,
    "project_id" "text" NOT NULL,
    "workflow" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "file_name" "text" NOT NULL,
    "file_url" "text" NOT NULL,
    "kitting_bin" "text",
    "delivered" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "material" "text" DEFAULT ''::"text" NOT NULL,
    "gcode_file_name" "text",
    "gcode_file_url" "text",
    "onshape_document_id" character varying,
    "onshape_wvm" character varying,
    "onshape_wvmid" character varying,
    "onshape_element_id" character varying,
    "onshape_part_id" character varying,
    "file_format" character varying,
    "is_onshape_part" boolean DEFAULT false,
    "cut_date" timestamp with time zone,
    "layout_x" numeric,
    "layout_y" numeric,
    "layout_rotation" numeric DEFAULT 0,
    "onshape_drawing_element_id" character varying,
    "stock_assignment" "text",
    "assigned_to" "uuid",
    "frc_team" "text",
    "router_step" "text",
    "router_travis_progged" boolean DEFAULT false,
    "router_group_id" "uuid",
    "router_group_name" "text",
    "preview_image_url" "text",
    "preview_image_updated_at" timestamp with time zone,
    CONSTRAINT "parts_file_format_check" CHECK ((("file_format")::"text" = ANY (ARRAY[('stl'::character varying)::"text", ('parasolid'::character varying)::"text", ('step'::character varying)::"text", ('iges'::character varying)::"text"]))),
    CONSTRAINT "parts_frc_team_check" CHECK ((("frc_team" IS NULL) OR ("frc_team" = ANY (ARRAY['971'::"text", '9584'::"text", 'Mentor'::"text"])))),
    CONSTRAINT "parts_quantity_check" CHECK (("quantity" > 0)),
    CONSTRAINT "parts_router_step_check" CHECK (("router_step" = ANY (ARRAY['cam_ing'::"text", 'cam_review'::"text", 'cammed'::"text", 'queued'::"text", 'layout'::"text", 'cut'::"text"]))),
    CONSTRAINT "parts_workflow_check" CHECK (("workflow" = ANY (ARRAY['laser-cut'::"text", 'router'::"text", 'lathe'::"text", 'mill'::"text", '3d-print'::"text", 'purchase'::"text"])))
);


ALTER TABLE "public"."parts" OWNER TO "postgres";


COMMENT ON COLUMN "public"."parts"."status" IS 'Part manufacturing status: pending -> in-progress -> cammed (router only) -> machined -> inspected -> deburred (router only) -> complete';



COMMENT ON COLUMN "public"."parts"."gcode_file_name" IS 'G-code filename for router workflow (after CAM processing)';



COMMENT ON COLUMN "public"."parts"."gcode_file_url" IS 'G-code file URL in storage for router workflow';



COMMENT ON COLUMN "public"."parts"."onshape_document_id" IS 'Onshape document ID for on-demand file retrieval';



COMMENT ON COLUMN "public"."parts"."onshape_wvm" IS 'Onshape workspace/version/microversion type (w/v/m)';



COMMENT ON COLUMN "public"."parts"."onshape_wvmid" IS 'Onshape workspace/version/microversion ID - CRITICAL for version consistency';



COMMENT ON COLUMN "public"."parts"."onshape_element_id" IS 'Onshape element ID containing the part';



COMMENT ON COLUMN "public"."parts"."onshape_part_id" IS 'Onshape part ID for the specific part';



COMMENT ON COLUMN "public"."parts"."file_format" IS 'File format to request from Onshape API (stl for 3D printing, parasolid for router)';



COMMENT ON COLUMN "public"."parts"."is_onshape_part" IS 'True if this part should be downloaded via Onshape API, false if using storage bucket';



COMMENT ON COLUMN "public"."parts"."onshape_drawing_element_id" IS 'Onshape Drawing element ID (24-char hex) used to translate to PDF for lathe/mill workflows';



COMMENT ON COLUMN "public"."parts"."frc_team" IS 'FRC team of the student who requested the part.';



CREATE SEQUENCE IF NOT EXISTS "public"."parts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE "public"."parts_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."parts_id_seq" OWNED BY "public"."parts"."id";



CREATE TABLE IF NOT EXISTS "public"."pit_scout_entries" (
    "id" bigint NOT NULL,
    "event_key" "text" NOT NULL,
    "team_key" "text" NOT NULL,
    "drivebase_type" "text",
    "shooter_type" "text",
    "hopper_type" "text",
    "human_player_balls_in_auto" "text",
    "scout_name" "text",
    "photo_paths" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "auto_options" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "likely_breaking_component" "text",
    "estimated_bps" numeric,
    "climb_options" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    CONSTRAINT "pit_scout_entries_auto_options_array_check" CHECK (("jsonb_typeof"("auto_options") = 'array'::"text")),
    CONSTRAINT "pit_scout_entries_climb_options_check" CHECK (((COALESCE("array_length"("climb_options", 1), 0) <= 5) AND ("climb_options" <@ ARRAY['No Climb'::"text", 'L1 Auto'::"text", 'L1'::"text", 'L2'::"text", 'L3'::"text"]) AND ((NOT ('No Climb'::"text" = ANY ("climb_options"))) OR (COALESCE("array_length"("climb_options", 1), 0) = 1)))),
    CONSTRAINT "pit_scout_entries_drivebase_check" CHECK ((("drivebase_type" IS NULL) OR ("drivebase_type" = ANY (ARRAY['Mechanum'::"text", 'Swerve'::"text", 'Tank'::"text"])))),
    CONSTRAINT "pit_scout_entries_estimated_bps_nonnegative_check" CHECK ((("estimated_bps" IS NULL) OR ("estimated_bps" >= (0)::numeric))),
    CONSTRAINT "pit_scout_entries_hopper_check" CHECK ((("hopper_type" IS NULL) OR ("hopper_type" = ANY (ARRAY['Spindexer'::"text", 'Dye Rotor'::"text", 'Belted'::"text"])))),
    CONSTRAINT "pit_scout_entries_human_player_balls_check" CHECK ((("human_player_balls_in_auto" IS NULL) OR ("human_player_balls_in_auto" = ANY (ARRAY['0-10'::"text", '10-20'::"text", '20+'::"text"])))),
    CONSTRAINT "pit_scout_entries_photo_limit_check" CHECK ((COALESCE("array_length"("photo_paths", 1), 0) <= 3)),
    CONSTRAINT "pit_scout_entries_shooter_check" CHECK ((("shooter_type" IS NULL) OR ("shooter_type" = ANY (ARRAY['Single Fixed'::"text", 'Multi Fixed'::"text", 'Wide'::"text", 'Turret'::"text", 'Double Turret'::"text"])))),
    CONSTRAINT "pit_scout_entries_scout_name_length_check" CHECK ((("scout_name" IS NULL) OR (char_length("scout_name") <= 120)))
);


ALTER TABLE "public"."pit_scout_entries" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."pit_scout_entries_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE "public"."pit_scout_entries_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."pit_scout_entries_id_seq" OWNED BY "public"."pit_scout_entries"."id";



CREATE TABLE IF NOT EXISTS "public"."planner_calendar_rule_recipients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "frc_team" "text" NOT NULL,
    "planner_calendar_rule_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "planner_calendar_rule_recipients_frc_team_check" CHECK (("frc_team" = ANY (ARRAY['971'::"text", '9584'::"text"])))
);


ALTER TABLE "public"."planner_calendar_rule_recipients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."planner_calendar_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "frc_team" "text" NOT NULL,
    "rule_type" "text" NOT NULL,
    "label" "text" NOT NULL,
    "weekday" integer,
    "specific_date" "date",
    "starts_at" time without time zone NOT NULL,
    "ends_at" time without time zone NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "planner_calendar_rules_check" CHECK ((("weekday" IS NOT NULL) OR ("specific_date" IS NOT NULL))),
    CONSTRAINT "planner_calendar_rules_check1" CHECK (("starts_at" < "ends_at")),
    CONSTRAINT "planner_calendar_rules_frc_team_check" CHECK (("frc_team" = ANY (ARRAY['971'::"text", '9584'::"text"]))),
    CONSTRAINT "planner_calendar_rules_rule_type_check" CHECK (("rule_type" = ANY (ARRAY['work_window'::"text", 'blocked'::"text", 'drive_practice'::"text"]))),
    CONSTRAINT "planner_calendar_rules_weekday_check" CHECK ((("weekday" IS NULL) OR (("weekday" >= 0) AND ("weekday" <= 6))))
);


ALTER TABLE "public"."planner_calendar_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."planner_dependencies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "frc_team" "text" NOT NULL,
    "predecessor_item_id" "uuid" NOT NULL,
    "successor_item_id" "uuid" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "planner_dependencies_check" CHECK (("predecessor_item_id" <> "successor_item_id")),
    CONSTRAINT "planner_dependencies_frc_team_check" CHECK (("frc_team" = ANY (ARRAY['971'::"text", '9584'::"text"])))
);


ALTER TABLE "public"."planner_dependencies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."planner_drive_practice_prompts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "frc_team" "text" NOT NULL,
    "planner_calendar_rule_id" "uuid" NOT NULL,
    "recipient_id" "uuid" NOT NULL,
    "scheduled_for" timestamp with time zone NOT NULL,
    "sent_at" timestamp with time zone,
    "slack_channel" "text",
    "slack_ts" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "planner_drive_practice_prompts_frc_team_check" CHECK (("frc_team" = ANY (ARRAY['971'::"text", '9584'::"text"])))
);


ALTER TABLE "public"."planner_drive_practice_prompts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."planner_item_owners" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "frc_team" "text" NOT NULL,
    "planner_item_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "owner_type" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "planner_item_owners_frc_team_check" CHECK (("frc_team" = ANY (ARRAY['971'::"text", '9584'::"text"]))),
    CONSTRAINT "planner_item_owners_owner_type_check" CHECK (("owner_type" = ANY (ARRAY['owner'::"text", 'accountable'::"text"])))
);


ALTER TABLE "public"."planner_item_owners" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."planner_item_p0_bugs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "frc_team" "text" NOT NULL,
    "planner_item_id" "uuid" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "planner_item_p0_bugs_frc_team_check" CHECK (("frc_team" = ANY (ARRAY['971'::"text", '9584'::"text"])))
);


ALTER TABLE "public"."planner_item_p0_bugs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."planner_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "frc_team" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "title" "text" NOT NULL,
    "notes" "text",
    "category" "text",
    "status" "text" DEFAULT 'not_started'::"text" NOT NULL,
    "critical_level" integer DEFAULT 3 NOT NULL,
    "duration_minutes" integer,
    "min_duration_minutes" integer DEFAULT 30 NOT NULL,
    "manual_override" boolean DEFAULT false NOT NULL,
    "manual_start_at" timestamp with time zone,
    "scheduled_start_at" timestamp with time zone,
    "scheduled_end_at" timestamp with time zone,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "requested_duration_minutes" integer,
    "task_mode" "text" DEFAULT 'standard'::"text" NOT NULL,
    CONSTRAINT "planner_items_category_check" CHECK ((("category" IS NULL) OR ("category" = ANY (ARRAY['assembly'::"text", 'electrical'::"text", 'software'::"text", 'manufacturing'::"text", 'cad'::"text", 'drive_practice'::"text"])))),
    CONSTRAINT "planner_items_critical_level_check" CHECK ((("critical_level" >= 1) AND ("critical_level" <= 4))),
    CONSTRAINT "planner_items_duration_minutes_check" CHECK ((("duration_minutes" IS NULL) OR ("duration_minutes" > 0))),
    CONSTRAINT "planner_items_frc_team_check" CHECK (("frc_team" = ANY (ARRAY['971'::"text", '9584'::"text"]))),
    CONSTRAINT "planner_items_kind_check" CHECK (("kind" = ANY (ARRAY['task'::"text", 'milestone'::"text"]))),
    CONSTRAINT "planner_items_min_duration_minutes_check" CHECK (("min_duration_minutes" > 0)),
    CONSTRAINT "planner_items_requested_duration_minutes_check" CHECK ((("requested_duration_minutes" IS NULL) OR ("requested_duration_minutes" > 0))),
    CONSTRAINT "planner_items_status_check" CHECK (("status" = ANY (ARRAY['not_started'::"text", 'green'::"text", 'yellow'::"text", 'red'::"text", 'completed'::"text"]))),
    CONSTRAINT "planner_items_task_mode_check" CHECK (("task_mode" = ANY (ARRAY['standard'::"text", 'fixing'::"text"])))
);


ALTER TABLE "public"."planner_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."planner_slack_prompts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "frc_team" "text" NOT NULL,
    "planner_item_id" "uuid" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "checkpoint" "text" NOT NULL,
    "scheduled_for" timestamp with time zone NOT NULL,
    "sent_at" timestamp with time zone,
    "slack_channel" "text",
    "slack_ts" "text",
    "responded_status" "text",
    "responded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "planner_slack_prompts_checkpoint_check" CHECK (("checkpoint" = ANY (ARRAY['task_start'::"text", 'session_start'::"text", 'session_midpoint'::"text", 'session_end'::"text", 'task_end'::"text"]))),
    CONSTRAINT "planner_slack_prompts_frc_team_check" CHECK (("frc_team" = ANY (ARRAY['971'::"text", '9584'::"text"]))),
    CONSTRAINT "planner_slack_prompts_responded_status_check" CHECK ((("responded_status" IS NULL) OR ("responded_status" = ANY (ARRAY['green'::"text", 'yellow'::"text", 'red'::"text", 'completed'::"text"]))))
);


ALTER TABLE "public"."planner_slack_prompts" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."purchasing_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE "public"."purchasing_id_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."purchasing" (
    "id" bigint DEFAULT "nextval"('"public"."purchasing_id_seq"'::"regclass") NOT NULL,
    "name" "text" NOT NULL,
    "requester" "text" NOT NULL,
    "project_id" "text" NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "material" "text" DEFAULT ''::"text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "vendor" "text",
    "url" "text",
    "price" numeric(10,2),
    "final_price" numeric(10,2),
    "part_number" "text",
    "kitting_bin" "text",
    "delivered" boolean DEFAULT false,
    "workflow" "text" DEFAULT 'purchase'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "approved" boolean DEFAULT false NOT NULL,
    "approver" "text",
    "notes" "text",
    "purchaser" "uuid",
    "slack_channel" "text",
    "slack_ts" "text",
    "order_id" bigint,
    "shipping_cost_allocated" numeric DEFAULT 0,
    "delivery_date" "date",
    "frc_team" "text",
    "is_pickup" boolean DEFAULT false NOT NULL,
    CONSTRAINT "purchasing_frc_team_check" CHECK ((("frc_team" IS NULL) OR ("frc_team" = ANY (ARRAY['971'::"text", '9584'::"text", 'Mentor'::"text"])))),
    CONSTRAINT "purchasing_new_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'ordered'::"text", 'delivered'::"text", 'kitted'::"text", 'rejected'::"text"]))),
    CONSTRAINT "purchasing_new_workflow_check" CHECK (("workflow" = 'purchase'::"text")),
    CONSTRAINT "purchasing_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'ordered'::"text", 'delivered'::"text", 'kitted'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."purchasing" OWNER TO "postgres";


COMMENT ON COLUMN "public"."purchasing"."frc_team" IS 'FRC team of the student who submitted the purchase request.';



CREATE TABLE IF NOT EXISTS "public"."purchasing_budgets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "category" "text",
    "scope_type" "text" NOT NULL,
    "scope_value" "text",
    "amount" numeric NOT NULL,
    "period_type" "text" DEFAULT 'fixed'::"text" NOT NULL,
    "period_interval" "text",
    "start_date" "date",
    "end_date" "date",
    "spend_mode" "text" DEFAULT 'all_costs'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "purchasing_budgets_amount_check" CHECK (("amount" >= (0)::numeric)),
    CONSTRAINT "purchasing_budgets_date_order" CHECK ((("end_date" IS NULL) OR ("start_date" IS NULL) OR ("start_date" <= "end_date"))),
    CONSTRAINT "purchasing_budgets_period_interval_check" CHECK ((("period_interval" IS NULL) OR ("period_interval" = ANY (ARRAY['weekly'::"text", 'monthly'::"text", 'quarterly'::"text", 'yearly'::"text"])))),
    CONSTRAINT "purchasing_budgets_period_type_check" CHECK (("period_type" = ANY (ARRAY['fixed'::"text", 'recurring'::"text"]))),
    CONSTRAINT "purchasing_budgets_recurring_interval" CHECK ((("period_type" <> 'recurring'::"text") OR (("period_interval" IS NOT NULL) AND ("start_date" IS NOT NULL)))),
    CONSTRAINT "purchasing_budgets_scope_type_check" CHECK (("scope_type" = ANY (ARRAY['overall'::"text", 'project'::"text", 'subsystem'::"text", 'build'::"text", 'build_group'::"text"]))),
    CONSTRAINT "purchasing_budgets_scope_value_required" CHECK (((("scope_type" = 'overall'::"text") AND ("scope_value" IS NULL)) OR (("scope_type" <> 'overall'::"text") AND ("scope_value" IS NOT NULL)))),
    CONSTRAINT "purchasing_budgets_spend_mode_check" CHECK (("spend_mode" = ANY (ARRAY['all_costs'::"text", 'item_only'::"text", 'shipping_only'::"text"])))
);


ALTER TABLE "public"."purchasing_budgets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."roster_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "roster_id" "uuid",
    "user_id" "uuid",
    "key_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."roster_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."roster_keys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "roster_id" "uuid",
    "key_name" "text" NOT NULL,
    "category" "text" DEFAULT 'General'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."roster_keys" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rosters" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "is_public" boolean DEFAULT false,
    "is_admin_editable" boolean DEFAULT false,
    "type" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "target_frc_team" "text" DEFAULT 'all'::"text",
    CONSTRAINT "rosters_target_frc_team_check" CHECK (("target_frc_team" = ANY (ARRAY['all'::"text", 'students'::"text", '971'::"text", '9584'::"text"]))),
    CONSTRAINT "rosters_type_check" CHECK (("type" = ANY (ARRAY['single'::"text", 'multi'::"text"])))
);


ALTER TABLE "public"."rosters" OWNER TO "postgres";


COMMENT ON COLUMN "public"."rosters"."target_frc_team" IS 'Filter for roster visibility: all, students (971+9584), 971, or 9584';



CREATE TABLE IF NOT EXISTS "public"."router_group_parts" (
    "group_id" "uuid" NOT NULL,
    "part_id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."router_group_parts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."router_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "stock_type" "text" DEFAULT ''::"text" NOT NULL,
    "cut_name" "text" DEFAULT ''::"text" NOT NULL,
    "output_folder" "text" DEFAULT ''::"text" NOT NULL,
    "machine" "text" DEFAULT 'UNC Router'::"text" NOT NULL,
    "material" "text" DEFAULT ''::"text",
    "status" "text" DEFAULT ''::"text",
    "stock" "text" DEFAULT ''::"text",
    "queue_position" integer DEFAULT 999,
    "target_date" "date",
    "post_processing_stage" "text",
    CONSTRAINT "router_groups_machine_check" CHECK (("machine" = ANY (ARRAY['UNC Router'::"text", 'ShopSabre'::"text"])))
);


ALTER TABLE "public"."router_groups" OWNER TO "postgres";


COMMENT ON COLUMN "public"."router_groups"."machine" IS 'The machine assigned to cut this group (e.g., Avid CNC)';



COMMENT ON COLUMN "public"."router_groups"."material" IS 'Material type for the group';



COMMENT ON COLUMN "public"."router_groups"."status" IS 'Group-level status (Pending, CAM Reviewed, TravisProgged, Machined)';



COMMENT ON COLUMN "public"."router_groups"."stock" IS 'Stock assignment for the group (from stock.json options)';



COMMENT ON COLUMN "public"."router_groups"."queue_position" IS 'Position in the router queue (lower = higher priority)';



COMMENT ON COLUMN "public"."router_groups"."target_date" IS 'Target date for completing this group';



COMMENT ON COLUMN "public"."router_groups"."post_processing_stage" IS 'Current stage in post-processing (Jigsawed, Countersinking, Deburring, Inspecting, Kitted)';



CREATE TABLE IF NOT EXISTS "public"."runtime_leases" (
    "key" "text" NOT NULL,
    "lease_expires_at" timestamp with time zone,
    "last_started_at" timestamp with time zone,
    "last_finished_at" timestamp with time zone
);


ALTER TABLE "public"."runtime_leases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scout_data_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "match_key" "text" NOT NULL,
    "match_number" integer,
    "team_key" "text" NOT NULL,
    "phase" "text",
    "event_type" "text" NOT NULL,
    "event_value" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "role" "text",
    "on_shift" boolean
);


ALTER TABLE "public"."scout_data_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scout_flagged_matches" (
    "id" bigint NOT NULL,
    "event_key" "text" NOT NULL,
    "match_key" "text" NOT NULL,
    "team_key" "text" NOT NULL,
    "manual_flagged" boolean NOT NULL,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."scout_flagged_matches" OWNER TO "postgres";


ALTER TABLE "public"."scout_flagged_matches" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."scout_flagged_matches_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."scout_match_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scouting_type" "text" NOT NULL,
    "match_key" "text" NOT NULL,
    "team_key" "text" NOT NULL,
    "assigned_user" "uuid",
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."scout_match_assignments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scout_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "match_key" "text" NOT NULL,
    "match_number" integer,
    "team_key" "text" NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."scout_notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scouting_settings" (
    "id" integer NOT NULL,
    "event_key" "text",
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "smart_fuel_algorithm_enabled" boolean DEFAULT false NOT NULL,
    CONSTRAINT "scouting_settings_single_row" CHECK (("id" = 1))
);


ALTER TABLE "public"."scouting_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sneakpeek_photos" (
    "id" "text" NOT NULL,
    "original_path" "text" NOT NULL,
    "obscured_path" "text" NOT NULL,
    "width" integer NOT NULL,
    "height" integer NOT NULL,
    "reveal_radius" integer NOT NULL,
    "grain_amount" integer NOT NULL,
    "grain_style" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "reveal_radius_ratio" numeric NOT NULL,
    "grain_ratio" numeric NOT NULL,
    "encrypted_payload_path" "text" NOT NULL,
    "encrypted_payload_version" integer DEFAULT 1 NOT NULL,
    "encryption_mode" "text" DEFAULT 'per_pixel_radius'::"text" NOT NULL,
    "encryption_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "sneakpeek_photos_encryption_mode_check" CHECK (("encryption_mode" = 'tile_stream'::"text")),
    CONSTRAINT "sneakpeek_photos_grain_amount_check" CHECK (("grain_amount" >= 8)),
    CONSTRAINT "sneakpeek_photos_grain_ratio_check" CHECK ((("grain_ratio" >= 0.015) AND ("grain_ratio" <= 0.2))),
    CONSTRAINT "sneakpeek_photos_grain_style_check" CHECK (("grain_style" = ANY (ARRAY['blur'::"text", 'pixelate'::"text"]))),
    CONSTRAINT "sneakpeek_photos_height_check" CHECK (("height" > 0)),
    CONSTRAINT "sneakpeek_photos_reveal_radius_check" CHECK (("reveal_radius" >= 36)),
    CONSTRAINT "sneakpeek_photos_reveal_radius_ratio_check" CHECK ((("reveal_radius_ratio" >= 0.04) AND ("reveal_radius_ratio" <= 0.4))),
    CONSTRAINT "sneakpeek_photos_width_check" CHECK (("width" > 0))
);


ALTER TABLE "public"."sneakpeek_photos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sneakpeek_shares" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "photo_id" "text" NOT NULL,
    "share_kind" "text" NOT NULL,
    "token_hash" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "sneakpeek_shares_share_kind_check" CHECK (("share_kind" = ANY (ARRAY['permanent'::"text", 'temporary'::"text"])))
);


ALTER TABLE "public"."sneakpeek_shares" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sneakpeek_view_sessions" (
    "id" "text" NOT NULL,
    "photo_id" "text" NOT NULL,
    "share_kind" "text" NOT NULL,
    "session_token_hash" "text" NOT NULL,
    "reveal_count" integer DEFAULT 0 NOT NULL,
    "revealed_area_estimate" numeric DEFAULT 0 NOT NULL,
    "last_viewed_at" timestamp with time zone,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "sneakpeek_view_sessions_share_kind_check" CHECK (("share_kind" = ANY (ARRAY['permanent'::"text", 'temporary'::"text"])))
);


ALTER TABLE "public"."sneakpeek_view_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subsystem_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subsystem_id" "uuid",
    "user_id" "uuid",
    "joined_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."subsystem_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subsystems" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" character varying(255) NOT NULL,
    "description" "text",
    "lead_user_id" "uuid",
    "onshape_url" "text",
    "onshape_document_id" character varying(255),
    "onshape_workspace_id" character varying(255),
    "onshape_element_id" character varying(255),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "frc_team" "text",
    CONSTRAINT "subsystems_frc_team_check" CHECK ((("frc_team" IS NULL) OR ("frc_team" = ANY (ARRAY['971'::"text", '9584'::"text", 'Mentor'::"text"]))))
);


ALTER TABLE "public"."subsystems" OWNER TO "postgres";


COMMENT ON COLUMN "public"."subsystems"."frc_team" IS 'Originating FRC team (971, 9584, Mentor) based on the student who created the subsystem.';



CREATE TABLE IF NOT EXISTS "public"."tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "frc_team" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "scope" "text" NOT NULL,
    "general_type" "text",
    "subsystem_id" "uuid",
    "assignee_id" "uuid",
    "reviewer_id" "uuid",
    "created_by" "uuid" NOT NULL,
    "needs_review" boolean DEFAULT false NOT NULL,
    "needs_manufacturing" boolean DEFAULT false NOT NULL,
    "deadline_at" timestamp with time zone,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "review_decision" "text",
    "review_notes" "text",
    "reviewed_at" timestamp with time zone,
    "attachment_path" "text",
    "attachment_name" "text",
    "attachment_uploaded_at" timestamp with time zone,
    "parts_id" bigint,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "assignment_slack_channel" "text",
    "assignment_slack_ts" "text",
    CONSTRAINT "tasks_frc_team_check" CHECK (("frc_team" = ANY (ARRAY['971'::"text", '9584'::"text"]))),
    CONSTRAINT "tasks_general_type_check" CHECK ((("general_type" IS NULL) OR ("general_type" = ANY (ARRAY['CAD'::"text", 'Mechanical'::"text", 'Electrical'::"text", 'Software'::"text", 'Other'::"text"])))),
    CONSTRAINT "tasks_review_decision_check" CHECK ((("review_decision" IS NULL) OR ("review_decision" = ANY (ARRAY['approved'::"text", 'changes_requested'::"text"])))),
    CONSTRAINT "tasks_scope_check" CHECK (("scope" = ANY (ARRAY['general'::"text", 'subsystem'::"text"]))),
    CONSTRAINT "tasks_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'in_progress'::"text", 'file_uploaded'::"text", 'under_review'::"text", 'changes_requested'::"text", 'approved'::"text", 'done'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."tasks" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."user_attendance_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE "public"."user_attendance_logs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."user_attendance_logs_id_seq" OWNED BY "public"."user_attendance_logs"."id";



CREATE TABLE IF NOT EXISTS "public"."user_budget_pins" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "budget_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_budget_pins" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_budget_pins" IS 'Join table for users pinning specific budgets to their dashboard';



CREATE TABLE IF NOT EXISTS "public"."user_notification_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "entity_key" "text" NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_notification_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vendors" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "url_base" "text" NOT NULL,
    "free_shipping" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."vendors" OWNER TO "postgres";


ALTER TABLE "public"."vendors" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."vendors_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE ONLY "public"."attendance_locations" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."attendance_locations_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."attendance_schedules" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."attendance_schedules_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."parts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."parts_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."pit_scout_entries" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."pit_scout_entries_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."user_attendance_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."user_attendance_logs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."attendance_locations"
    ADD CONSTRAINT "attendance_locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."attendance_schedule_locations"
    ADD CONSTRAINT "attendance_schedule_locations_pkey" PRIMARY KEY ("schedule_id", "location_id");



ALTER TABLE ONLY "public"."attendance_schedules"
    ADD CONSTRAINT "attendance_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."build_bom"
    ADD CONSTRAINT "build_bom_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."builds"
    ADD CONSTRAINT "builds_build_hash_key" UNIQUE ("build_hash");



ALTER TABLE ONLY "public"."builds"
    ADD CONSTRAINT "builds_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cots_stock_items"
    ADD CONSTRAINT "cots_stock_items_key_unique" UNIQUE ("canonical_key");



ALTER TABLE ONLY "public"."cots_stock_items"
    ADD CONSTRAINT "cots_stock_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cots_stock_locations"
    ADD CONSTRAINT "cots_stock_locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kitting_bins"
    ADD CONSTRAINT "kitting_bins_pkey" PRIMARY KEY ("bin_id");



ALTER TABLE ONLY "public"."kitting"
    ADD CONSTRAINT "kitting_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_order_number_key" UNIQUE ("order_number");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."parts"
    ADD CONSTRAINT "parts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pit_scout_entries"
    ADD CONSTRAINT "pit_scout_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pit_scout_entries"
    ADD CONSTRAINT "pit_scout_entries_unique_event_team" UNIQUE ("event_key", "team_key");



ALTER TABLE ONLY "public"."planner_calendar_rule_recipients"
    ADD CONSTRAINT "planner_calendar_rule_recipie_planner_calendar_rule_id_user_key" UNIQUE ("planner_calendar_rule_id", "user_id");



ALTER TABLE ONLY "public"."planner_calendar_rule_recipients"
    ADD CONSTRAINT "planner_calendar_rule_recipients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."planner_calendar_rules"
    ADD CONSTRAINT "planner_calendar_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."planner_dependencies"
    ADD CONSTRAINT "planner_dependencies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."planner_dependencies"
    ADD CONSTRAINT "planner_dependencies_predecessor_item_id_successor_item_id_key" UNIQUE ("predecessor_item_id", "successor_item_id");



ALTER TABLE ONLY "public"."planner_drive_practice_prompts"
    ADD CONSTRAINT "planner_drive_practice_prompt_planner_calendar_rule_id_reci_key" UNIQUE ("planner_calendar_rule_id", "recipient_id", "scheduled_for");



ALTER TABLE ONLY "public"."planner_drive_practice_prompts"
    ADD CONSTRAINT "planner_drive_practice_prompts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."planner_item_owners"
    ADD CONSTRAINT "planner_item_owners_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."planner_item_owners"
    ADD CONSTRAINT "planner_item_owners_planner_item_id_user_id_owner_type_key" UNIQUE ("planner_item_id", "user_id", "owner_type");



ALTER TABLE ONLY "public"."planner_item_p0_bugs"
    ADD CONSTRAINT "planner_item_p0_bugs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."planner_item_p0_bugs"
    ADD CONSTRAINT "planner_item_p0_bugs_planner_item_id_task_id_key" UNIQUE ("planner_item_id", "task_id");



ALTER TABLE ONLY "public"."planner_items"
    ADD CONSTRAINT "planner_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."planner_slack_prompts"
    ADD CONSTRAINT "planner_slack_prompts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."planner_slack_prompts"
    ADD CONSTRAINT "planner_slack_prompts_planner_item_owner_checkpoint_scheduled_f" UNIQUE ("planner_item_id", "owner_id", "checkpoint", "scheduled_for");



ALTER TABLE ONLY "public"."purchasing_budgets"
    ADD CONSTRAINT "purchasing_budgets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchasing"
    ADD CONSTRAINT "purchasing_new_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."roster_entries"
    ADD CONSTRAINT "roster_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."roster_entries"
    ADD CONSTRAINT "roster_entries_roster_id_user_id_key_id_key" UNIQUE ("roster_id", "user_id", "key_id");



ALTER TABLE ONLY "public"."roster_keys"
    ADD CONSTRAINT "roster_keys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rosters"
    ADD CONSTRAINT "rosters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."router_group_parts"
    ADD CONSTRAINT "router_group_parts_pkey" PRIMARY KEY ("group_id", "part_id");



ALTER TABLE ONLY "public"."router_groups"
    ADD CONSTRAINT "router_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."runtime_leases"
    ADD CONSTRAINT "runtime_leases_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."scout_data_events"
    ADD CONSTRAINT "scout_data_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scout_flagged_matches"
    ADD CONSTRAINT "scout_flagged_matches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scout_flagged_matches"
    ADD CONSTRAINT "scout_flagged_matches_unique_slot" UNIQUE ("event_key", "match_key", "team_key");



ALTER TABLE ONLY "public"."scout_match_assignments"
    ADD CONSTRAINT "scout_match_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scout_notes"
    ADD CONSTRAINT "scout_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scouting_settings"
    ADD CONSTRAINT "scouting_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sneakpeek_photos"
    ADD CONSTRAINT "sneakpeek_photos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sneakpeek_shares"
    ADD CONSTRAINT "sneakpeek_shares_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sneakpeek_shares"
    ADD CONSTRAINT "sneakpeek_shares_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."sneakpeek_view_sessions"
    ADD CONSTRAINT "sneakpeek_view_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sneakpeek_view_sessions"
    ADD CONSTRAINT "sneakpeek_view_sessions_session_token_hash_key" UNIQUE ("session_token_hash");



ALTER TABLE ONLY "public"."subsystem_members"
    ADD CONSTRAINT "subsystem_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subsystem_members"
    ADD CONSTRAINT "subsystem_members_subsystem_id_user_id_key" UNIQUE ("subsystem_id", "user_id");



ALTER TABLE ONLY "public"."subsystems"
    ADD CONSTRAINT "subsystems_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_attendance_logs"
    ADD CONSTRAINT "user_attendance_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_budget_pins"
    ADD CONSTRAINT "user_budget_pins_user_id_budget_id_key" UNIQUE ("user_id", "budget_id");



ALTER TABLE ONLY "public"."user_notification_logs"
    ADD CONSTRAINT "user_notification_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_name_unique" UNIQUE ("name");



ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_build_bom_added" ON "public"."build_bom" USING "btree" ("build_id", "added");



CREATE INDEX "idx_build_bom_build_id" ON "public"."build_bom" USING "btree" ("build_id");



CREATE INDEX "idx_build_bom_kitting_id" ON "public"."build_bom" USING "btree" ("kitting_id");



CREATE INDEX "idx_build_bom_other" ON "public"."build_bom" USING "btree" ("build_id") WHERE (("part_type")::"text" = 'other'::"text");



CREATE INDEX "idx_build_bom_part_type" ON "public"."build_bom" USING "btree" ("part_type");



CREATE INDEX "idx_build_bom_parts_id" ON "public"."build_bom" USING "btree" ("parts_id");



CREATE INDEX "idx_build_bom_purchasing_id" ON "public"."build_bom" USING "btree" ("purchasing_id");



CREATE INDEX "idx_build_bom_status" ON "public"."build_bom" USING "btree" ("status");



CREATE INDEX "idx_builds_build_hash" ON "public"."builds" USING "btree" ("build_hash");



CREATE INDEX "idx_builds_project_id" ON "public"."builds" USING "btree" ("project_id");



CREATE INDEX "idx_builds_status" ON "public"."builds" USING "btree" ("status");



CREATE INDEX "idx_builds_subsystem_id" ON "public"."builds" USING "btree" ("subsystem_id");



CREATE INDEX "idx_cots_stock_items_name" ON "public"."cots_stock_items" USING "btree" ("canonical_name");



CREATE INDEX "idx_cots_stock_locations_item_id" ON "public"."cots_stock_locations" USING "btree" ("item_id");



CREATE INDEX "idx_cots_stock_locations_lookup" ON "public"."cots_stock_locations" USING "btree" ("item_id", "section", "drawer", "subsection");



CREATE INDEX "idx_parts_onshape_params" ON "public"."parts" USING "btree" ("onshape_document_id", "onshape_wvmid", "onshape_element_id", "onshape_part_id") WHERE ("is_onshape_part" = true);



CREATE INDEX "idx_parts_preview_image_exists" ON "public"."parts" USING "btree" ((("preview_image_url" IS NOT NULL)));



CREATE INDEX "idx_parts_project_id" ON "public"."parts" USING "btree" ("project_id");



CREATE INDEX "idx_parts_router_group_id" ON "public"."parts" USING "btree" ("router_group_id");



CREATE INDEX "idx_parts_router_step" ON "public"."parts" USING "btree" ("router_step");



CREATE INDEX "idx_parts_router_travis" ON "public"."parts" USING "btree" ("router_travis_progged");



CREATE INDEX "idx_parts_status" ON "public"."parts" USING "btree" ("status");



CREATE INDEX "idx_parts_status_cammed" ON "public"."parts" USING "btree" ("status") WHERE ("status" = 'cammed'::"text");



CREATE INDEX "idx_parts_workflow" ON "public"."parts" USING "btree" ("workflow");



CREATE INDEX "idx_parts_workflow_status" ON "public"."parts" USING "btree" ("workflow", "status");



CREATE INDEX "idx_planner_calendar_rule_recipients_rule" ON "public"."planner_calendar_rule_recipients" USING "btree" ("planner_calendar_rule_id");



CREATE INDEX "idx_planner_calendar_rule_recipients_user" ON "public"."planner_calendar_rule_recipients" USING "btree" ("user_id");



CREATE INDEX "idx_planner_calendar_rules_team" ON "public"."planner_calendar_rules" USING "btree" ("frc_team", "rule_type", "weekday", "specific_date");



CREATE INDEX "idx_planner_dependencies_predecessor" ON "public"."planner_dependencies" USING "btree" ("predecessor_item_id");



CREATE INDEX "idx_planner_dependencies_successor" ON "public"."planner_dependencies" USING "btree" ("successor_item_id");



CREATE INDEX "idx_planner_drive_practice_prompts_due" ON "public"."planner_drive_practice_prompts" USING "btree" ("scheduled_for", "sent_at");



CREATE UNIQUE INDEX "idx_planner_drive_practice_prompts_message" ON "public"."planner_drive_practice_prompts" USING "btree" ("slack_channel", "slack_ts") WHERE (("slack_channel" IS NOT NULL) AND ("slack_ts" IS NOT NULL));



CREATE INDEX "idx_planner_item_owners_item" ON "public"."planner_item_owners" USING "btree" ("planner_item_id");



CREATE INDEX "idx_planner_item_owners_user" ON "public"."planner_item_owners" USING "btree" ("user_id");



CREATE INDEX "idx_planner_item_p0_bugs_item" ON "public"."planner_item_p0_bugs" USING "btree" ("planner_item_id");



CREATE INDEX "idx_planner_item_p0_bugs_task" ON "public"."planner_item_p0_bugs" USING "btree" ("task_id");



CREATE INDEX "idx_planner_items_schedule" ON "public"."planner_items" USING "btree" ("frc_team", "scheduled_start_at", "scheduled_end_at");



CREATE INDEX "idx_planner_items_team_sort" ON "public"."planner_items" USING "btree" ("frc_team", "sort_order", "created_at");



CREATE INDEX "idx_planner_slack_prompts_due" ON "public"."planner_slack_prompts" USING "btree" ("scheduled_for", "sent_at");



CREATE UNIQUE INDEX "idx_planner_slack_prompts_message" ON "public"."planner_slack_prompts" USING "btree" ("slack_channel", "slack_ts") WHERE (("slack_channel" IS NOT NULL) AND ("slack_ts" IS NOT NULL));



CREATE INDEX "idx_purchasing_kitting_bin" ON "public"."purchasing" USING "btree" ("kitting_bin");



CREATE INDEX "idx_purchasing_project_id" ON "public"."purchasing" USING "btree" ("project_id");



CREATE INDEX "idx_purchasing_purchaser" ON "public"."purchasing" USING "btree" ("purchaser");



CREATE INDEX "idx_purchasing_status" ON "public"."purchasing" USING "btree" ("status");



CREATE INDEX "idx_purchasing_vendor" ON "public"."purchasing" USING "btree" ("vendor");



CREATE INDEX "idx_router_groups_queue_position" ON "public"."router_groups" USING "btree" ("queue_position");



CREATE INDEX "idx_tasks_assignee" ON "public"."tasks" USING "btree" ("assignee_id");



CREATE UNIQUE INDEX "idx_tasks_assignment_slack_message" ON "public"."tasks" USING "btree" ("assignment_slack_channel", "assignment_slack_ts") WHERE (("assignment_slack_channel" IS NOT NULL) AND ("assignment_slack_ts" IS NOT NULL));



CREATE INDEX "idx_tasks_deadline_status" ON "public"."tasks" USING "btree" ("deadline_at", "status");



CREATE INDEX "idx_tasks_reviewer" ON "public"."tasks" USING "btree" ("reviewer_id");



CREATE INDEX "idx_tasks_team_created_at" ON "public"."tasks" USING "btree" ("frc_team", "created_at" DESC);



CREATE INDEX "kitting_bins_name_idx" ON "public"."kitting_bins" USING "btree" ("name");



CREATE INDEX "kitting_project_idx" ON "public"."kitting" USING "btree" ("project_id");



CREATE INDEX "kitting_status_idx" ON "public"."kitting" USING "btree" ("status");



CREATE INDEX "orders_placed_at_idx" ON "public"."orders" USING "btree" ("placed_at");



CREATE INDEX "orders_placed_by_idx" ON "public"."orders" USING "btree" ("placed_by");



CREATE INDEX "orders_vendor_idx" ON "public"."orders" USING "btree" ("vendor");



CREATE INDEX "pit_scout_entries_event_team_idx" ON "public"."pit_scout_entries" USING "btree" ("event_key", "team_key");



CREATE INDEX "pit_scout_entries_team_idx" ON "public"."pit_scout_entries" USING "btree" ("team_key");



CREATE INDEX "purchasing_budgets_period_idx" ON "public"."purchasing_budgets" USING "btree" ("period_type", "period_interval");



CREATE INDEX "purchasing_budgets_scope_idx" ON "public"."purchasing_budgets" USING "btree" ("scope_type", "scope_value");



CREATE INDEX "purchasing_order_id_idx" ON "public"."purchasing" USING "btree" ("order_id");



CREATE INDEX "router_group_parts_part_id_idx" ON "public"."router_group_parts" USING "btree" ("part_id");



CREATE INDEX "scout_data_events_match_idx" ON "public"."scout_data_events" USING "btree" ("match_key");



CREATE INDEX "scout_data_events_team_idx" ON "public"."scout_data_events" USING "btree" ("team_key");



CREATE INDEX "scout_flagged_matches_event_idx" ON "public"."scout_flagged_matches" USING "btree" ("event_key", "match_key");



CREATE UNIQUE INDEX "scout_match_assignments_unique" ON "public"."scout_match_assignments" USING "btree" ("scouting_type", "match_key", "team_key");



CREATE INDEX "scout_match_assignments_user_idx" ON "public"."scout_match_assignments" USING "btree" ("assigned_user");



CREATE INDEX "scout_notes_match_key_idx" ON "public"."scout_notes" USING "btree" ("match_key");



CREATE INDEX "scout_notes_team_key_idx" ON "public"."scout_notes" USING "btree" ("team_key");



CREATE INDEX "sneakpeek_photos_encrypted_payload_path_idx" ON "public"."sneakpeek_photos" USING "btree" ("encrypted_payload_path");



CREATE UNIQUE INDEX "user_attendance_logs_one_per_day_idx" ON "public"."user_attendance_logs" USING "btree" ("user_id", "date"("timezone"('America/Los_Angeles'::"text", "recorded_at")));



CREATE UNIQUE INDEX "user_notification_logs_key" ON "public"."user_notification_logs" USING "btree" ("user_id", "event_type", "entity_key");



CREATE INDEX "vendors_name_idx" ON "public"."vendors" USING "btree" ("name");



CREATE INDEX "vendors_url_base_idx" ON "public"."vendors" USING "btree" ("url_base");



CREATE OR REPLACE TRIGGER "kitting_set_updated_at" BEFORE UPDATE ON "public"."kitting" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_parts_onshape_file_format" BEFORE INSERT OR UPDATE ON "public"."parts" FOR EACH ROW EXECUTE FUNCTION "public"."set_onshape_file_format"();



CREATE OR REPLACE TRIGGER "set_router_group_name" BEFORE INSERT ON "public"."router_groups" FOR EACH ROW EXECUTE FUNCTION "public"."router_groups_set_name"();



CREATE OR REPLACE TRIGGER "tr_purchasing_budgets_updated_at" BEFORE UPDATE ON "public"."purchasing_budgets" FOR EACH ROW EXECUTE FUNCTION "public"."set_purchasing_budget_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cots_stock_items_set_updated_at" BEFORE UPDATE ON "public"."cots_stock_items" FOR EACH ROW EXECUTE FUNCTION "public"."cots_stock_items_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cots_stock_locations_set_updated_at" BEFORE UPDATE ON "public"."cots_stock_locations" FOR EACH ROW EXECUTE FUNCTION "public"."cots_stock_locations_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_planner_calendar_rules_set_updated_at" BEFORE UPDATE ON "public"."planner_calendar_rules" FOR EACH ROW EXECUTE FUNCTION "public"."planner_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_planner_drive_practice_prompts_set_updated_at" BEFORE UPDATE ON "public"."planner_drive_practice_prompts" FOR EACH ROW EXECUTE FUNCTION "public"."planner_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_planner_items_set_updated_at" BEFORE UPDATE ON "public"."planner_items" FOR EACH ROW EXECUTE FUNCTION "public"."planner_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_planner_slack_prompts_set_updated_at" BEFORE UPDATE ON "public"."planner_slack_prompts" FOR EACH ROW EXECUTE FUNCTION "public"."planner_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tasks_set_updated_at" BEFORE UPDATE ON "public"."tasks" FOR EACH ROW EXECUTE FUNCTION "public"."tasks_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_touch_pit_scout_entries" BEFORE UPDATE ON "public"."pit_scout_entries" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "trg_touch_scout_assign" BEFORE UPDATE ON "public"."scout_match_assignments" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "update_orders_updated_at" BEFORE UPDATE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_parts_updated_at" BEFORE UPDATE ON "public"."parts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_purchasing_updated_at" BEFORE UPDATE ON "public"."purchasing" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."attendance_locations"
    ADD CONSTRAINT "attendance_locations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."attendance_schedule_locations"
    ADD CONSTRAINT "attendance_schedule_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."attendance_locations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."attendance_schedule_locations"
    ADD CONSTRAINT "attendance_schedule_locations_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "public"."attendance_schedules"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."attendance_schedules"
    ADD CONSTRAINT "attendance_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."build_bom"
    ADD CONSTRAINT "build_bom_build_id_fkey" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."build_bom"
    ADD CONSTRAINT "build_bom_kitting_id_fkey" FOREIGN KEY ("kitting_id") REFERENCES "public"."kitting"("id");



ALTER TABLE ONLY "public"."build_bom"
    ADD CONSTRAINT "build_bom_parts_id_fkey" FOREIGN KEY ("parts_id") REFERENCES "public"."parts"("id");



ALTER TABLE ONLY "public"."build_bom"
    ADD CONSTRAINT "build_bom_purchasing_id_fkey" FOREIGN KEY ("purchasing_id") REFERENCES "public"."purchasing"("id");



ALTER TABLE ONLY "public"."builds"
    ADD CONSTRAINT "builds_assembled_by_fkey" FOREIGN KEY ("assembled_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."builds"
    ADD CONSTRAINT "builds_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."builds"
    ADD CONSTRAINT "builds_subsystem_id_fkey" FOREIGN KEY ("subsystem_id") REFERENCES "public"."subsystems"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cots_stock_items"
    ADD CONSTRAINT "cots_stock_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cots_stock_locations"
    ADD CONSTRAINT "cots_stock_locations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cots_stock_locations"
    ADD CONSTRAINT "cots_stock_locations_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."cots_stock_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."kitting"
    ADD CONSTRAINT "kitting_kitting_bin_fkey" FOREIGN KEY ("kitting_bin") REFERENCES "public"."kitting_bins"("bin_id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_placed_by_fkey" FOREIGN KEY ("placed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."parts"
    ADD CONSTRAINT "parts_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."parts"
    ADD CONSTRAINT "parts_kitting_bin_fkey" FOREIGN KEY ("kitting_bin") REFERENCES "public"."kitting_bins"("bin_id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."planner_calendar_rule_recipients"
    ADD CONSTRAINT "planner_calendar_rule_recipients_planner_calendar_rule_id_fkey" FOREIGN KEY ("planner_calendar_rule_id") REFERENCES "public"."planner_calendar_rules"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planner_calendar_rule_recipients"
    ADD CONSTRAINT "planner_calendar_rule_recipients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planner_calendar_rules"
    ADD CONSTRAINT "planner_calendar_rules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."planner_dependencies"
    ADD CONSTRAINT "planner_dependencies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planner_dependencies"
    ADD CONSTRAINT "planner_dependencies_predecessor_item_id_fkey" FOREIGN KEY ("predecessor_item_id") REFERENCES "public"."planner_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planner_dependencies"
    ADD CONSTRAINT "planner_dependencies_successor_item_id_fkey" FOREIGN KEY ("successor_item_id") REFERENCES "public"."planner_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planner_drive_practice_prompts"
    ADD CONSTRAINT "planner_drive_practice_prompts_planner_calendar_rule_id_fkey" FOREIGN KEY ("planner_calendar_rule_id") REFERENCES "public"."planner_calendar_rules"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planner_drive_practice_prompts"
    ADD CONSTRAINT "planner_drive_practice_prompts_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planner_item_owners"
    ADD CONSTRAINT "planner_item_owners_planner_item_id_fkey" FOREIGN KEY ("planner_item_id") REFERENCES "public"."planner_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planner_item_owners"
    ADD CONSTRAINT "planner_item_owners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planner_item_p0_bugs"
    ADD CONSTRAINT "planner_item_p0_bugs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planner_item_p0_bugs"
    ADD CONSTRAINT "planner_item_p0_bugs_planner_item_id_fkey" FOREIGN KEY ("planner_item_id") REFERENCES "public"."planner_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planner_item_p0_bugs"
    ADD CONSTRAINT "planner_item_p0_bugs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planner_items"
    ADD CONSTRAINT "planner_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planner_slack_prompts"
    ADD CONSTRAINT "planner_slack_prompts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planner_slack_prompts"
    ADD CONSTRAINT "planner_slack_prompts_planner_item_id_fkey" FOREIGN KEY ("planner_item_id") REFERENCES "public"."planner_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchasing_budgets"
    ADD CONSTRAINT "purchasing_budgets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."purchasing"
    ADD CONSTRAINT "purchasing_kitting_bin_fkey" FOREIGN KEY ("kitting_bin") REFERENCES "public"."kitting_bins"("bin_id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."purchasing"
    ADD CONSTRAINT "purchasing_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id");



ALTER TABLE ONLY "public"."purchasing"
    ADD CONSTRAINT "purchasing_purchaser_fkey" FOREIGN KEY ("purchaser") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."roster_entries"
    ADD CONSTRAINT "roster_entries_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "public"."roster_keys"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."roster_entries"
    ADD CONSTRAINT "roster_entries_roster_id_fkey" FOREIGN KEY ("roster_id") REFERENCES "public"."rosters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."roster_entries"
    ADD CONSTRAINT "roster_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."roster_keys"
    ADD CONSTRAINT "roster_keys_roster_id_fkey" FOREIGN KEY ("roster_id") REFERENCES "public"."rosters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rosters"
    ADD CONSTRAINT "rosters_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."router_group_parts"
    ADD CONSTRAINT "router_group_parts_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."router_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."router_group_parts"
    ADD CONSTRAINT "router_group_parts_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scout_data_events"
    ADD CONSTRAINT "scout_data_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."scout_match_assignments"
    ADD CONSTRAINT "scout_match_assignments_assigned_user_fkey" FOREIGN KEY ("assigned_user") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."scout_notes"
    ADD CONSTRAINT "scout_notes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sneakpeek_shares"
    ADD CONSTRAINT "sneakpeek_shares_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "public"."sneakpeek_photos"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sneakpeek_view_sessions"
    ADD CONSTRAINT "sneakpeek_view_sessions_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "public"."sneakpeek_photos"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subsystem_members"
    ADD CONSTRAINT "subsystem_members_subsystem_id_fkey" FOREIGN KEY ("subsystem_id") REFERENCES "public"."subsystems"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subsystem_members"
    ADD CONSTRAINT "subsystem_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subsystems"
    ADD CONSTRAINT "subsystems_lead_user_id_fkey" FOREIGN KEY ("lead_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_parts_id_fkey" FOREIGN KEY ("parts_id") REFERENCES "public"."parts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_subsystem_id_fkey" FOREIGN KEY ("subsystem_id") REFERENCES "public"."subsystems"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_attendance_logs"
    ADD CONSTRAINT "user_attendance_logs_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."attendance_locations"("id");



ALTER TABLE ONLY "public"."user_attendance_logs"
    ADD CONSTRAINT "user_attendance_logs_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "public"."attendance_schedules"("id");



ALTER TABLE ONLY "public"."user_attendance_logs"
    ADD CONSTRAINT "user_attendance_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."user_budget_pins"
    ADD CONSTRAINT "user_budget_pins_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "public"."purchasing_budgets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_budget_pins"
    ADD CONSTRAINT "user_budget_pins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_notification_logs"
    ADD CONSTRAINT "user_notification_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Roster entries are editable by leadership" ON "public"."roster_entries" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ((("user_profiles"."role")::"text" = 'admin'::"text") OR ("user_profiles"."general_role" = ANY (ARRAY['lead'::"text", 'subsystem_lead'::"text"])) OR ("user_profiles"."team_role" ~~* '%Lead'::"text")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ((("user_profiles"."role")::"text" = 'admin'::"text") OR ("user_profiles"."general_role" = ANY (ARRAY['lead'::"text", 'subsystem_lead'::"text"])) OR ("user_profiles"."team_role" ~~* '%Lead'::"text"))))));



CREATE POLICY "Roster entries are viewable by everyone" ON "public"."roster_entries" FOR SELECT USING (true);



CREATE POLICY "Roster keys are editable by leadership" ON "public"."roster_keys" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ((("user_profiles"."role")::"text" = 'admin'::"text") OR ("user_profiles"."general_role" = ANY (ARRAY['lead'::"text", 'subsystem_lead'::"text"])) OR ("user_profiles"."team_role" ~~* '%Lead'::"text")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ((("user_profiles"."role")::"text" = 'admin'::"text") OR ("user_profiles"."general_role" = ANY (ARRAY['lead'::"text", 'subsystem_lead'::"text"])) OR ("user_profiles"."team_role" ~~* '%Lead'::"text"))))));



CREATE POLICY "Roster keys are viewable by everyone" ON "public"."roster_keys" FOR SELECT USING (true);



CREATE POLICY "Rosters are editable by leadership" ON "public"."rosters" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ((("user_profiles"."role")::"text" = 'admin'::"text") OR ("user_profiles"."general_role" = ANY (ARRAY['lead'::"text", 'subsystem_lead'::"text"])) OR ("user_profiles"."team_role" ~~* '%Lead'::"text")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ((("user_profiles"."role")::"text" = 'admin'::"text") OR ("user_profiles"."general_role" = ANY (ARRAY['lead'::"text", 'subsystem_lead'::"text"])) OR ("user_profiles"."team_role" ~~* '%Lead'::"text"))))));



CREATE POLICY "Rosters are viewable by everyone" ON "public"."rosters" FOR SELECT USING (true);



CREATE POLICY "Users can create their own pins" ON "public"."user_budget_pins" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete their own pins" ON "public"."user_budget_pins" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own pins" ON "public"."user_budget_pins" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."build_bom" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "build_bom_delete_authenticated" ON "public"."build_bom" FOR DELETE TO "authenticated" USING (("public"."has_permission"('CREATE_BUILDS'::"text") OR (EXISTS ( SELECT 1
   FROM ("public"."builds" "b"
     JOIN "public"."subsystem_members" "sm" ON (("sm"."subsystem_id" = "b"."subsystem_id")))
  WHERE (("b"."id" = "build_bom"."build_id") AND ("sm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "build_bom_insert_authenticated" ON "public"."build_bom" FOR INSERT TO "authenticated" WITH CHECK (("public"."has_permission"('CREATE_BUILDS'::"text") OR (EXISTS ( SELECT 1
   FROM ("public"."builds" "b"
     JOIN "public"."subsystem_members" "sm" ON (("sm"."subsystem_id" = "b"."subsystem_id")))
  WHERE (("b"."id" = "build_bom"."build_id") AND ("sm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "build_bom_select_authenticated" ON "public"."build_bom" FOR SELECT TO "authenticated" USING (("public"."has_permission"('CREATE_BUILDS'::"text") OR (EXISTS ( SELECT 1
   FROM ("public"."builds" "b"
     JOIN "public"."subsystem_members" "sm" ON (("sm"."subsystem_id" = "b"."subsystem_id")))
  WHERE (("b"."id" = "build_bom"."build_id") AND ("sm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "build_bom_service_all" ON "public"."build_bom" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "build_bom_update_authenticated" ON "public"."build_bom" FOR UPDATE TO "authenticated" USING (("public"."has_permission"('CREATE_BUILDS'::"text") OR (EXISTS ( SELECT 1
   FROM ("public"."builds" "b"
     JOIN "public"."subsystem_members" "sm" ON (("sm"."subsystem_id" = "b"."subsystem_id")))
  WHERE (("b"."id" = "build_bom"."build_id") AND ("sm"."user_id" = "auth"."uid"())))))) WITH CHECK (("public"."has_permission"('CREATE_BUILDS'::"text") OR (EXISTS ( SELECT 1
   FROM ("public"."builds" "b"
     JOIN "public"."subsystem_members" "sm" ON (("sm"."subsystem_id" = "b"."subsystem_id")))
  WHERE (("b"."id" = "build_bom"."build_id") AND ("sm"."user_id" = "auth"."uid"()))))));



ALTER TABLE "public"."builds" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "builds_delete_manage" ON "public"."builds" FOR DELETE TO "authenticated" USING ("public"."has_permission"('CREATE_BUILDS'::"text"));



CREATE POLICY "builds_insert_manage" ON "public"."builds" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_permission"('CREATE_BUILDS'::"text"));



CREATE POLICY "builds_select_authenticated" ON "public"."builds" FOR SELECT TO "authenticated" USING (("public"."has_permission"('CREATE_BUILDS'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."subsystem_members" "sm"
  WHERE (("sm"."subsystem_id" = "builds"."subsystem_id") AND ("sm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "builds_service_all" ON "public"."builds" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "builds_update_manage" ON "public"."builds" FOR UPDATE TO "authenticated" USING (("public"."has_permission"('CREATE_BUILDS'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."subsystem_members" "sm"
  WHERE (("sm"."subsystem_id" = "builds"."subsystem_id") AND ("sm"."user_id" = "auth"."uid"())))))) WITH CHECK (("public"."has_permission"('CREATE_BUILDS'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."subsystem_members" "sm"
  WHERE (("sm"."subsystem_id" = "builds"."subsystem_id") AND ("sm"."user_id" = "auth"."uid"()))))));



ALTER TABLE "public"."cots_stock_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cots_stock_items_delete_authenticated" ON "public"."cots_stock_items" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "cots_stock_items_insert_authenticated" ON "public"."cots_stock_items" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "cots_stock_items_select_authenticated" ON "public"."cots_stock_items" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "cots_stock_items_update_authenticated" ON "public"."cots_stock_items" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."cots_stock_locations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cots_stock_locations_delete_authenticated" ON "public"."cots_stock_locations" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "cots_stock_locations_insert_authenticated" ON "public"."cots_stock_locations" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "cots_stock_locations_select_authenticated" ON "public"."cots_stock_locations" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "cots_stock_locations_update_authenticated" ON "public"."cots_stock_locations" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."kitting" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kitting_bins" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "kitting_bins_delete_authenticated" ON "public"."kitting_bins" FOR DELETE TO "authenticated" USING ("public"."has_permission"('CAN_SEE_ROUTES'::"text"));



CREATE POLICY "kitting_bins_insert_authenticated" ON "public"."kitting_bins" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_permission"('CAN_SEE_ROUTES'::"text"));



CREATE POLICY "kitting_bins_select_authenticated" ON "public"."kitting_bins" FOR SELECT TO "authenticated" USING ("public"."approved_user"());



CREATE POLICY "kitting_bins_service_all" ON "public"."kitting_bins" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "kitting_bins_update_authenticated" ON "public"."kitting_bins" FOR UPDATE TO "authenticated" USING ("public"."has_permission"('CAN_SEE_ROUTES'::"text")) WITH CHECK ("public"."has_permission"('CAN_SEE_ROUTES'::"text"));



CREATE POLICY "kitting_delete_authenticated" ON "public"."kitting" FOR DELETE TO "authenticated" USING ("public"."has_permission"('CAN_SEE_ROUTES'::"text"));



CREATE POLICY "kitting_insert_authenticated" ON "public"."kitting" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_permission"('CAN_SEE_ROUTES'::"text"));



CREATE POLICY "kitting_select_authenticated" ON "public"."kitting" FOR SELECT TO "authenticated" USING ("public"."approved_user"());



CREATE POLICY "kitting_service_all" ON "public"."kitting" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "kitting_update_authenticated" ON "public"."kitting" FOR UPDATE TO "authenticated" USING ("public"."has_permission"('CAN_SEE_ROUTES'::"text")) WITH CHECK ("public"."has_permission"('CAN_SEE_ROUTES'::"text"));



ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "orders_authenticated_manage" ON "public"."orders" TO "authenticated" USING ("public"."has_any_permission"(ARRAY['PLACE_ORDERS_MISC'::"text", 'APPROVE_PURCHASES'::"text"])) WITH CHECK ("public"."has_any_permission"(ARRAY['PLACE_ORDERS_MISC'::"text", 'APPROVE_PURCHASES'::"text"]));



CREATE POLICY "orders_service_all" ON "public"."orders" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."parts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "parts_delete_authenticated" ON "public"."parts" FOR DELETE TO "authenticated" USING ("public"."approved_user"());



CREATE POLICY "parts_insert_authenticated" ON "public"."parts" FOR INSERT TO "authenticated" WITH CHECK ("public"."approved_user"());



CREATE POLICY "parts_select_authenticated" ON "public"."parts" FOR SELECT TO "authenticated" USING ("public"."approved_user"());



CREATE POLICY "parts_service_all" ON "public"."parts" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "parts_update_authenticated" ON "public"."parts" FOR UPDATE TO "authenticated" USING ("public"."approved_user"()) WITH CHECK ("public"."approved_user"());



ALTER TABLE "public"."planner_calendar_rule_recipients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "planner_calendar_rule_recipients_delete_team" ON "public"."planner_calendar_rule_recipients" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_calendar_rule_recipients"."frc_team")))));



CREATE POLICY "planner_calendar_rule_recipients_insert_team" ON "public"."planner_calendar_rule_recipients" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_calendar_rule_recipients"."frc_team")))));



CREATE POLICY "planner_calendar_rule_recipients_select_team" ON "public"."planner_calendar_rule_recipients" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_calendar_rule_recipients"."frc_team")))));



CREATE POLICY "planner_calendar_rule_recipients_update_team" ON "public"."planner_calendar_rule_recipients" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_calendar_rule_recipients"."frc_team"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_calendar_rule_recipients"."frc_team")))));



ALTER TABLE "public"."planner_calendar_rules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "planner_calendar_rules_delete_team" ON "public"."planner_calendar_rules" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_calendar_rules"."frc_team")))));



CREATE POLICY "planner_calendar_rules_insert_team" ON "public"."planner_calendar_rules" FOR INSERT TO "authenticated" WITH CHECK ((("created_by" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_calendar_rules"."frc_team"))))));



CREATE POLICY "planner_calendar_rules_select_team" ON "public"."planner_calendar_rules" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_calendar_rules"."frc_team")))));



CREATE POLICY "planner_calendar_rules_update_team" ON "public"."planner_calendar_rules" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_calendar_rules"."frc_team"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_calendar_rules"."frc_team")))));



ALTER TABLE "public"."planner_dependencies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "planner_dependencies_delete_team" ON "public"."planner_dependencies" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_dependencies"."frc_team")))));



CREATE POLICY "planner_dependencies_insert_team" ON "public"."planner_dependencies" FOR INSERT TO "authenticated" WITH CHECK ((("created_by" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_dependencies"."frc_team"))))));



CREATE POLICY "planner_dependencies_select_team" ON "public"."planner_dependencies" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_dependencies"."frc_team")))));



ALTER TABLE "public"."planner_drive_practice_prompts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."planner_item_owners" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "planner_item_owners_delete_team" ON "public"."planner_item_owners" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_item_owners"."frc_team")))));



CREATE POLICY "planner_item_owners_insert_team" ON "public"."planner_item_owners" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_item_owners"."frc_team")))));



CREATE POLICY "planner_item_owners_select_team" ON "public"."planner_item_owners" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_item_owners"."frc_team")))));



CREATE POLICY "planner_item_owners_update_team" ON "public"."planner_item_owners" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_item_owners"."frc_team"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_item_owners"."frc_team")))));



ALTER TABLE "public"."planner_item_p0_bugs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "planner_item_p0_bugs_delete_team" ON "public"."planner_item_p0_bugs" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_item_p0_bugs"."frc_team")))));



CREATE POLICY "planner_item_p0_bugs_insert_team" ON "public"."planner_item_p0_bugs" FOR INSERT TO "authenticated" WITH CHECK ((("created_by" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_item_p0_bugs"."frc_team"))))));



CREATE POLICY "planner_item_p0_bugs_select_team" ON "public"."planner_item_p0_bugs" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_item_p0_bugs"."frc_team")))));



CREATE POLICY "planner_item_p0_bugs_update_team" ON "public"."planner_item_p0_bugs" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_item_p0_bugs"."frc_team"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_item_p0_bugs"."frc_team")))));



ALTER TABLE "public"."planner_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "planner_items_delete_team" ON "public"."planner_items" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_items"."frc_team")))));



CREATE POLICY "planner_items_insert_team" ON "public"."planner_items" FOR INSERT TO "authenticated" WITH CHECK ((("created_by" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_items"."frc_team"))))));



CREATE POLICY "planner_items_select_team" ON "public"."planner_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_items"."frc_team")))));



CREATE POLICY "planner_items_update_team" ON "public"."planner_items" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_items"."frc_team"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_items"."frc_team")))));



ALTER TABLE "public"."planner_slack_prompts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "planner_slack_prompts_insert_team" ON "public"."planner_slack_prompts" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_slack_prompts"."frc_team")))));



CREATE POLICY "planner_slack_prompts_select_team" ON "public"."planner_slack_prompts" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_slack_prompts"."frc_team")))));



CREATE POLICY "planner_slack_prompts_update_team" ON "public"."planner_slack_prompts" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_slack_prompts"."frc_team"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "planner_slack_prompts"."frc_team")))));



ALTER TABLE "public"."purchasing" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."purchasing_budgets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "purchasing_budgets_delete_authenticated" ON "public"."purchasing_budgets" FOR DELETE TO "authenticated" USING ("public"."has_any_permission"(ARRAY['PLACE_ORDERS_MISC'::"text", 'APPROVE_PURCHASES'::"text", 'EDIT_BUDGETS'::"text"]));



CREATE POLICY "purchasing_budgets_insert_authenticated" ON "public"."purchasing_budgets" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_any_permission"(ARRAY['PLACE_ORDERS_MISC'::"text", 'APPROVE_PURCHASES'::"text", 'EDIT_BUDGETS'::"text"]));



CREATE POLICY "purchasing_budgets_select_authenticated" ON "public"."purchasing_budgets" FOR SELECT TO "authenticated" USING ("public"."has_any_permission"(ARRAY['PLACE_ORDERS_MISC'::"text", 'APPROVE_PURCHASES'::"text", 'EDIT_BUDGETS'::"text"]));



CREATE POLICY "purchasing_budgets_service_all" ON "public"."purchasing_budgets" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "purchasing_budgets_update_authenticated" ON "public"."purchasing_budgets" FOR UPDATE TO "authenticated" USING ("public"."has_any_permission"(ARRAY['PLACE_ORDERS_MISC'::"text", 'APPROVE_PURCHASES'::"text", 'EDIT_BUDGETS'::"text"])) WITH CHECK ("public"."has_any_permission"(ARRAY['PLACE_ORDERS_MISC'::"text", 'APPROVE_PURCHASES'::"text", 'EDIT_BUDGETS'::"text"]));



CREATE POLICY "purchasing_delete_authenticated" ON "public"."purchasing" FOR DELETE TO "authenticated" USING ("public"."has_any_permission"(ARRAY['PLACE_ORDERS_MISC'::"text", 'APPROVE_PURCHASES'::"text"]));



CREATE POLICY "purchasing_insert_authenticated" ON "public"."purchasing" FOR INSERT TO "authenticated" WITH CHECK (("public"."approved_user"() OR "public"."has_any_permission"(ARRAY['PLACE_ORDERS_MISC'::"text", 'APPROVE_PURCHASES'::"text", 'EDIT_BUDGETS'::"text"])));



CREATE POLICY "purchasing_select_authenticated" ON "public"."purchasing" FOR SELECT TO "authenticated" USING (("public"."approved_user"() OR "public"."has_any_permission"(ARRAY['PLACE_ORDERS_MISC'::"text", 'APPROVE_PURCHASES'::"text", 'EDIT_BUDGETS'::"text"])));



CREATE POLICY "purchasing_service_all" ON "public"."purchasing" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "purchasing_update_authenticated" ON "public"."purchasing" FOR UPDATE TO "authenticated" USING ("public"."has_any_permission"(ARRAY['PLACE_ORDERS_MISC'::"text", 'APPROVE_PURCHASES'::"text"])) WITH CHECK ("public"."has_any_permission"(ARRAY['PLACE_ORDERS_MISC'::"text", 'APPROVE_PURCHASES'::"text"]));



ALTER TABLE "public"."roster_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."roster_keys" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rosters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."router_group_parts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "router_group_parts_delete_authenticated" ON "public"."router_group_parts" FOR DELETE TO "authenticated" USING ("public"."has_permission"('CAN_SEE_ROUTES'::"text"));



CREATE POLICY "router_group_parts_insert_authenticated" ON "public"."router_group_parts" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_permission"('CAN_SEE_ROUTES'::"text"));



CREATE POLICY "router_group_parts_select_authenticated" ON "public"."router_group_parts" FOR SELECT TO "authenticated" USING ("public"."approved_user"());



CREATE POLICY "router_group_parts_service_all" ON "public"."router_group_parts" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "router_group_parts_update_authenticated" ON "public"."router_group_parts" FOR UPDATE TO "authenticated" USING ("public"."has_permission"('CAN_SEE_ROUTES'::"text")) WITH CHECK ("public"."has_permission"('CAN_SEE_ROUTES'::"text"));



ALTER TABLE "public"."router_groups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "router_groups_delete_authenticated" ON "public"."router_groups" FOR DELETE TO "authenticated" USING ("public"."has_permission"('CAN_SEE_ROUTES'::"text"));



CREATE POLICY "router_groups_insert_authenticated" ON "public"."router_groups" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_permission"('CAN_SEE_ROUTES'::"text"));



CREATE POLICY "router_groups_select_authenticated" ON "public"."router_groups" FOR SELECT TO "authenticated" USING ("public"."approved_user"());



CREATE POLICY "router_groups_service_all" ON "public"."router_groups" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "router_groups_update_authenticated" ON "public"."router_groups" FOR UPDATE TO "authenticated" USING ("public"."has_permission"('CAN_SEE_ROUTES'::"text")) WITH CHECK ("public"."has_permission"('CAN_SEE_ROUTES'::"text"));



CREATE POLICY "scout_assignments_delete" ON "public"."scout_match_assignments" FOR DELETE TO "authenticated" USING (((("scouting_type" = 'data'::"text") AND "public"."has_permission"('DATA_SCOUT_ADMIN'::"text")) OR (("scouting_type" = 'note'::"text") AND "public"."has_permission"('NOTE_SCOUT_ADMIN'::"text"))));



CREATE POLICY "scout_assignments_insert" ON "public"."scout_match_assignments" FOR INSERT TO "authenticated" WITH CHECK (((("scouting_type" = 'data'::"text") AND "public"."has_permission"('DATA_SCOUT_ADMIN'::"text")) OR (("scouting_type" = 'note'::"text") AND "public"."has_permission"('NOTE_SCOUT_ADMIN'::"text"))));



CREATE POLICY "scout_assignments_select" ON "public"."scout_match_assignments" FOR SELECT TO "authenticated" USING ((("assigned_user" = "auth"."uid"()) OR (("scouting_type" = 'data'::"text") AND "public"."has_permission"('DATA_SCOUT_ADMIN'::"text")) OR (("scouting_type" = 'note'::"text") AND "public"."has_permission"('NOTE_SCOUT_ADMIN'::"text"))));



CREATE POLICY "scout_assignments_service_all" ON "public"."scout_match_assignments" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "scout_assignments_update" ON "public"."scout_match_assignments" FOR UPDATE TO "authenticated" USING (((("scouting_type" = 'data'::"text") AND "public"."has_permission"('DATA_SCOUT_ADMIN'::"text")) OR (("scouting_type" = 'note'::"text") AND "public"."has_permission"('NOTE_SCOUT_ADMIN'::"text")))) WITH CHECK (((("scouting_type" = 'data'::"text") AND "public"."has_permission"('DATA_SCOUT_ADMIN'::"text")) OR (("scouting_type" = 'note'::"text") AND "public"."has_permission"('NOTE_SCOUT_ADMIN'::"text"))));



ALTER TABLE "public"."scout_data_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scout_data_events_delete_admin" ON "public"."scout_data_events" FOR DELETE TO "authenticated" USING ("public"."has_permission"('DATA_SCOUT_ADMIN'::"text"));



CREATE POLICY "scout_data_events_insert_members" ON "public"."scout_data_events" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_any_permission"(ARRAY['DATA_SCOUT_ADMIN'::"text", 'DATA_SCOUT_MEMBER'::"text"]));



CREATE POLICY "scout_data_events_select_members" ON "public"."scout_data_events" FOR SELECT TO "authenticated" USING ("public"."has_any_permission"(ARRAY['DATA_SCOUT_ADMIN'::"text", 'DATA_SCOUT_MEMBER'::"text"]));



CREATE POLICY "scout_data_events_service_all" ON "public"."scout_data_events" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "scout_data_events_update_admin" ON "public"."scout_data_events" FOR UPDATE TO "authenticated" USING ("public"."has_permission"('DATA_SCOUT_ADMIN'::"text")) WITH CHECK ("public"."has_permission"('DATA_SCOUT_ADMIN'::"text"));



ALTER TABLE "public"."scout_flagged_matches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scout_flagged_matches_read_authenticated" ON "public"."scout_flagged_matches" FOR SELECT TO "authenticated" USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "scout_flagged_matches_write_manager" ON "public"."scout_flagged_matches" TO "authenticated" USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND (((COALESCE("up"."role", ''::character varying))::"text" = 'admin'::"text") OR ("lower"(TRIM(BOTH FROM COALESCE("up"."team_role", ''::"text"))) = 'competition lead'::"text") OR ('DATA_SCOUT_ADMIN'::"text" = ANY (COALESCE("up"."permissions", '{}'::"text"[]))) OR ('NOTE_SCOUT_ADMIN'::"text" = ANY (COALESCE("up"."permissions", '{}'::"text"[]))))))))) WITH CHECK ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND (((COALESCE("up"."role", ''::character varying))::"text" = 'admin'::"text") OR ("lower"(TRIM(BOTH FROM COALESCE("up"."team_role", ''::"text"))) = 'competition lead'::"text") OR ('DATA_SCOUT_ADMIN'::"text" = ANY (COALESCE("up"."permissions", '{}'::"text"[]))) OR ('NOTE_SCOUT_ADMIN'::"text" = ANY (COALESCE("up"."permissions", '{}'::"text"[])))))))));



ALTER TABLE "public"."scout_match_assignments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scout_notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scout_notes_delete_authenticated" ON "public"."scout_notes" FOR DELETE TO "authenticated" USING (("public"."has_permission"('NOTE_SCOUT_ADMIN'::"text") OR ("auth"."uid"() = "created_by")));



CREATE POLICY "scout_notes_insert_authenticated" ON "public"."scout_notes" FOR INSERT TO "authenticated" WITH CHECK ("public"."approved_user"());



CREATE POLICY "scout_notes_modify_authenticated" ON "public"."scout_notes" FOR UPDATE TO "authenticated" USING (("public"."has_permission"('NOTE_SCOUT_ADMIN'::"text") OR ("auth"."uid"() = "created_by"))) WITH CHECK (("public"."has_permission"('NOTE_SCOUT_ADMIN'::"text") OR ("auth"."uid"() = "created_by")));



CREATE POLICY "scout_notes_select_authenticated" ON "public"."scout_notes" FOR SELECT TO "authenticated" USING ("public"."approved_user"());



CREATE POLICY "scout_notes_service_all" ON "public"."scout_notes" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "sneakpeek server only photos" ON "public"."sneakpeek_photos" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "sneakpeek server only sessions" ON "public"."sneakpeek_view_sessions" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "sneakpeek server only shares" ON "public"."sneakpeek_shares" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."sneakpeek_photos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sneakpeek_shares" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sneakpeek_view_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subsystem_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subsystem_members_delete_self" ON "public"."subsystem_members" FOR DELETE TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."has_permission"('CREATE_SUBSYSTEMS'::"text")));



CREATE POLICY "subsystem_members_insert_self" ON "public"."subsystem_members" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."uid"() = "user_id") OR "public"."has_permission"('CREATE_SUBSYSTEMS'::"text")));



CREATE POLICY "subsystem_members_select_authenticated" ON "public"."subsystem_members" FOR SELECT TO "authenticated" USING ("public"."approved_user"());



CREATE POLICY "subsystem_members_service_all" ON "public"."subsystem_members" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."subsystems" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subsystems_delete_manage" ON "public"."subsystems" FOR DELETE TO "authenticated" USING (("public"."has_permission"('CREATE_SUBSYSTEMS'::"text") OR ("auth"."uid"() = "lead_user_id")));



CREATE POLICY "subsystems_insert_manage" ON "public"."subsystems" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_permission"('CREATE_SUBSYSTEMS'::"text"));



CREATE POLICY "subsystems_select_authenticated" ON "public"."subsystems" FOR SELECT TO "authenticated" USING ("public"."approved_user"());



CREATE POLICY "subsystems_service_all" ON "public"."subsystems" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "subsystems_update_manage" ON "public"."subsystems" FOR UPDATE TO "authenticated" USING (("public"."has_permission"('CREATE_SUBSYSTEMS'::"text") OR ("auth"."uid"() = "lead_user_id"))) WITH CHECK (("public"."has_permission"('CREATE_SUBSYSTEMS'::"text") OR ("auth"."uid"() = "lead_user_id")));



ALTER TABLE "public"."tasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tasks_delete_team" ON "public"."tasks" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "tasks"."frc_team")))));



CREATE POLICY "tasks_insert_team" ON "public"."tasks" FOR INSERT TO "authenticated" WITH CHECK ((("created_by" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "tasks"."frc_team"))))));



CREATE POLICY "tasks_select_team" ON "public"."tasks" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "tasks"."frc_team")))));



CREATE POLICY "tasks_update_team" ON "public"."tasks" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "tasks"."frc_team"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."frc_team" = "tasks"."frc_team")))));



ALTER TABLE "public"."user_budget_pins" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_profiles_admin_manage" ON "public"."user_profiles" FOR UPDATE TO "authenticated" USING ("public"."has_any_permission"(ARRAY['VIEW_ADMIN_PANEL'::"text", 'EDIT_PERMISSIONS'::"text", 'BAN_USERS'::"text", 'PROMOTE_USERS'::"text", 'APPROVE_USERS'::"text"])) WITH CHECK ("public"."has_any_permission"(ARRAY['VIEW_ADMIN_PANEL'::"text", 'EDIT_PERMISSIONS'::"text", 'BAN_USERS'::"text", 'PROMOTE_USERS'::"text", 'APPROVE_USERS'::"text"]));



CREATE POLICY "user_profiles_delete_admin" ON "public"."user_profiles" FOR DELETE TO "authenticated" USING ("public"."has_any_permission"(ARRAY['BAN_USERS'::"text", 'PROMOTE_USERS'::"text"]));



CREATE POLICY "user_profiles_insert_self" ON "public"."user_profiles" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "user_profiles_select_authenticated" ON "public"."user_profiles" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "id") OR "public"."approved_user"()));



CREATE POLICY "user_profiles_service_all" ON "public"."user_profiles" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "user_profiles_update_self" ON "public"."user_profiles" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "id")) WITH CHECK (("auth"."uid"() = "id"));



ALTER TABLE "public"."vendors" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vendors_delete_authenticated" ON "public"."vendors" FOR DELETE TO "authenticated" USING ("public"."has_permission"('PLACE_ORDERS_MISC'::"text"));



CREATE POLICY "vendors_insert_authenticated" ON "public"."vendors" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_permission"('PLACE_ORDERS_MISC'::"text"));



CREATE POLICY "vendors_select_authenticated" ON "public"."vendors" FOR SELECT TO "authenticated" USING ("public"."approved_user"());



CREATE POLICY "vendors_service_all" ON "public"."vendors" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "vendors_update_authenticated" ON "public"."vendors" FOR UPDATE TO "authenticated" USING ("public"."has_permission"('PLACE_ORDERS_MISC'::"text")) WITH CHECK ("public"."has_permission"('PLACE_ORDERS_MISC'::"text"));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";





GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

















































































































































































GRANT ALL ON FUNCTION "public"."approved_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."approved_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."approved_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_runtime_lease"("lease_key" "text", "lease_seconds" integer, "min_interval_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_runtime_lease"("lease_key" "text", "lease_seconds" integer, "min_interval_seconds" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_runtime_lease"("lease_key" "text", "lease_seconds" integer, "min_interval_seconds" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_runtime_lease"("lease_key" "text", "lease_seconds" integer, "min_interval_seconds" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."cots_stock_items_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."cots_stock_items_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cots_stock_items_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."cots_stock_locations_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."cots_stock_locations_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cots_stock_locations_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."has_any_permission"("required" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."has_any_permission"("required" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_any_permission"("required" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."has_permission"("required" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."has_permission"("required" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_permission"("required" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."invoke_planner_notification_cron"() TO "anon";
GRANT ALL ON FUNCTION "public"."invoke_planner_notification_cron"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."invoke_planner_notification_cron"() TO "service_role";



GRANT ALL ON FUNCTION "public"."log_user_attendance"("p_user_id" "uuid", "p_external_ip" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."log_user_attendance"("p_user_id" "uuid", "p_external_ip" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_user_attendance"("p_user_id" "uuid", "p_external_ip" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."planner_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."planner_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."planner_set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_runtime_lease"("lease_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_runtime_lease"("lease_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."release_runtime_lease"("lease_key" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."release_runtime_lease"("lease_key" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."router_groups_set_name"() TO "anon";
GRANT ALL ON FUNCTION "public"."router_groups_set_name"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."router_groups_set_name"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_onshape_file_format"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_onshape_file_format"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_onshape_file_format"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_purchasing_budget_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_purchasing_budget_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_purchasing_budget_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."tasks_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."tasks_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."tasks_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";
























GRANT ALL ON TABLE "public"."user_attendance_logs" TO "anon";
GRANT ALL ON TABLE "public"."user_attendance_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."user_attendance_logs" TO "service_role";



GRANT ALL ON TABLE "public"."user_profiles" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."user_profiles" TO "authenticated";



GRANT ALL ON TABLE "public"."attendance_leaderboard_30_days" TO "anon";
GRANT ALL ON TABLE "public"."attendance_leaderboard_30_days" TO "authenticated";
GRANT ALL ON TABLE "public"."attendance_leaderboard_30_days" TO "service_role";



GRANT ALL ON TABLE "public"."attendance_locations" TO "anon";
GRANT ALL ON TABLE "public"."attendance_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."attendance_locations" TO "service_role";



GRANT ALL ON SEQUENCE "public"."attendance_locations_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."attendance_locations_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."attendance_locations_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."attendance_schedule_locations" TO "anon";
GRANT ALL ON TABLE "public"."attendance_schedule_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."attendance_schedule_locations" TO "service_role";



GRANT ALL ON TABLE "public"."attendance_schedules" TO "anon";
GRANT ALL ON TABLE "public"."attendance_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."attendance_schedules" TO "service_role";



GRANT ALL ON SEQUENCE "public"."attendance_schedules_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."attendance_schedules_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."attendance_schedules_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."build_bom" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."build_bom" TO "authenticated";



GRANT ALL ON TABLE "public"."builds" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."builds" TO "authenticated";



GRANT ALL ON TABLE "public"."cots_stock_items" TO "anon";
GRANT ALL ON TABLE "public"."cots_stock_items" TO "authenticated";
GRANT ALL ON TABLE "public"."cots_stock_items" TO "service_role";



GRANT ALL ON TABLE "public"."cots_stock_locations" TO "anon";
GRANT ALL ON TABLE "public"."cots_stock_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."cots_stock_locations" TO "service_role";



GRANT ALL ON TABLE "public"."kitting" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."kitting" TO "authenticated";



GRANT ALL ON TABLE "public"."kitting_bins" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."kitting_bins" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."kitting_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."kitting_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."kitting_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."orders" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."orders" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."orders_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."orders_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."orders_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."parts" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."parts" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."parts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."parts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."parts_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."pit_scout_entries" TO "anon";
GRANT ALL ON TABLE "public"."pit_scout_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."pit_scout_entries" TO "service_role";



GRANT ALL ON SEQUENCE "public"."pit_scout_entries_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."pit_scout_entries_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."pit_scout_entries_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."planner_calendar_rule_recipients" TO "anon";
GRANT ALL ON TABLE "public"."planner_calendar_rule_recipients" TO "authenticated";
GRANT ALL ON TABLE "public"."planner_calendar_rule_recipients" TO "service_role";



GRANT ALL ON TABLE "public"."planner_calendar_rules" TO "anon";
GRANT ALL ON TABLE "public"."planner_calendar_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."planner_calendar_rules" TO "service_role";



GRANT ALL ON TABLE "public"."planner_dependencies" TO "anon";
GRANT ALL ON TABLE "public"."planner_dependencies" TO "authenticated";
GRANT ALL ON TABLE "public"."planner_dependencies" TO "service_role";



GRANT ALL ON TABLE "public"."planner_drive_practice_prompts" TO "anon";
GRANT ALL ON TABLE "public"."planner_drive_practice_prompts" TO "authenticated";
GRANT ALL ON TABLE "public"."planner_drive_practice_prompts" TO "service_role";



GRANT ALL ON TABLE "public"."planner_item_owners" TO "anon";
GRANT ALL ON TABLE "public"."planner_item_owners" TO "authenticated";
GRANT ALL ON TABLE "public"."planner_item_owners" TO "service_role";



GRANT ALL ON TABLE "public"."planner_item_p0_bugs" TO "anon";
GRANT ALL ON TABLE "public"."planner_item_p0_bugs" TO "authenticated";
GRANT ALL ON TABLE "public"."planner_item_p0_bugs" TO "service_role";



GRANT ALL ON TABLE "public"."planner_items" TO "anon";
GRANT ALL ON TABLE "public"."planner_items" TO "authenticated";
GRANT ALL ON TABLE "public"."planner_items" TO "service_role";



GRANT ALL ON TABLE "public"."planner_slack_prompts" TO "anon";
GRANT ALL ON TABLE "public"."planner_slack_prompts" TO "authenticated";
GRANT ALL ON TABLE "public"."planner_slack_prompts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."purchasing_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."purchasing_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."purchasing_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."purchasing" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."purchasing" TO "authenticated";



GRANT ALL ON TABLE "public"."purchasing_budgets" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."purchasing_budgets" TO "authenticated";



GRANT ALL ON TABLE "public"."roster_entries" TO "anon";
GRANT ALL ON TABLE "public"."roster_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."roster_entries" TO "service_role";



GRANT ALL ON TABLE "public"."roster_keys" TO "anon";
GRANT ALL ON TABLE "public"."roster_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."roster_keys" TO "service_role";



GRANT ALL ON TABLE "public"."rosters" TO "anon";
GRANT ALL ON TABLE "public"."rosters" TO "authenticated";
GRANT ALL ON TABLE "public"."rosters" TO "service_role";



GRANT ALL ON TABLE "public"."router_group_parts" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."router_group_parts" TO "authenticated";



GRANT ALL ON TABLE "public"."router_groups" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."router_groups" TO "authenticated";



GRANT ALL ON TABLE "public"."runtime_leases" TO "anon";
GRANT ALL ON TABLE "public"."runtime_leases" TO "authenticated";
GRANT ALL ON TABLE "public"."runtime_leases" TO "service_role";



GRANT ALL ON TABLE "public"."scout_data_events" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."scout_data_events" TO "authenticated";



GRANT ALL ON TABLE "public"."scout_flagged_matches" TO "authenticated";
GRANT ALL ON TABLE "public"."scout_flagged_matches" TO "service_role";



GRANT ALL ON SEQUENCE "public"."scout_flagged_matches_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."scout_flagged_matches_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."scout_flagged_matches_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."scout_match_assignments" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."scout_match_assignments" TO "authenticated";



GRANT ALL ON TABLE "public"."scout_notes" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."scout_notes" TO "authenticated";



GRANT ALL ON TABLE "public"."scouting_settings" TO "anon";
GRANT ALL ON TABLE "public"."scouting_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."scouting_settings" TO "service_role";



GRANT ALL ON TABLE "public"."sneakpeek_photos" TO "anon";
GRANT ALL ON TABLE "public"."sneakpeek_photos" TO "authenticated";
GRANT ALL ON TABLE "public"."sneakpeek_photos" TO "service_role";



GRANT ALL ON TABLE "public"."sneakpeek_shares" TO "anon";
GRANT ALL ON TABLE "public"."sneakpeek_shares" TO "authenticated";
GRANT ALL ON TABLE "public"."sneakpeek_shares" TO "service_role";



GRANT ALL ON TABLE "public"."sneakpeek_view_sessions" TO "anon";
GRANT ALL ON TABLE "public"."sneakpeek_view_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."sneakpeek_view_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."subsystem_members" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."subsystem_members" TO "authenticated";



GRANT ALL ON TABLE "public"."subsystems" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."subsystems" TO "authenticated";



GRANT ALL ON TABLE "public"."tasks" TO "anon";
GRANT ALL ON TABLE "public"."tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."tasks" TO "service_role";



GRANT ALL ON SEQUENCE "public"."user_attendance_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."user_attendance_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."user_attendance_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."user_budget_pins" TO "anon";
GRANT ALL ON TABLE "public"."user_budget_pins" TO "authenticated";
GRANT ALL ON TABLE "public"."user_budget_pins" TO "service_role";



GRANT ALL ON TABLE "public"."user_notification_logs" TO "anon";
GRANT ALL ON TABLE "public"."user_notification_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."user_notification_logs" TO "service_role";



GRANT ALL ON TABLE "public"."vendors" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."vendors" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."vendors_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."vendors_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."vendors_id_seq" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "service_role";




























