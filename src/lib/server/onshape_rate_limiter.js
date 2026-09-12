// Onshape enforces a hard annual API call quota and returns HTTP 402 once
// exceeded (see onshape_cache.js for the incident this was added alongside).
// The response cache stops *repeat* requests for the same resource, but does
// nothing for a burst of *distinct* requests - several subsystem pages
// loading their timeline/BOM at once within the same Cloud Run instance can
// still fire a stack of Onshape calls back-to-back. This queues them behind
// a minimum spacing so that burst gets smoothed into a steady rate instead
// of firing all at once and finding out only after several come back 402.
//
// Process-local (like the cache) - resets on redeploy/new instance, and each
// Cloud Run instance enforces its own limit rather than sharing one across
// instances. That's fine here: the goal is smoothing a single instance's own
// bursts, not enforcing Onshape's account-wide quota precisely.
const MIN_INTERVAL_MS = 200; // caps this instance at ~5 Onshape requests/sec

let queueTail = Promise.resolve();
let lastRequestAt = 0;

export function scheduleOnshapeRequest(fn) {
  const scheduled = queueTail.then(async () => {
    const wait = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return fn();
  });

  // Advance the queue regardless of whether this request succeeds - a
  // rejection here must never wedge the queue for every request behind it.
  queueTail = scheduled.then(() => {}, () => {});

  return scheduled;
}
