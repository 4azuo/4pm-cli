---
description: Autonomous cycle — pull a request from USER_TODO, do ONE small approved task, test it, merge into ${ai_dev_branch}$. (The token gate is checked by autonomous-tick.sh BEFORE Claude is invoked.)
allowed-tools: Bash(*), Read(*), Edit(*), Write(*), Glob(*), Grep(*)
---

# /auto-cycle — one autonomous work cycle

You are running **unattended** (headless, triggered by cron every ~10 min via
`.claude/hooks/autonomous-tick.sh`). Do **exactly one full cycle** with the steps below, then **stop**.
The integration branch is named **`${ai_dev_branch}$`** (the placeholder is resolved at runtime — see
`AI_PLACEHOLDER.md`); a task branch is **merged straight into `${ai_dev_branch}$`** (no PR).

> Survival rule: **each cycle does exactly ONE small task** to avoid running out of tokens mid-way. If a
> step fails, log it in `AI_DONE.md` under "Incidents", **clean the lock (Step 8)**, then stop — don't
> push on.
>
> **Lock (`.claude/.autonomous.lock`):** whether the cycle ends normally or on error, you MUST delete
> the lock file before stopping so the next cron tick isn't blocked by a stale lock (Step 8) —
> mandatory, even on an early error exit.
>
> **Token gate:** the quota check (session/weekly) moved to the `autonomous-tick.sh` wrapper — it runs
> first and only invokes Claude when quota is sufficient. So by the time `/auto-cycle` starts, the gate
> has already passed; don't re-check at the top.
>
> **Books & templates (MUST compare):** the 5 book files at the repo root — `USER_TODO.md`,
> `AI_TODO.md`, `AI_PROGRESS.md`, `AI_DONE.md`, `USER_QA.md` — have canonical templates in
> `.claude/templates/` (`<NAME>.empty.md` = EMPTY state, `<NAME>.sample.md` = example WITH DATA; see
> `.claude/templates/README.md`). Rules:
> - **Is a file empty / has work?** → compare against `<NAME>.empty.md` (empty ⇔ equal to the empty
>   template after trimming trailing whitespace + leading/trailing blank lines). Don't guess by skimming.
> - **When clearing / resetting** a file → overwrite with the **exact** `<NAME>.empty.md`
>   (`cp .claude/templates/<NAME>.empty.md <NAME>`). The tick's "has work" gate relies on this match.
> - **When adding data** → keep the header/blockquote, fill in per `<NAME>.sample.md`.
>
> **Language:** write books/docs/code in the language the project's `CLAUDE.md` specifies (default
> English). Don't switch languages on your own.

---

## Step 1 — Sync the `${ai_dev_branch}$` branch
1. If not on `${ai_dev_branch}$`:
   - `git fetch origin`
   - If it doesn't exist yet: `git checkout -b ${ai_dev_branch}$ origin/${ai_dev_branch}$` (if the remote
     has it) or `git checkout -b ${ai_dev_branch}$ main` (create from main).
   - Otherwise: `git checkout ${ai_dev_branch}$`.
2. `git pull --ff-only origin ${ai_dev_branch}$` (skip if the remote has no such branch yet).

## Step 2 — Intake user requests → generate tasks
1. Read `USER_TODO.md` and **compare with `.claude/templates/USER_TODO.empty.md`**. If **equal** (only
   the empty template remains) → **no** new request → skip task generation.
2. **If anything is unclear / needs a user decision** (ambiguous, missing info, contradictory, or the
   user said "ask if unclear, don't decide on your own"):
   - **Do NOT guess** and generate tasks. Write the question into `USER_QA.md` ("Q&A" section) per
     `.claude/templates/USER_QA.sample.md`: state the original request, what's unclear, and (if possible)
     options to choose from. Each question has a date + an empty answer slot.
   - **Clear `USER_TODO.md`** back to the empty template (Step 2.4) — do NOT generate tasks this cycle.
     The user will read `USER_QA.md`, clarify, and re-post the request into `USER_TODO.md` for a later cycle.
   - Note in `AI_DONE.md` ("Incidents/notes") that this cycle stopped waiting for an answer, then go to
     Step 8 (clean the lock) and **stop**.
