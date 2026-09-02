-- Rapid traverse rate per machine, for the run-time estimate.
--
-- estimateMachiningTime() times G00 moves at a rapidRate that nothing ever
-- overrides, so every job - router or lathe - is estimated at 200 in/min.
-- Rapid rate is a per-machine property and the spread is large, so on a
-- retract-heavy program the estimate is wrong in a machine-dependent
-- direction while being presented as a plain number.
--
-- Nullable with no default on purpose: NULL means "nobody has entered this
-- machine's real figure yet", which the UI can say out loud, rather than
-- looking like a configured value. The estimator keeps its own 200 in/min
-- fallback for that case, so nothing changes until a real number is set.
alter table cam_machines add column if not exists rapid_rate numeric;

comment on column cam_machines.rapid_rate is
  'Rapid traverse in in/min, used to time G00 moves in the run-time estimate. NULL = not measured yet; the estimator falls back to a conservative default and says so.';
