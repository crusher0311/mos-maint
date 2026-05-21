// Isolation-test mirror of /api/callbacks/protractor.
//
// Created 2026-05-21 to diagnose system-wide Protractor webhook silence
// (last real callback: 2026-05-15 00:42 UTC). Our endpoint is verified
// healthy (test probes land, cert valid, route returns 200). Darren has
// ruled out manual pause and circuit breaker on Protractor's side.
//
// Remaining hypothesis: long-tail backoff or per-URL state on their
// delivery worker for the original URL. This new path is "clean" —
// no history with their worker. If a real WO change in shop 29 lands
// here but the original URL stays silent, we've proven the silence is
// per-URL state. If this URL is ALSO silent, the problem is deeper.
//
// Behavior is identical to the original — we just re-export the GET
// and POST handlers so there is zero risk of logic divergence.
export { GET, POST } from "../protractor/route";