3. If the request is clear enough: split it into small tasks doable in ~1 cycle. Write them into
   `AI_TODO.md` per `.claude/templates/AI_TODO.sample.md` (**7-column table:
   `| ID | Priority | Approved | Depends | Group | Task description | Notes |`**), each with an
   **ID `TSK-{groupid:0000}-{taskid:0000}`** (group = one request/batch, task = a sub-task).
   - **`Priority` column**: judge it — `High` / `Medium` / `Low` (default `Medium`).
   - **`Approved` column**: leave BLANK. This is a display-only mirror — the source of truth for approval
     is `.claude/.autonomous.approvals.json` (the user ticks it in the web VERIFY tab — ADR-0152). Do NOT
     fill it in yourself and do NOT read it to decide (see Step 3).
   - **`Depends` column**: if a task must wait for another, list the `TSK-…` ids here (comma-separated);
     leave empty otherwise. Step 3 skips a task whose dependencies aren't in `AI_DONE.md` yet.

   **ID rules (MANDATORY):**
   - **Each analysis of `USER_TODO.md` → one NEW `groupid`.** All sub-tasks split from that batch share
     this `groupid`, differing only by `taskid`.
   - **`groupid` must be UNIQUE and INCREASING** across all history (including groups already DONE and
     cleared from `AI_TODO.md`). Since the books are cleared each cycle, **check git history** for the
     largest `groupid` ever used, then take `max + 1`:
     ```bash
     MAXG=$( { git log -p -- AI_TODO.md AI_DONE.md AI_PROGRESS.md 2>/dev/null; \
               cat AI_TODO.md AI_DONE.md AI_PROGRESS.md 2>/dev/null; } \
             | grep -oE 'TSK-[0-9]{4}-[0-9]{4}' | sed -E 's/TSK-([0-9]{4}).*/\1/' \
             | sort -rn | head -1 ); MAXG=${MAXG:-0}
     NEWG=$(printf '%04d' $((10#$MAXG + 1)))
     ```
   - **`taskid` starts at `0001` and increases WITHIN the group**: `TSK-{NEWG}-0001`, `TSK-{NEWG}-0002`, …
4. **Clear `USER_TODO.md`** by overwriting with the exact empty template
   (`cp .claude/templates/USER_TODO.empty.md USER_TODO.md`) — so old tasks aren't recreated next cycle AND
   the tick's "has work" gate correctly sees it as empty.

## Step 3 — Pick ONE APPROVED task (with satisfied dependencies) and start it
> **VERIFY gate (MANDATORY):** the source of truth for approval is `.claude/.autonomous.approvals.json`
> (ADR-0152), NOT the `Approved` column in `AI_TODO.md`. A task is **approved** when approvals has
> `"<TSK-id>": { "approved": true, … }`. A task not in approvals (or `approved:false`) = NOT permitted →
> **skip it, leave it queued**.

1. Read `.claude/.autonomous.approvals.json` (JSON `{ "<TSK-id>": {approved, by, at}, … }`; missing file
   ⇒ nothing approved) and `AI_TODO.md`. **Filter tasks meeting BOTH**:
   - **Approved**: `approved === true` in approvals.
   - **Dependencies met**: every `TSK-…` in the `Depends` column is already in `AI_DONE.md` (done). If a
     dependency isn't done yet → **skip** (wait for a later cycle), even if approved.
   Pick the next task: **run group by group** (smallest group with an eligible task first), **within a
   group prefer `Priority` High → Medium → Low**, then line order.
   - **If NO eligible task** (empty, or all waiting for approval / dependencies — including tasks just
     generated in Step 2): **take no task**. Write one line into `AI_DONE.md` ("Incidents/notes")
     (e.g. "this cycle only generated tasks / waiting for VERIFY approval / waiting for dependencies"),
     then go to Step 8 (clean the lock) and **stop**.
2. Move that task into `AI_PROGRESS.md` (with a start timestamp, per
   `.claude/templates/AI_PROGRESS.sample.md`), **remove it from `AI_TODO.md`**. If `AI_TODO.md` is now
   empty → `cp .claude/templates/AI_TODO.empty.md AI_TODO.md`.
3. Commit on `${ai_dev_branch}$`: `git add -A && git commit -m "chore(auto): start TSK-xxxx-xxxx"`.

## Step 4 — Implement the task on its own branch
1. Create the branch: `git checkout -b task/TSK-xxxx-xxxx`.
2. Implement the task **following the project's architecture + the conventions in `CLAUDE.md`**. Add or
   update tests as appropriate for the change.
