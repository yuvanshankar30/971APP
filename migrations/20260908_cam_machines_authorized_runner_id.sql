-- Direct instruction: a job queued for a specific machine (e.g. "New
-- Router") must not be claimable by a Runner running on a different
-- physical computer than the one actually connected to it. Nothing
-- previously stopped two different laptops from both configuring
-- RUNNER_MACHINE_ID to the same cam_machines row - whichever polled first
-- won the claim, even if it wasn't the computer wired to the real machine.
-- NULL (the default) means "no restriction" - every existing machine keeps
-- working exactly as it does today until an admin explicitly locks one down
-- via the Machines settings UI.
ALTER TABLE public.cam_machines
  ADD COLUMN IF NOT EXISTS authorized_runner_id text;
