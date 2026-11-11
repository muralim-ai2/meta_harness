# ARIA update: 0.26.1 to 0.27.5

**Date:** 9 November 2026
**Build to install:** `extension/aria-0.27.5.vsix`
**Branch:** `aria-rebrand`, committed locally and not pushed yet

## Summary

This update does two things. It fixes every blocking issue raised during stabilization, and it makes Mission Control clearer about what the agent is doing and what it needs from you.

What you will notice:

- **Nothing blocks a delivery any more.**
  - An ARIA hook that fails, for any reason, is now skipped and logged. It is never turned into a denial (0.27.5).
  - A hook crash used to stop the agent from editing files. That is fixed.
  - The push check used to stop PR closeout. It now asks you to confirm instead.
- **Mission Control shows what is really happening.**
  - It follows the chat that is working on the active ask.
  - It tells you when a step is waiting for your **Allow** in Chat.
  - Your decisions (Accept, Request changes, Mark done) no longer fail while the agent is busy.
- **You can steer the work from Mission Control.**
  - Request changes on the Plan tab sends your request to the agent in Chat.
  - You can add a skill to an ask.
  - Each task links to the files it changed and opens its commits as a diff.
- **Skill numbers now mean what they say.** Skills & packs and Telemetry count skills the same way, and they explain the difference between skills allowed and skills used.

## How to install

1. In VS Code, open **Extensions**, then **...**, then **Install from VSIX...**, and choose `extension/aria-0.27.5.vsix`.
2. Reload the window when VS Code asks you to.
3. If you use ARIA from Copilot CLI, Claude Code, Cursor or Codex, run **Install for other tools** again from Mission Control > Settings. Those copies of the runtime do not update themselves.

## Release timeline

| Version | Main change |
|---|---|
| 0.26.2 | Copilot hook crash fixed; Mission Control follows the chat that is working |
| 0.26.3 | `apply_patch` hook crash fixed; pushes ask you to confirm instead of blocking; files to review are clickable links |
| 0.27.0 | Add a skill from Skills & packs; tasks link to their changes; project folder tree in the sidebar; hover only on clickable elements |
| 0.27.1 | Now shows steps waiting for your Allow; decisions no longer fail while an agent works |
| 0.27.2 | With an ask open, the agent loads only the ask's skills; skill counts show skills actually read |
| 0.27.3 | Request changes goes to the agent in Chat |
| 0.27.4 | Live follows the active ask's latest chat; old unanswered requests no longer show as waiting |
| 0.27.5 | A failing hook never blocks: it is skipped, logged to `.aria/runs/hook-errors.log` and shown in Mission Control |

## 1. Stabilization fixes

### 1.1 Hook crash on Copilot tool results (0.26.2)

- **Symptom:** every tool call failed with `KeyError: 'tool_result'` in `agent_compat.py`.
- **Cause:** VS Code's Copilot runs the same hook file as Copilot CLI, but it sends tool results in a different field (`tool_response` instead of `tool_result`).
- **Fix:** the adapter now reads both. Any other format stops with a clear message that names the fields it received.

### 1.2 `loop_guard` crash on `apply_patch` edits (0.26.3)

- **Symptom:** edits made with `apply_patch` were denied with "Denied by preToolUse hook (hook errored)". This is what hit Dan's ask.
- **Cause:** Copilot CLI sends the patch as plain text, and the guard expected an object. The guard crashed before it checked any rule, and Copilot treats a crashed hook as a "deny".
- **Fix:**
  - Both the adapter and the guard now read the patch text.
  - The guard finds every file the patch adds, updates, deletes or moves, and checks each against the protected-file rules.
  - This fixed the `apply_patch` case only. Other crashes could still become denials until 0.27.5 (see 1.7).

### 1.3 Push gate blocked PR closeout (0.26.3)

- **Symptom:** "git push is only allowed for GitHub review loops". The PR queue was empty because the branch was recorded under local review. The work-around was to push by hand.
- **Fix:** the guard never blocks a push now. It asks you to confirm.
  - The confirmation says why it is asking: a force push, an unticked branch, or local review.
  - It links the files behind that reason: the loop state, the tick list and the PR record.
  - The PR queue now also lists branches recorded under local review, and the `pr-push` skill opens those as draft PRs.
  - "Scope creep" is now a warning for the reviewer, never a reason to drop a branch.
- **Behaviour differs by tool:**
  - VS Code, Copilot CLI and Claude Code show a confirmation prompt.
  - Codex shows the message as a warning.
  - Cursor accepts the confirmation but does not enforce it yet, so the push goes ahead.
  - The Copilot cloud agent treats a confirmation as a refusal, because no one is there to answer.

### 1.4 Mission Control looked idle while the agent worked (0.26.2, 0.27.1, 0.27.4)

Three separate causes:

1. **The working chat wasn't shown.** A chat that only read and analysed files was never linked to the ask, so Live showed an older, idle chat instead. Live now follows the active ask's most recently active chat.
2. **A pick never expired.** If you picked an older chat, Live stayed on it forever. Now a pick lasts only until another chat of the ask has newer activity.
3. **Waiting for Allow wasn't visible.** Copilot only records a command once it starts running, so a command waiting for your **Allow** was invisible and the screen said "Thinking".
   - The Now card now says **"Waiting for you to allow a step in Chat"** and names the command.
   - Needs you has an **Open chat** button that takes you to that chat.
   - A request left unanswered for more than an hour no longer counts as waiting.
   - Between steps, Now names the last step ("After: Edited index.html") instead of a bare "Thinking".

### 1.5 Decisions failed with "Workspace state changed" (0.27.1)

- **Symptom:** Request changes, Accept, Mark done or Add a skill failed with "Workspace state changed" while the agent was working.
- **Cause:** each decision was checked against a fingerprint of the whole workspace. A busy agent rewrites evidence and loop files every few seconds, so the check almost always failed.
- **Fix:** each decision is now checked only against the item you acted on: its ask, status, sign-off and the plan. The agent's other writes no longer get in the way. Accepting is still strict: the work must be finished and the plan in sync when your decision is recorded.

### 1.6 Gate validation over 1M tokens: not in this codebase

We checked this and found no gate that sends the plan, evidence and templates to a model in this codebase. Stage gates and Stop hooks are fixed rule checks with short messages, and the evaluation sends only a list of file names. The overflow must come from code added in the forked repository, so the fix belongs there.

### 1.7 Hooks never block when they fail (0.27.5)

- **Symptom:** read-only commands such as `gh pr view 54 ... && git status --short --branch` were denied with "Denied by preToolUse hook (hook errored)".
- **Cause:**
  - Copilot CLI sometimes sends a tool's arguments as JSON text instead of an object. The guard read that text as a patch, then crashed looking for the command.
  - Copilot CLI treats any crashed hook as a "deny". So a fault in ARIA's own guard became a block on the agent, which is the opposite of what a guard is for.
- **Fix:**
  - Arguments sent as JSON text are now read as the object they encode.
  - More importantly, every ARIA hook now runs inside a safety net. If a guard fails, whatever the reason (a bug, a missing file, an unexpected input or an old runtime), the tool call goes ahead and the failure is surfaced instead:
    - the full error is written to `.aria/runs/hook-errors.log`;
    - Mission Control shows it as a guard event: "loop guard hook_error ... Nothing was blocked";
    - Claude Code and Codex show a warning, and every client where the hook can add agent context (for example after a tool call) tells the agent to mention it.
  - Real guard decisions are unchanged: protected loop files, git-hook bypass and escalation stops are still enforced, and pushes still ask you to confirm.
- **About "git push is only allowed for GitHub review loops":** that message comes from the runtime before 0.26.3. Copilot CLI uses its own copy of the runtime in `~/.aria/runtime`, so after installing this build, run **Install for other tools** (or the Copilot export) again.
- **If anything still looks wrong,** send us `.aria/runs/hook-errors.log`. It records the exact input and error for every failed hook run.

## 2. Skills: why the numbers differed, and what changed

### Why the two tabs showed different numbers

- **Skills & packs** showed the skills **chosen for the ask**. These are picked once, when the ask is created, by ranking the request against the skill library, and stored in the ask's contract and plan.
- **Telemetry** showed the skills **used in the chat**. Before 0.27.2 it took the larger of two counts: skills the agent actually read, or skills the hook had allowed for that chat.

### The skill limit is a guideline, not a hard cap

- The loadout guideline is **10 skills or 32,000 tokens**. It is advisory.
- When an ask's skills go over it, nothing is removed. The ask is flagged, the agent scores the shortlist, and you choose: the suggested set, all of them, or named skills.
- In practice an agent can work with more skills than the guideline:
  - all of an ask's skills stay allowed even when they are over the guideline;
  - the always-on harness skills (for example `wow-uplift` or `feature-checklist`) are outside the budget altogether.
- The hook does block library skills that are not on the ask's list. That block can be lifted for the session after repeated hits.

### What was wrong and what changed (0.27.2)

- **Unrelated skills were pulled in.** Until you made the suggested/all/named choice, the hook re-ranked every chat message against the whole library. One message mentioning "references" and "constraints" added 16 architecture skills: 18 in total, against an ask that had 2. Now, while an ask is open, the agent is allowed exactly the ask's skills plus the current stage's skills, whatever the wording of your message. Ranking by message only happens when no ask is open.
- **"Used" now means read.** A skill counts as used only when the agent actually opens it. Before, every allowed skill was marked as used straight away.
- **The tabs now agree.**
  - **Telemetry, "Skills used":** skills this chat actually read, with the number allowed shown next to it.
  - **Telemetry, "Skill tokens":** the size of the skill files actually read.
  - **Skills & packs:** the ask's skills, each marked "read in this chat" when it was read, with the line "Chat on Live: N skills read of M allowed". Reasons are in plain words; for example, "keyword" now reads "matches words in your request".