3. **Test** by running the project's test command (see `CLAUDE.md` / the project's scripts — e.g.
   `scripts/test.*`, `npm test`, `pnpm test`, `pytest`, …). If the project defines an integration-test /
   evidence harness, use it and keep the produced report/evidence so it can be reviewed later.
4. **Wait for the tests to finish** and check the result before continuing.
5. Commit (include any produced report/evidence so the integration branch carries it):
   `git add -A && git commit -m "feat(TSK-xxxx-xxxx): <short description>"`.

## Step 5 — Merge into `${ai_dev_branch}$`, update the books
1. `git checkout ${ai_dev_branch}$`
2. `git merge --no-ff task/TSK-xxxx-xxxx`
   - **On CONFLICT** (parallel agents may have moved the integration branch — MEMO #40): `git status`
     shows `UU` files. **Resolve them yourself**: edit each conflicted file into a correct merged result
     (remove every `<<<<<<< ======= >>>>>>>` marker), `git add <file>`, then `git commit --no-edit` to
     finish the merge. If a conflict is too complex to be sure → `git merge --abort`, write a question
     into `USER_QA.md`, go to Step 8 and stop (don't guess).
3. Record the task in `AI_DONE.md` (ID, description, timestamp — per `.claude/templates/AI_DONE.sample.md`).
   **Remove it from `AI_PROGRESS.md`**: if nothing is in progress after removal, reset with
   `cp .claude/templates/AI_PROGRESS.empty.md AI_PROGRESS.md`. Likewise, if `AI_TODO.md` is now empty →
   `cp .claude/templates/AI_TODO.empty.md AI_TODO.md`.
4. Commit: `git add -A && git commit -m "chore(auto): finish TSK-xxxx-xxxx, merge into ${ai_dev_branch}$"`.
5. (Optional) `git push origin ${ai_dev_branch}$`.

## Step 6 — Recheck the token budget
1. Re-run the **check-usage** skill: `python .claude/skills/check-usage/check_usage.py`, then **wait 3s**
   (`sleep 3`) for the result file to be written.
2. Print a summary: task done, tokens remaining.

## Step 7 — Commit & push `${ai_dev_branch}$`
1. `git checkout ${ai_dev_branch}$`
2. `git add -A && git commit -m "chore(auto): update books after the autonomous cycle"` (skip if no change).
3. `git push origin ${ai_dev_branch}$`.

## Step 7.5 — Report on the `conversation` branch (share context with later agents — MEMO #40)
> Multiple Claude instances take different tasks in parallel; a later agent needs to know what an earlier
> one did. Use a dedicated branch named **`conversation`** holding **only** the file `CONVERSATION.md`
> (no source or docs), keeping **at most the 50 most recent reports** (trim older ones when over).

1. Save the context (task ID + summary + list of files changed this cycle).
2. `git stash -u` if there are uncommitted changes (usually none — the books were committed in Step 7).
3. Switch to the conversation branch (create it orphan if missing):
   - `git fetch origin` → `git checkout conversation` (exists) or
     `git checkout --orphan conversation && git rm -rf . 2>/dev/null` (create fresh, clean).
   - `git pull --ff-only origin conversation` (skip if the remote has none).
4. Append an entry to the **end** of `CONVERSATION.md`:
   ```
   ## <yyyy-MM-dd HH:mm> · TSK-xxxx-xxxx
   - Did: <short summary>
   - Files: <paths, comma-separated>
   - Merged into: ${ai_dev_branch}$ (<conflict / no conflict>)
   ```
   If the number of `##` entries exceeds **50** → drop the oldest ones down to 50.
5. `git add CONVERSATION.md && git commit -m "chore(conversation): TSK-xxxx-xxxx" && git push origin conversation`.
6. Return to the integration branch: `git checkout ${ai_dev_branch}$` (and `git stash pop` if you stashed in 2).

## Step 8 — Clean the lock (ALWAYS run, even on error/early exit)
> This is the **final action of every cycle** — run it whether the cycle succeeded, hit an error, or was
> blocked at the token gate. Goal: never let a stale lock block the next cron tick.
1. Delete the lock file: `rm -f .claude/.autonomous.lock` (run in the project root).
   - The lock IS the file `.autonomous.lock`: `autonomous-tick.sh` creates it at start and treats "the
     file exists" = a run is in progress. Deleting it here releases the lock for the next tick.
   - This is `/auto-cycle`'s responsibility; the wrapper only has a safety-net trap in case the cycle dies.
2. **STOP** (the next cron tick will trigger the next cycle).
