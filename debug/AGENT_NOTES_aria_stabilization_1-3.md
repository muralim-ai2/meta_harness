# ARIA Stabilization – Agent Working Notes (Issues 1–3)

Source: Dan Goldman's feedback in the "ARIA Stabilization and Collab" chat, Nov 7–8, 2026.
Scope: the three blocking issues only. Fix in order. Keep each fix in its own commit/PR so they can be reviewed and reverted independently.

General rules for any agent working these items
- Reproduce before changing anything. Capture the exact log/traceback in the PR description.
- No behaviour changes outside the files named below without calling it out explicitly.
- Add or extend a test for every fix. A fix without a regression test is not done.
- Do not alter the harness lifecycle semantics (which gates run, in what order) – only how much data each gate loads and how failures are handled.

---

## Issue 1 – Gate validation token overflow (>1M tokens)

### Symptom
Stop hook fails during lifecycle validation. Observed context size: 1,013,345 tokens. The gate call bundles plan.md, all evidence files, the deliverable templates (PRD / TDS / TEST-STRATEGY), lifecycle metadata and the model context into a single prompt, which exceeds the model's context window on larger projects.

### Where to look
- `lifecycle.py` – gate validation entry point and how evidence/templates are assembled into the gate prompt.
- Whatever helper builds the evidence payload for a gate (look for where evidence file contents are read and concatenated).
- The stop hook that invokes gate validation.

### Root cause (working hypothesis)
Gate validation is monolithic and content-inclusive: every gate re-reads and re-inlines all evidence, regardless of whether that evidence was already validated at an earlier gate. Payload size therefore grows linearly with project size and number of gates.

### Suggested approach (in priority order)
1. Partition gate validation per deliverable
   - Split the single gate call into one call per deliverable (PRD, TDS, TEST-STRATEGY, …), each loading only the template and evidence relevant to that deliverable.
   - Aggregate the per-deliverable results into the existing gate pass/fail result so downstream code is unchanged.
2. Evidence fingerprinting for gates after the first
   - For evidence already validated at an earlier gate, pass `{path, sha256, size, validated_at_gate}` instead of full content.
   - Only inline full content for evidence that is new or whose hash changed since the last gate.
   - Store fingerprints in lifecycle metadata so they survive across sessions.
3. `--evidence-limit <N>` flag (opt-in)
   - Cap the number of feature/evidence checks loaded per gate. Default = unlimited (current behaviour) so nothing changes for existing users.
   - When the cap trims evidence, log which items were skipped so it's visible in Mission Control / logs.
4. Defensive token budget
   - Estimate token count before the model call. If over budget, fail fast with a clear message ("gate payload N tokens exceeds limit M; try --evidence-limit or per-deliverable mode") instead of letting the provider reject it.

### Acceptance
- A project that previously failed at ~1M tokens completes gate validation.
- Per-gate payload size is logged and visibly smaller on gates 2+.
- Existing gate tests pass unchanged; new tests cover partitioning, fingerprint reuse, hash-change re-inlining, and the limit flag.

---

## Issue 2 – Post-Tool Use Hook: `KeyError: 'tool_result'`

### Symptom
`agent_compat.py`, function `to_vscode`, around line 50, raises `KeyError: 'tool_result'`. Six identical tracebacks in one session – it fires on every tool-use event whose payload doesn't carry that key, so it is noisy and may be masking other hook output.

### Where to look
- `agent_compat.py` → `to_vscode`.
- The post-tool-use hook that calls `to_vscode` and the schema of the payload it receives.
- Any other `payload["..."]` direct indexing in the same module – this is likely not the only fragile key.

### Root cause (working hypothesis)
The hook assumes every tool-use event has a `tool_result`. Some events (tool start, tool error, streamed/partial results, or events from a different agent surface) don't, so direct dict indexing throws.

### Suggested approach
1. Make payload access defensive
   - `payload.get("tool_result")` with an explicit `None`/empty fallback; branch on presence rather than assuming it.
   - Audit the rest of `to_vscode` for other hard `[]` lookups and treat them the same way.
2. Normalise the event first
   - Introduce a small normaliser (or a typed dataclass) that converts incoming hook payloads to a known shape with all expected fields present (possibly `None`). `to_vscode` then only ever sees the normalised shape.
3. Never let a hook crash the session
   - Wrap the hook body in try/except, log once with the offending payload keys (not the full payload – may be large/sensitive), and continue. A hook failure should degrade output, not abort the run.
4. Find out *why* `tool_result` is missing
   - Log the event type / source for the failing payloads. If it's a legitimate event class (e.g. tool-start), handle it intentionally rather than just swallowing it.

### Acceptance
- No `KeyError` in a full session run that previously produced six.
- Unit tests: payload with `tool_result`, without it, with `tool_result=None`, and with an unexpected extra shape – all handled without raising.
- Hook logs at most one warning per distinct missing-key pattern per session.

---

## Issue 3 – Mission Control not reflecting live activity

### Symptom
Mission Control shows no active activity while an analysis is actively running in the chat session. The UI reads as idle when the harness is busy.

### Where to look
- The Mission Control "Live" / activity feed data source – whatever file/socket/state it polls or subscribes to.
- The emitters: where the harness writes activity events (tool calls, turns, agent/sub-agent starts, council engagements).
- Session identity: how Mission Control decides *which* session to display.

### Root cause (candidates – confirm before fixing)
- Session mismatch: MC is bound to a different session ID than the one running in chat (e.g. after a restart, a new workspace, or multiple VS Code windows).
- Events are emitted but not flushed (buffered writes only land at session end).
- The activity feed only subscribes to a subset of event types and the running analysis emits types it ignores.
- Hook failures (see Issue 2) are preventing activity events from being written at all – fix Issue 2 first and re-test this one.

### Suggested approach
1. Instrument first
   - Add a debug log on both sides: "event emitted (type, session_id)" and "event received by MC (type, session_id)". Compare during a live run. This will usually pinpoint the break in one pass.
2. Fix the most likely break
   - If session IDs differ → have MC follow the active chat session (or expose a session picker and default to most-recent-active).
   - If events aren't flushed → flush on every write, or move to an append-only event log MC can tail.
   - If event types are filtered → include all lifecycle/tool/agent events in Live; filter in the UI, not at ingestion.
3. Add a liveness indicator
   - Show "last event received: Xs ago" in MC so a stale feed is obvious to the user instead of silently looking idle.
4. Re-verify after Issue 2 lands
   - Re-run the same analysis and confirm Live updates in real time.

### Acceptance
- Starting an analysis in chat produces visible activity in Mission Control within a few seconds and continues to update until completion.
- Opening MC mid-run shows the in-progress session, not idle.
- Debug instrumentation can be left in at debug level.

---

## Order of work
1. Issue 2 (small, isolated, may be a hidden cause of Issue 3)
2. Issue 1 (largest change, highest user impact)
3. Issue 3 (re-test after 2; then fix remaining gap)

Report back with: repro steps, root cause confirmed vs hypothesised, files touched, tests added, before/after evidence (token counts, log excerpts, screenshot of MC live).
