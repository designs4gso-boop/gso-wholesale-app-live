# READY TO ENABLE AFTER LIVE PATCH F VALIDATION

## GSO Mimaki Result Sync — enablement package (sync v1.4)

Updated 2026-11-20. **Nothing here has been run on the live system and nothing in
`C:\GSO-RIP-Result-Sync` has been changed.** The folder still holds sync **v1.3**, the old register
script and a config without an activation timestamp. No Mimaki result-sync task exists on the PC (the
only GSO tasks are `GSO Print Intake Agent`, running, and `GSO Roland Result Sync`, disabled).

Roland is out of scope: Roland actuals stay on the **manual VersaWorks CSV export**. The old
`GSO Roland Result Sync` task stays disabled. Nothing here automates Roland.

Order of work: **install (section 2) → one-shot validation of the first real ticketed job (section 6) →
register (section 7)**. Do not register before section 6 has passed.

---

## 1. What it is

| | |
|---|---|
| Task name | `GSO Mimaki Result Sync` (to be created by the register script — does not exist yet) |
| Runtime folder | `C:\GSO-RIP-Result-Sync` |
| Script | `C:\GSO-RIP-Result-Sync\gso-rasterlink-sync.ps1` — must be `gso-rasterlink-sync/1.4` or newer (the register script refuses an older one) |
| Config | `C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json` |
| Runs as | the shop user `golde`, at logon, **not** elevated (run level Limited), one instance (`IgnoreNew` + the script's own single-instance lock), restart on failure 10 × 1 minute |
| Direction | RasterLink result CSVs (and the exact job's `JobInfo.ini`, read-only) → ERP `/api/rip-imports/upload`. It never writes to a hot folder or to `C:\MijCtrl`. The Print Intake Agent is a separate program and is not affected |

### Config keys (names only)

`ApiBaseUrl`, `UploadToken` (secret — never print it), `IncomingFolder`, `JobsFolder`, `NotBeforeUtc`,
**`ActivationUtc`** (new in v1.4), `ProcessedFolder`, `ErrorFolder`, `LogFolder`, `Source`, `PollSeconds`,
`StableFileSeconds`, `MaxRetries`, `RetryDelaySeconds`, `ClaimStaleMinutes`.

- `IncomingFolder` must be the per-printer result folder `…\rip-logs\rasterlink\incoming\UCJV-300`. Only
  files **directly** in it are read; the historical backlog in `…\incoming\GSOP` is never read and the
  script refuses to start if pointed at it (exit 1).
- `JobsFolder` is the RasterLink jobs folder; `JobInfo.ini` files in it are only ever read.
- `ActivationUtc` is written by the register script. **Do not type it by hand.**
- `NotBeforeUtc` still works as an additional floor (results written before it are counted as
  `ignored_before_cutoff`). The activation is what protects the backlog now.
- `UploadToken` is the same token the Print Intake Agent uses. It was exposed and is due for rotation —
  see `docs/GSO_PRINT_INTAKE_RUNTIME.md`, section 6. Rotate first, then enable. The rotation helper
  updates this config too.

To read the non-secret settings without showing the token:

```powershell
Get-Content -LiteralPath "C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json" -Raw | ConvertFrom-Json | Select-Object IncomingFolder, JobsFolder, NotBeforeUtc, ActivationUtc, ProcessedFolder, ErrorFolder, LogFolder, Source, PollSeconds, MaxRetries
```

---

## 2. Install (lead engineer; copies only — nothing is started)

Copy exactly these two files from the repository into the runtime folder, replacing the old ones:

| From (repository) | To |
|---|---|
| `tools\gso-rasterlink-sync.ps1` | `C:\GSO-RIP-Result-Sync\gso-rasterlink-sync.ps1` |
| `tools\register-mimaki-result-sync-task.ps1` | `C:\GSO-RIP-Result-Sync\register-mimaki-result-sync-task.ps1` |

Keep the old sync beside it first, then copy and check:

```powershell
Copy-Item "C:\GSO-RIP-Result-Sync\gso-rasterlink-sync.ps1" "C:\GSO-RIP-Result-Sync\gso-rasterlink-sync.v1.3-backup-20261120.ps1"
Copy-Item ".\tools\gso-rasterlink-sync.ps1" "C:\GSO-RIP-Result-Sync\gso-rasterlink-sync.ps1" -Force
Copy-Item ".\tools\register-mimaki-result-sync-task.ps1" "C:\GSO-RIP-Result-Sync\register-mimaki-result-sync-task.ps1" -Force

# offline self-test: no config, no network, no NAS. Expected last line: "self-test failures: 0"
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\gso-rasterlink-sync.ps1" -SelfTest
```

Do **not** edit the config. Do **not** copy the example config over it. With no `ActivationUtc` in the
config, v1.4 refuses to process anything (exit 4), so installing the files activates nothing.

---

## 3. The activation model

- **Activation is a timestamp, written once, at registration.** `register-mimaki-result-sync-task.ps1`
  writes `"ActivationUtc": "<now, UTC>"` into the config at the moment it registers the task. Only that
  key is written; the token is never read out, shown or changed; the config is backed up first.
- **A result older than the activation is ignored for good.** A result counts as post-activation only when
  *every* time the script can read is at or after the activation: the file's last-write time, the
  `yyyyMMdd_HHmmss` stamp at the front of its name, and the latest RIP / print / cut end time inside it
  (RasterLink stamps are local time). Older results are never uploaded and never moved; they are counted
  in the pass summary as `ignored_before_activation`. The 40 result files in the folder on 2026-11-20
  (34 of them newer than the old `NotBeforeUtc`) are all older than any registration that happens later,
  so they are excluded **by construction** — no cutoff has to be picked by hand.
- **No activation = nothing happens.** Without `ActivationUtc` the script logs `refused_no_activation`
  and exits with code 4 before it scans anything. An unreadable value is a config error (exit 1), never
  "no cutoff".

One consequence to know: a job that was RIPped *before* the activation and finishes *after* it is
ignored too (its end times are older) and is listed once in the log as `ignored_before_activation …
written after activation, but its latest RIP / print / cut end time is before it`. If that job matters,
upload it with the one-shot command in section 6.

Exit codes: `0` finished · `1` config could not be loaded / unsafe incoming folder · `2` the ERP rejected
the upload token · `4` no activation timestamp · `6` another poll loop for the same folder is running.

---

## 4. What is uploaded — the pre-filter

A result is uploaded only when **all three** hold. Everything else is left exactly where it is.

| Check | Rule | If not |
|---|---|---|
| Ticketed identity | at least one job name inside the result (`KEY_FILENAME`) carries an ERP **item ticket** `GSO-YYYYMMDD-NNNN-NN` — hyphens, any case. This is the exact form the server lifts from a RIP name (`app/lib/rip-identity-match.server.ts`, `RIP_ITEM_TICKET_RE`); underscores are not a ticket for the server either | `ignored_no_ticket` (no ticket at all) or `ignored_ambiguous` (a job ticket without the item suffix, underscores/spaces instead of hyphens, two different tickets in one name, or the result name and its rows disagree) |
| Supported format | the file is `…_print.csv` or `…_cut.csv` and has `KEY_FILENAME` rows | `ignored_unsupported_format` |
| Post-activation | section 3 | `ignored_before_activation` |

- Nothing is guessed. An un-ticketed CRUD result is not uploaded, not moved, counted, and **listed once**
  in the log (`[ignored_no_ticket] file=… NOT uploaded, left in place … Review by hand.`).
- A ticketed result that also contains an un-ticketed layer (for example a shared `…_ALL_b_.pdf` layer in
  a composite) **is** uploaded: the log line shows `unticketedRows=N`. The server links each row by its
  own name, so the un-ticketed row is stored unmatched for review and attached to no job.
- `-OnlyFile` narrows the eligible results. It cannot make an ignored result eligible.
- The `JobInfo.ini` companion (clear ink, the `jobFolder` field) is uploaded for eligible `_print.csv`
  results exactly as before. If the server does not answer the companion, the result stays in the incoming
  folder and the ink is retried on the next pass (the result itself is not imported twice — section 8).
- The server defends itself as well, so the pre-filter is the first line, not the only one: an un-ticketed
  row that does reach the upload route is stored with no job and no item
  (`resolveRipIdentity`, exact matches only) and is visible in RIP Imports for review. No server change
  was needed.

`-DryRun` shows the verdict for every post-activation file and uploads nothing:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\gso-rasterlink-sync.ps1" -ConfigPath "C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json" -DryRun
```

Output lines: `WOULD UPLOAD  <file>  (ticket …)`, `WOULD IGNORE  <file>  (<reason>: …)`, then
`DRY RUN SUMMARY: scanned=… eligible=… would_upload=… ignored_before_activation=… ignored_no_ticket=… state=ok`.
A dry run makes no upload, moves nothing and writes no claim file; it does write its lines to the sync log.

---

## 5. Log, health, how to see it is alive

- **Log:** the folder in `LogFolder` (`\\SynologyNAS\GSOP\GSOP\rip-logs\sync-logs`), one file per day:
  `gso-rasterlink-sync-YYYYMMDD.log`. If the NAS log cannot be written the line goes to
  `C:\GSO-RIP-Result-Sync\gso-rasterlink-sync-local-YYYYMMDD.log` (then
  `%LOCALAPPDATA%\GSO-RIP-Result-Sync\`, then `%TEMP%`). Logging never stops the sync.
- **Pass summary:** one `pass_summary` line whenever the counts change:
  `scanned eligible uploaded would_upload ignored_before_cutoff ignored_before_activation ignored_no_ticket
  ignored_ambiguous ignored_unsupported_format not_selected waiting retry_later rejected failed
  jobinfo_failed log_fallback` and `state=ok` or `state=ERROR`. `state=ERROR` means one of `retry_later`,
  `rejected`, `failed`, `jobinfo_failed`, `log_fallback` is not zero.
- **Other events:** `watcher_started` (shows `activationUtc=`), `detected`, `upload_started`,
  `upload_succeeded`, `duplicate_accepted`, `jobinfo_result`, `moved_to_processed`, `upload_deferred`
  (server not answering — file left in place), `terminal_client_error` + `moved_to_error` (server refused
  the file), `file_error`, `pass_error`, `fatal_config` + `watcher_stopped` (token rejected),
  `refused_no_activation`, `duplicate_instance`.
- **Health check (writes nothing to the ERP; creates and removes one probe file per folder):**
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\gso-rasterlink-sync.ps1" -ConfigPath "C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json" -Health
  ```
  Expected: `activation (ActivationUtc): …`, folders `OK (reachable + writable)` (`processed-live` and
  `error-live` do not exist yet and show `NOT REACHABLE` until the first result is moved — they are created
  on first use), `endpoint reachable: OK`, `token accepted: OK (token valid; 400 missing-file as expected,
  nothing imported)`.
- **Alive?** There is still **no heartbeat** for this sync in the ERP; the green/red banner on Incoming
  Print Files is the Print Intake Agent only. An idle sync writes nothing new to its log. Evidence that it
  is alive: task state `Running`, and a new ticketed result appearing in RIP Imports
  (`/app/erp/rip-imports`) and in `processed-live` within about a minute of RasterLink writing it.

---

## 6. The one-shot manual validation (before any task exists)

This is the "live Patch F validation". It works **before** registration because `-Once` and `-DryRun`
accept an activation on the command line (`-ActivationUtc`); the poll loop never does.

Print **one** ERP-linked, ticketed Mimaki job. Note the time (UTC) just before the job was sent to
RasterLink — before its RIP started. Its result is two files in the incoming folder with the same stem:
`…_cut.csv` and `…_print.csv`. Then, as `golde`, in a normal PowerShell window:

```powershell
$sync = "C:\GSO-RIP-Result-Sync\gso-rasterlink-sync.ps1"
$cfg  = "C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json"
$t    = "2026-11-21T17:20:00Z"     # UTC, just BEFORE the job was sent to RasterLink - replace

# 1. health (section 5)
powershell -NoProfile -ExecutionPolicy Bypass -File $sync -ConfigPath $cfg -Health

# 2. dry run: must list WOULD UPLOAD for exactly that job's cut + print result, and nothing else
powershell -NoProfile -ExecutionPolicy Bypass -File $sync -ConfigPath $cfg -DryRun -ActivationUtc $t

# 3. the one-shot upload (cut first, then print - the script orders them)
powershell -NoProfile -ExecutionPolicy Bypass -File $sync -ConfigPath $cfg -Once -ActivationUtc $t
```

- If step 2 lists anything you did not expect, stop. To upload exactly one result regardless of what else
  is eligible, add `-OnlyFile "<exact name>_cut.csv"` and run again with `-OnlyFile "<exact name>_print.csv"`
  (one name per command: with `-File`, a comma list is passed as a single name and matches nothing).
- Un-ticketed CRUD results printed after `$t` are listed as `WOULD IGNORE … ignored_no_ticket` and are not
  uploaded by step 3.
- This run does not write `ActivationUtc` into the config and creates no task.

Expected in the log: `upload_succeeded` for each file, `jobinfo_result … outcome=applied` for a composite
CMYK + clear job, `moved_to_processed`, `pass_summary … uploaded=2 … state=ok`. Then check in the ERP that
the rows are linked to the right job and item and that ink and copy count are right.

---

## 7. Register the task (only after section 6 passed)

Preview first — reads only, works without elevation, asks nothing, changes nothing:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\register-mimaki-result-sync-task.ps1" -WhatIf
```

Then, in an **elevated** PowerShell (Run as administrator), signed in as `golde`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\register-mimaki-result-sync-task.ps1"
```

What it does, in order: checks (sync script is v1.4+, config valid and pointing at `UCJV-300`, no other
enabled task runs the result sync, the task does not exist, you are the user of the
`GSO Print Intake Agent` task, elevated) → asks "Are you sure?" → backs up the config as
`gso-mimaki-result-sync-config.before-activation-<stamp>.json` → writes `ActivationUtc` = now → registers
the one task → prints the verify, disable and rollback lines.

- It does **not** start the task (add `-StartNow` to start it at once). Without it the sync starts at the
  next sign-in, or with `Start-ScheduledTask -TaskName "GSO Mimaki Result Sync"`.
- It never processes historical files: everything that exists at registration is older than the activation.
- Run twice: the second run says `Already registered … Nothing was changed; the activation timestamp was
  not moved.` A task with that name that runs something else is never overwritten.
- Refusals (exit 1, nothing changed): not elevated; wrong Windows user; a file missing; sync older than
  v1.4; config not valid / no `UploadToken` / `IncomingFolder` not the `UCJV-300` folder; another enabled
  task already runs `gso-rasterlink-sync.ps1`.

### Verify

```powershell
Get-ScheduledTask -TaskName "GSO Mimaki Result Sync" | Select-Object TaskName, State
Get-ScheduledTask -TaskName "GSO Mimaki Result Sync" | Get-ScheduledTaskInfo | Select-Object LastRunTime, LastTaskResult
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\gso-rasterlink-sync.ps1" -ConfigPath "C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json" -DryRun
Start-ScheduledTask -TaskName "GSO Mimaki Result Sync"
Get-Content "\\SynologyNAS\GSOP\GSOP\rip-logs\sync-logs\gso-rasterlink-sync-$(Get-Date -Format yyyyMMdd).log" -Tail 20
```

Expected: the dry run right after registration lists **no** `WOULD UPLOAD` line
(`ignored_before_activation` = every file in the folder); after the start, `State = Running`,
`LastTaskResult = 267009` (still running); the log has `watcher_started … mode=poll … activationUtc=<the
registration time>` and `pass_summary … uploaded=0 … state=ok`, no `fatal_config`, no `refused_no_activation`.

### Disable (keeps the task and the activation; nothing is deleted)

Elevated PowerShell:

```powershell
Stop-ScheduledTask    -TaskName "GSO Mimaki Result Sync"
Disable-ScheduledTask -TaskName "GSO Mimaki Result Sync"
```

Re-enable with `Enable-ScheduledTask` and `Start-ScheduledTask`. Ticketed results written while it was
disabled are uploaded when it starts again (they are newer than the activation).

### Roll back (removes the task, puts the config back as it was before registration)

```powershell
Stop-ScheduledTask -TaskName "GSO Mimaki Result Sync"
Unregister-ScheduledTask -TaskName "GSO Mimaki Result Sync" -Confirm:$false
Copy-Item -LiteralPath "C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.before-activation-<stamp>.json" -Destination "C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json" -Force
```

The register script prints these lines with the real backup name. Results already imported stay in the
ERP; files already moved stay in `processed-live`. If the token was rotated after the backup was made, do
not copy the backup back (it holds the old token) — remove the `ActivationUtc` line from the config by hand
instead. To go back to sync v1.3 as well, copy `gso-rasterlink-sync.v1.3-backup-20261120.ps1` over the
script — only with the task removed: **v1.3 ignores the activation and would upload the backlog.**

---

## 8. Duplicate protection (server-side) and retry behaviour

Uploading the same result twice cannot create a second set of rows:

- **File level** — `app/routes/api.rip-imports.upload.tsx:213–222`: an import with the same file name and
  the same SHA-256 of the content, already `processed`, answers `duplicateFile: true` and writes nothing.
  The sync treats that answer as success and moves the file to processed.
- **Row level** — `api.rip-imports.upload.tsx:250–253`: each row is looked up by its natural key
  (`rowDedupeWhere`) and skipped when it exists. A crashed half-import can therefore be retried safely.
- **JobInfo.ini companion** — `api.rip-imports.upload.tsx:141–204`: the only write is the ink columns of
  the one print-log row matched by exact JobID + file name + RIP start/end. No match → nothing written.
- **Local** — a `.gsoclaim` file per result stops two processes uploading the same file at once; a claim
  left by a dead process on this PC is reclaimed at once; one poll loop per incoming folder (exit 6 for a
  second one); the task cannot start twice (`IgnoreNew`).

A result is moved only **after the server answered**:

| Server answer | What the sync does |
|---|---|
| 2xx with `ok: true` (including `duplicateFile`) | uploads the JobInfo companion if needed, then moves the file to `ProcessedFolder`. If the move itself fails, the file stays and the next pass gets `duplicateFile` and moves it |
| no answer, network error, 5xx, 408, 429, a 401/403 that is not the ERP's own token answer | retries up to `MaxRetries` with a growing wait, then logs `upload_deferred` and **leaves the file in the incoming folder**. It is retried on the next pass, and every pass after that, until the server answers. While the server is down only one result is tried per pass |
| the ERP's 401 / 403 "upload token" answer | `fatal_config`; the file is left where it is; the sync stops with exit 2 (Task Scheduler relaunches it 10 times, one minute apart; each relaunch re-reads the config) |
| any other 4xx | the server refused this file: moved to `ErrorFolder` with `<name>.error.json` beside it. Not retried |

- **An ERP outage no longer strands results.** In v1.3 an outage longer than about a minute moved every
  result to `error-live` for good. v1.4 never moves a result the server did not answer.
- **Results stranded by an older version are retried.** A `.csv` in `ErrorFolder` whose `.error.json`
  shows no answer / 5xx / 408 / 429 is uploaded from where it is (same activation and ticket filter). When
  accepted it moves to `ProcessedFolder` together with its sidecar. A result whose sidecar shows a 4xx
  refusal stays in the error folder. (`error-live` does not exist yet, so there is nothing stranded today.)
- **One bad result does not stop the others**, and nothing thrown in a pass ends the loop: the pass logs
  `file_error` / `pass_error … state=ERROR` and the next pass retries. An unreachable incoming folder is a
  `pass_error`, not "nothing to do".

---

## 9. What changed from v1.3, and what is still open

| v1.3 finding | v1.4 |
|---|---|
| 34 results past `NotBeforeUtc` would upload on the first pass | Activation at registration; no activation = exit 4; un-ticketed results are never uploaded |
| A failed NAS log write ended the loop | Logging retries, falls back to a local file, never throws |
| No guard around the pass | `Invoke-GuardedPass`; one failed result does not stop the next |
| NAS down looked like "nothing to do" | `pass_error … incoming_unavailable … state=ERROR` |
| An outage moved results to `error-live` for good | Results stay in incoming; stranded ones are retried |
| Register script: no `-WhatIf`, started the task and uploaded at once, 3 × 5 min restart | `-WhatIf`, idempotent, does not start by default, 10 × 1 min, `IgnoreNew`, prints verify / disable / rollback |
| Token mask showed the first 4 characters | Length only |

Still open (not built):

- No heartbeat in the ERP for this sync (section 5), and no watchdog. The Print Intake watchdog does not
  cover it. Someone has to look at the task state or the log.
- Reboot coverage is the same as the Print Intake Agent: the task starts when `golde` signs in.
- `Authenticated Users: Modify` on `C:\GSO-RIP-Result-Sync`: any signed-in Windows user can edit the
  script or read the config. Acceptable on a single-user RIP PC; tighten if more accounts are added.
- Stale files in the folder, harmless: `disable-old-roland-task-ELEVATED.ps1` (its job is done) and
  `previous-roland-task-definition-20261118.xml` (**do not re-register it** — it starts at boot and runs the
  old clone's script and config).

## 10. What was verified, and what was not

Verified offline (2026-11-20): parser check with Windows PowerShell 5.1 and PowerShell 7 (0 errors);
`-SelfTest` 106 PASS / 0 FAIL in both; end-to-end runs of the real script against temp folders and a stub
HTTP server on `127.0.0.1` (no activation → exit 4; dry run; activation = now ignores everything; 503
outage then recovery; token rejected → exit 2; broken config → exit 1 with no piece of the file logged);
the register script's config edit exercised in memory against the real runtime config (only
`ActivationUtc` differs; the file on disk was not written).

**Not verified — needs the live system:** the register script itself has never been run (task creation,
the non-elevated refusal, `-StartNow`); a real upload to the production ERP; a real ticketed RasterLink
result (the folder holds only un-ticketed CRUD results today, so the ticket filter has only been tested on
fixtures with the real file layout); the `JobInfo.ini` companion against `C:\MijCtrl\Jobs\1`; behaviour
over a real NAS drop.
