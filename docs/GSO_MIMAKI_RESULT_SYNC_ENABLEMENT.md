# READY TO ENABLE AFTER LIVE PATCH F VALIDATION

## GSO Mimaki Result Sync — enablement package

Prepared 2026-11-20 from a read-only audit of `C:\GSO-RIP-Result-Sync` on the RIP PC and of
`tools/gso-rasterlink-sync.ps1`. **Nothing here has been run. No Mimaki result-sync task exists on the PC
today** (checked: no scheduled task has "Mimaki" or "Result Sync" in its name except the disabled
`GSO Roland Result Sync`). Do not register the task until the first ERP-linked Mimaki result has been
verified by hand (section 6).

Roland is out of scope: Roland actuals stay on the **manual VersaWorks CSV export**. The old
`GSO Roland Result Sync` task stays disabled.

---

## 1. What it is

| | |
|---|---|
| Task name | `GSO Mimaki Result Sync` (to be created — does not exist yet) |
| Runtime folder | `C:\GSO-RIP-Result-Sync` |
| Script | `C:\GSO-RIP-Result-Sync\gso-rasterlink-sync.ps1` — `gso-rasterlink-sync/1.3`, byte-identical to the repository `tools/gso-rasterlink-sync.ps1` (SHA-256 `5F5D66C5…5700A08F`) |
| Config | `C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json` |
| Runs as | the shop user `golde`, at logon, **not** elevated (run level Limited), default mode = poll loop |
| Direction | RasterLink result CSVs (and the exact job's `JobInfo.ini`, read-only) → ERP `/api/rip-imports/upload`. It never writes to a hot folder or to `C:\MijCtrl`. The Print Intake Agent is a separate program and is not affected |

### Config keys (names only)

`ApiBaseUrl`, `UploadToken` (secret — never print it), `IncomingFolder`, `JobsFolder`, `NotBeforeUtc`,
`ProcessedFolder`, `ErrorFolder`, `LogFolder`, `Source`, `PollSeconds`, `StableFileSeconds`, `MaxRetries`,
`RetryDelaySeconds`, `ClaimStaleMinutes`.

- `IncomingFolder` must be the per-printer result folder `…\rip-logs\rasterlink\incoming\UCJV-300`. Only
  files **directly** in it are read (`gso-rasterlink-sync.ps1:583`); the historical backlog in
  `…\incoming\GSOP` is never read and the script refuses to start if pointed at it (`:577`).
- `JobsFolder` is the RasterLink jobs folder; `JobInfo.ini` files in it are only ever read (`:239–257`).
- `UploadToken` is the same token the Print Intake Agent uses. **It was exposed and is due for rotation**
  — see `docs/GSO_PRINT_INTAKE_RUNTIME.md`, section 6. Rotate first, then enable.

To read the non-secret settings without showing the token:

```powershell
Get-Content -LiteralPath "C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json" -Raw | ConvertFrom-Json | Select-Object IncomingFolder, JobsFolder, NotBeforeUtc, ProcessedFolder, ErrorFolder, LogFolder, Source, PollSeconds, MaxRetries
```

---

## 2. The cutoff — `NotBeforeUtc`

A result file whose last-written time (UTC) is **before** `NotBeforeUtc` is never uploaded and never
moved; it stays in the incoming folder untouched. A file written at or after the cutoff is uploaded
(`Select-FilesAfterCutoff`, `gso-rasterlink-sync.ps1:287–295`).

- A cutoff that cannot be parsed keeps **nothing** (fail closed).
- An **empty** cutoff means no cutoff — every result in the folder would be uploaded. The register script
  refuses to continue when it is empty (`register-mimaki-result-sync-task.ps1:33`).
- The cutoff is a floor, not "from now on". **On 2026-11-20, 34 of the 40 result files in the incoming
  folder are at or after the configured cutoff.** Registering the task as-is uploads all 34 on its first
  pass. If only results from the validation onward are wanted, the lead engineer moves `NotBeforeUtc`
  forward in the config before registering (ISO-8601 UTC, e.g. `2026-11-21T00:00:00Z`).

---

## 3. Log, health, how to see it is alive

- **Log:** the folder in `LogFolder` (`\\SynologyNAS\GSOP\GSOP\rip-logs\sync-logs`), one file per day:
  `gso-rasterlink-sync-YYYYMMDD.log`. Events: `watcher_started`, `detected`, `upload_started`,
  `upload_succeeded`, `duplicate_accepted`, `jobinfo_result`, `moved_to_processed`, `retry_scheduled`,
  `moved_to_error`, `fatal_config`, `watcher_stopped`.
- **Health check (writes nothing to the ERP; creates and removes one probe file per folder):**
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\gso-rasterlink-sync.ps1" -ConfigPath "C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json" -Health
  ```
  Expected: four folders `OK (reachable + writable)`, `endpoint reachable: OK`,
  `token accepted: OK (token valid; 400 missing-file as expected, nothing imported)`.
- **Alive?** There is **no heartbeat** for this watcher. The green/red banner on Incoming Print Files is
  the Print Intake Agent only. An idle sync writes nothing to its log. The evidence that it is alive is:
  task state `Running`, and a new result appearing in the ERP (RIP Imports, `/app/erp/rip-imports`) and in
  `processed-live` within about a minute of RasterLink writing it.

---

## 4. Duplicate protection (server-side)

Uploading the same result twice cannot create a second set of rows:

- **File level** — `app/routes/api.rip-imports.upload.tsx:213–222`: an import with the same file name and
  the same SHA-256 of the content, already `processed`, answers `duplicateFile: true` and writes nothing.
  The watcher treats that answer as success and moves the file to processed
  (`gso-rasterlink-sync.ps1:356–357`).
- **Row level** — `api.rip-imports.upload.tsx:250–253`: each row is looked up by its natural key
  (`rowDedupeWhere`) and skipped when it exists. A crashed half-import can therefore be retried safely.
- **JobInfo.ini companion** — `api.rip-imports.upload.tsx:141–204`: the only write is the ink columns of
  the one print-log row matched by exact JobID + file name + RIP start/end. No match → nothing written.
- **Local** — a `.gsoclaim` file per result stops two watchers uploading the same file at once
  (`gso-rasterlink-sync.ps1:102–119`), and the task cannot start twice (default `IgnoreNew`).

---

## 5. Retry behaviour

Per result file (`gso-rasterlink-sync.ps1:341–395`):

| Server answer | What the watcher does |
|---|---|
| 2xx with `ok: true` | uploads the JobInfo companion if needed, moves the file to `ProcessedFolder` |
| network error, 5xx, 429 | retries up to `MaxRetries` (4) with a growing wait (`RetryDelaySeconds` × attempt: 10 s, 20 s, 30 s). After the last failure the file is moved to `ErrorFolder` with a `<name>.error.json` beside it |
| 401 / 403 | `fatal_config`; the file is **left in incoming**; the watcher stops with exit 2 |
| other 4xx | moved to `ErrorFolder` with a sidecar at once |

Cut results (`…_cut.csv`) are uploaded before print results (`:298–300`).

**Know this before enabling:** a file moved to `ErrorFolder` is not retried by itself. An ERP outage longer
than about one minute sends every result printed during it to `error-live`. Recovery is manual: move the
`.csv` files from `error-live` back into the incoming folder (the server's dedupe makes that safe) and
delete their `.error.json` sidecars.

---

## 6. The validation itself (one-shot, by hand, before any task exists)

Pick **one** freshly printed, ERP-linked Mimaki job. Its result is two files in the incoming folder with
the same stem: `…_cut.csv` and `…_print.csv`. Run, as `golde`, in a normal PowerShell window:

```powershell
$sync = "C:\GSO-RIP-Result-Sync\gso-rasterlink-sync.ps1"
$cfg  = "C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json"

# 1. health (see section 3)
powershell -NoProfile -ExecutionPolicy Bypass -File $sync -ConfigPath $cfg -Health

# 2. dry run for exactly that result - uploads nothing, moves nothing
powershell -NoProfile -ExecutionPolicy Bypass -File $sync -ConfigPath $cfg -DryRun -OnlyFile "<exact name>_cut.csv"
powershell -NoProfile -ExecutionPolicy Bypass -File $sync -ConfigPath $cfg -DryRun -OnlyFile "<exact name>_print.csv"

# 3. the one-shot upload: cut first, then print. Every other file is left alone.
powershell -NoProfile -ExecutionPolicy Bypass -File $sync -ConfigPath $cfg -Once -OnlyFile "<exact name>_cut.csv"
powershell -NoProfile -ExecutionPolicy Bypass -File $sync -ConfigPath $cfg -Once -OnlyFile "<exact name>_print.csv"
```

One file name per command: with `-File`, a comma list is passed as a single name and would match nothing.
`-OnlyFile` filters after the cutoff, so the chosen result must be newer than `NotBeforeUtc`.

Expected in the log: `upload_succeeded` for each file, `jobinfo_result … outcome=applied` for a composite
CMYK + clear job, `moved_to_processed`. Then check in the ERP that the rows are linked to the right job
and item and that ink and copy count are right. That check is the "live Patch F validation".

---

## 7. Register the task (only after section 6 passed)

In an **elevated** PowerShell (Run as administrator), signed in as `golde`:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\register-mimaki-result-sync-task.ps1"
```

The script's own header says "as the shop user"; that is right about the account, but a task with a logon
trigger can normally only be created from an elevated window. A non-elevated run is expected to stop at
the registration step with "Access is denied", after the YES prompt, with nothing changed.

What the script does: checks the script and config exist, refuses if the task already exists, refuses if
`IncomingFolder` is not the `UCJV-300` folder or `NotBeforeUtc` is empty, runs a **dry run** and lists
what would be uploaded, and then asks you to type `YES`. Only then it creates the task (at logon of the
current user, restart 3 × 5 minutes, no time limit) and **starts it immediately** — the first pass uploads
every result the dry run listed.

Read the dry-run list before typing YES. If it is longer than expected, answer anything else, fix
`NotBeforeUtc` (section 2) and run it again.

### Verify

```powershell
Get-ScheduledTask -TaskName "GSO Mimaki Result Sync" | Select-Object TaskName, State
Get-ScheduledTask -TaskName "GSO Mimaki Result Sync" | Get-ScheduledTaskInfo | Select-Object LastRunTime, LastTaskResult
Get-Content "\\SynologyNAS\GSOP\GSOP\rip-logs\sync-logs\gso-rasterlink-sync-$(Get-Date -Format yyyyMMdd).log" -Tail 20
```

Expected: `State = Running`; `LastTaskResult = 267009` (still running); the log starts with
`watcher_started … mode=poll` and shows `upload_succeeded` / `duplicate_accepted` and `moved_to_processed`
lines, no `fatal_config`, no `moved_to_error`.

### Disable / roll back

Elevated PowerShell:

```powershell
Stop-ScheduledTask    -TaskName "GSO Mimaki Result Sync"
Disable-ScheduledTask -TaskName "GSO Mimaki Result Sync"
```

Nothing is deleted. Results already imported stay in the ERP; files already moved stay in
`processed-live`. Re-enable with `Enable-ScheduledTask` and `Start-ScheduledTask`.

---

## 8. Flags — unsafe or stale things in `C:\GSO-RIP-Result-Sync`

| Item | Finding |
|---|---|
| `gso-mimaki-result-sync-config.json` | Holds the **exposed** upload token. Rotate before enabling (the rotation helper updates this file). |
| 34 results already past the cutoff | The first pass after registration uploads them all (section 2). Decide the cutoff before typing YES. |
| No reboot coverage beyond logon | Same as the Print Intake Agent: starts only when `golde` signs in. Restart on failure is 3 × 5 minutes and there is no watchdog trigger, so after three failed restarts it stays down until the next logon. |
| Logging can end the watcher | `Write-SyncLog` (`gso-rasterlink-sync.ps1:88–96`) throws when the NAS log cannot be written and the poll loop (`:580–598`) has no guard — the failure that stopped the Print Intake Agent on 2026-11-19 before its v1.10 fix. Port that fix before relying on this watcher unattended. |
| NAS down looks like "nothing to do" | The folder listing ignores errors (`:583`). No log line, no alert. |
| No heartbeat | Nothing in the ERP shows this watcher is down (section 3). |
| Results stranded in `error-live` after an outage | Section 5. Someone has to look in that folder. |
| `register-mimaki-result-sync-task.ps1` header | Says to run as the shop user without mentioning elevation (section 7). Otherwise consistent with this document. |
| `disable-old-roland-task-ELEVATED.ps1` | Stale: its job is done (`GSO Roland Result Sync` is Disabled). Harmless if run again. |
| `previous-roland-task-definition-20261118.xml` | Backup of the old Roland task. **Do not re-register it**: it starts at boot and runs the old clone's script and config (`…\wholesale-lite-mvp\tools\`). |
| Folder permissions | `Authenticated Users: Modify` on the folder: any signed-in Windows user can edit the script or read the config. Acceptable on a single-user RIP PC; tighten if more accounts are added. |

`GSO Roland Result Sync` (for the record): Disabled; startup trigger; last ran 2026-08-11 14:28:44, result
`0x40010004` (terminated); action points at the old clone. Leave it disabled. Roland stays manual CSV.
