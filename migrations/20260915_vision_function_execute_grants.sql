-- Vision's release bridge and cron invoker are SECURITY DEFINER functions.
-- PostgreSQL grants EXECUTE to PUBLIC on new functions unless told otherwise,
-- which exposed both through PostgREST RPC and bypassed the web API's gates.

REVOKE ALL ON FUNCTION public.release_vision_run(uuid, uuid, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_vision_run(uuid, uuid, jsonb, integer) FROM anon;
REVOKE ALL ON FUNCTION public.release_vision_run(uuid, uuid, jsonb, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_vision_run(uuid, uuid, jsonb, integer) TO service_role;

-- pg_cron invokes this as the database owner. Browser and API roles never
-- need to call it directly.
REVOKE ALL ON FUNCTION public.invoke_vision_runner_health_cron() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_vision_runner_health_cron() FROM anon;
REVOKE ALL ON FUNCTION public.invoke_vision_runner_health_cron() FROM authenticated;