### Add a skill to an ask (0.27.0)

- **Skills & packs, Add a skill...** lists the library and expertise-pack skills the ask does not have yet. Pick one and confirm; the confirmation shows the new token total.
- The skill is installed, listed in the ask's plan, and recorded as a decision. Agents load it from your next message.
- The same is available from chat: `lifecycle.py skills available` and `lifecycle.py skills add <name>`.

## 3. Plan tab: Request changes now goes to the agent (0.27.3)

**Before:** Request changes only saved a note in the ask's contract. The agent was not told, and the stage still showed "Done and ready" with Accept enabled.

**Now:**

1. **Request changes** asks one question: "What should change in stage:deliver?"
2. When you confirm, Mission Control:
   - records your request against the stage;
   - sets a finished stage back to **active**, so Accept stays off until the agent has made the changes;
   - opens the ask's own chat (or a new chat linked to the ask) with the ask's agent, and attaches the ask's request and plan.
3. **Your request is filled into the chat message but not sent.** You press Enter to send it, and you can add detail or files first.
4. The message tells the agent to:
   - make the change;
   - if the plan changes (for example, a new stage), update `plan.md`, run `lifecycle.py plan-sync` and log the decision;
   - mark the stage done again and link the files you should review.
5. The Plan tab tracks where it stands: "Your change request went to the agent in Chat", then "Done again after your change request: review it again". Accept turns back on at that point.

### Example: ARIA Lite, "hello app"

We sent the request *"add a planning stage; make a complete plan only and update the plan.md to create 3 more features where I can click and say bye or hello in different languages - Spanish, Tamil, English"* from the Plan tab. ARIA Lite then rewrote `plan.md` as **"Plan: hello app, round 2"**, which:

- quotes the change request and states that this revision is a plan only: no code, checks or loop files change until you approve it;
- lays out three stages:

| Stage | Status | Gate |
|---|---|---|
| 1. deliver, round 1 | done | 3/3 checks pass; 11/11 review findings fixed |
| 2. plan, round 2 (new) | done (this document) | you approve this plan |
| 3. deliver, round 2 | waits for stage 2 approval | 6/6 checks pass (3 new + 3 regression); screenshots for each language |

- records the new planning stage as a plan revision (`lifecycle.py plan-sync`).

**Limitation:** the lifecycle has no command to add a new stage to an ask's contract. The agent therefore recorded the planning stage in `plan.md` and in the plan's revision history, and round 2 runs inside the existing `deliver` stage. Adding a stage to the contract itself would be a future enhancement.

## 4. Files to review are clickable everywhere (0.26.3, 0.27.0)

- **In chat:** all eight ARIA orchestrator agents now link every file you should look at whenever they ask you to review, sign off or decide. Loop escalations and push confirmations also link their files.
- **In Mission Control:** files named in a waiting question, a guard alert or a sign-off item open with one click: from Needs you, the Now card, the activity list and the Plan tab.
- **Plan tasks lead to their work:**
  - each feature task links the files its commits changed;
  - **Show changes (base..head)** opens those commits in VS Code's multi-file diff editor, including added and deleted files.
- **Project files in the sidebar:** the sidebar now ends with the whole workspace folder as a tree.
  - It leaves out `.git` and `node_modules`, and stops at 400 entries and 10 folders deep (it says so when it is cut).
  - Folders start closed; any file in it opens with one click.

## 5. Smaller improvements

- **Hover highlights:** only clickable elements highlight now.
  - The Telemetry tiles for turns, tool calls and chat tokens open Live with the matching filter; the skill tiles open Skills & packs.
  - Tiles that go nowhere (thinking and cache tokens), and the empty ask card, no longer highlight.
- **Skills & packs layout:** each skill shows its name, a "read in this chat" mark and its status on one line, with the reason and tokens below. Rows no longer break across four lines in narrow panels.
- **Code housekeeping:** the ask's skill functions moved into a new module, `tools/loop/ask_skills.py`. This keeps `lifecycle.py` under the project's 500-line limit.

## 6. Quality and testing

- **Every fix and feature has a regression test,** and each is a separate commit.
- **Mission Control (JavaScript):** 141 of 141 tests pass, and the type check is clean.
- **Harness (Python):** the last full run (0.27.0) gave 127 passed and 2 failed. Both failures are local to this machine and were already failing before this work:
  - `test_map` is affected by an old configuration gap (`mod:.`) and by the untracked `debug/` folder;
  - `test_prototype_check` depends on the local headless browser saving a screenshot.

  The suites affected by each later change were rerun and passed.

## 7. Known limitations and next steps

- **Adding a stage to an ask** is only recorded in the plan; the lifecycle has no command to add it to the contract yet.
- **Push confirmation in Cursor and Codex** depends on those tools' hook support. Cursor does not enforce it yet; Codex shows it as a warning.
- **Gate overflow (1.6)** needs to be fixed in the forked repository.
- **Nothing has been pushed.** All commits are local on `aria-rebrand`, ready to push and open as PRs once you approve.
