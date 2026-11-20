# GSO Print Intake — runtime, reboot safety, failure behaviour, token rotation

> **UPDATE 2026-11-20, 10:25 AM (after this audit was written):** watcher **v1.11 was installed and is
> running**. It was first run read-only against the live configuration (clean), the task was stopped,
> v1.10 was kept beside it as `gso-print-intake-agent.v1.10-backup-20261120.ps1`, and the task was started
> again. Where the text below says v1.11 is "not installed" or describes v1.10 as "the installed
> version", read it as history: sections 3 and 4 now describe the previous and the current version.
> Roll back: stop the task, copy the v1.10 backup over the script, start the task.

> **UPDATE 2026-11-20, afternoon (repository only — nothing live was changed):** the helper scripts were
> reworked and this document's commands match them exactly. `register-print-intake-startup-task-ELEVATED.ps1`
> no longer adds a "relaunch" trigger and refuses `-RunWhetherLoggedOn`; a separate **health watchdog**
> (`tools/print-intake-watchdog.ps1`, section 7) restarts the existing task only when the watcher is stale;
> `rotate-print-intake-token.ps1` gained `-RestartWatcher` (section 6). Section 8 lists the remaining
> logging-only weaknesses found in watcher v1.11 with the exact lines to change. None of these files has
> been copied to `C:\GSO-Print-Intake-Agent` and no task was started, stopped, registered or edited.

Audited 2026-11-20 on the live RIP PC (`DESKTOP-KD7NQTS`), read-only. Nothing on the live system was
changed by this audit: no task was started, stopped or edited, nothing in `C:\GSO-Print-Intake-Agent` or
`C:\GSO-RIP-Result-Sync` was written, and no token value appears anywhere in this document.

Contents

1. Live state
2. Reboot-safe design — the recommendation and what James does
3. What the watcher does when something fails (v1.10, installed)
4. Watcher v1.11 — in the repository, NOT installed
5. Heartbeat and the ERP banner
6. Token rotation runbook
7. The health watchdog
8. Watcher v1.11 — remaining logging-only weaknesses (audit, not applied)

---

## 1. Live state (2026-11-20)

| Task | State | Trigger | Last run | Last result | Runs |
|---|---|---|---|---|---|
| `GSO Print Intake Agent` | **Running** | At logon of `golde` | 2026-11-19 21:39:21 | `0x41301` (still running) | `C:\GSO-Print-Intake-Agent\gso-print-intake-agent.ps1 -ConfigPath C:\GSO-Print-Intake-Agent\gso-print-intake-agent-config.json -Loop` |
| `GSO Roland Result Sync` | **Disabled** | At startup (inert while disabled) | 2026-08-11 14:28:44 | `0x40010004` (process was terminated) | old clone: `...\wholesale-lite-mvp\tools\gso-rasterlink-sync.ps1` with `gso-roland-sync.config.json` |
| any task named `*Mimaki*` or `*Result Sync*` | none other exists | — | — | — | — |

**No Mimaki result-sync task exists, so none is enabled.** The only two GSO tasks on the PC are the two above.

Print Intake Agent task settings: logon type `InteractiveToken`, run level `HighestAvailable`,
`MultipleInstancesPolicy = IgnoreNew`, restart on failure 10 times / 1 minute, no execution time limit,
`StartWhenAvailable = true`, `DisallowStartIfOnBatteries = true`, `StopIfGoingOnBatteries = true`
(no battery or UPS is reported to Windows today, so the two battery settings do nothing — they would
stop the watcher on a power blip if a USB-connected UPS is ever added).

Installed watcher = repository v1.10, byte for byte, at audit time
(SHA-256 `629A0408…FEC47B0` for both files, before the v1.11 edit described in section 4).
The watcher process started 2026-11-19 21:39:21 in the interactive session and was writing the NAS log
at 09:54 today. Measured pass time today: about **125 seconds** per pass with 31 held files.

Other facts read from the PC:

- Windows automatic sign-in is **not** configured (`AutoAdminLogon` is empty). Last boot 2026-11-14.
- "Require Windows Hello sign-in for Microsoft accounts" is on (`DevicePasswordLessBuildVersion = 2`),
  so the `netplwiz` "users must enter a user name and password" checkbox is hidden.
- Automatic restart sign-on after Windows Update is not switched off for this user (default = on).
- Credential Manager holds `Domain:target=SynologyNAS` (and `192.168.1.2`, `gsop`) for this user.
- Both hot folders exist: `C:\MijCtrl\Hot\UCJV-300` and `C:\ProgramData\Roland DG VersaWorks7\Printers\LG-640\Input-A`.
- VersaWorks is running in the interactive session. `C:\GSO-Print-Intake-Agent` and
  `C:\GSO-RIP-Result-Sync` are writable by every signed-in user (`Authenticated Users: Modify`).

---

## 2. Reboot-safe design

### The fact that decides it

RasterLink and VersaWorks only run inside a signed-in Windows session. After a reboot, until somebody (or
Windows itself) signs in as `golde`, **nothing can print** — a watcher that runs without a session would
only pile files into hot folders that no RIP is reading. So "reboot-safe" for this PC means "the session
comes back", not "the watcher runs without a session".

### The four options, for this PC

| | A. Logon task + Windows automatic sign-in | B. Non-interactive task (stored password) | C. Watchdog on the existing task | D. Windows service |
|---|---|---|---|---|
| NAS access (`\\SynologyNAS\...`) | Yes — same profile, same saved NAS credential as today | Uncertain. With a stored password the profile's saved NAS credential is normally usable, but it must be proven on this PC. With "do not store password" (S4U) there are **no** network credentials: the UNC paths fail | Yes — it is today's task | As LocalSystem: no (the NAS does not know the PC account). As the user: same uncertainty as B |
| Hot folders (local disk) | Yes | Yes, but no RIP is running to read them until someone signs in | Yes | Yes, same caveat as B |
| RasterLink / VersaWorks | Back after the reboot (session exists) | **Not running** until a person signs in | Only once someone has signed in | Not running until a person signs in |
| Credentials | The Microsoft-account password is stored on the PC by the sign-in tool (LSA secret). A passwordless account cannot do this | The Microsoft-account password is stored by Task Scheduler. The account must be given as `MicrosoftAccount\<email>` — the local alias `DESKTOP-KD7NQTS\golde` is what failed before. PIN does not work | None | Password stored by the service manager (as the user), or none (LocalSystem, no NAS) |
| Restart behaviour | Logon trigger + restart 10 × 1 min (unchanged) | Startup trigger + restart on failure | Adds a health check every N minutes for as long as the user is signed in: the existing task is started when it is down, and stopped + started when the watcher is stale (section 7) | Service recovery actions; needs a third-party wrapper to run a PowerShell script as a service |
| Duplicate watchers | No — one task, `IgnoreNew` | Risk if the old logon task is left beside a new one | No — same task, `IgnoreNew` | Risk: service and task could both run |
| What James does | Run one command (below) + set up sign-in once | Enter the Microsoft-account password into Task Scheduler and prove the NAS works in the background session | Run one command | Install a wrapper, create a service, enter a password |
| Risk | Anyone at the PC after a reboot has a signed-in admin session. A changed account password silently breaks the sign-in | Already failed once on this PC. Breaks silently on a password change. Files queue in hot folders with no RIP | Does not help while nobody is signed in | Most moving parts, new software on the live RIP PC, same credential problem |

### Recommendation: **A** — keep the logon-triggered task and have Windows sign in by itself

It is the only option that brings back the whole print station (session, NAS credential, both RIPs and the
watcher) and it leaves the working task exactly as it is. The health watchdog from option C is installed
beside it by the one command below — it is what would have restarted the watcher after it stopped at
4:47 PM on 2026-11-19, and it does nothing while the watcher is healthy.

B and D are not recommended: they need the Microsoft-account password in a place that already failed, and
even when they work the RIPs are still not running. Do not retry the credential route.

### What James does

**Step 1 — install the health watchdog (2 minutes).** In an **elevated** PowerShell (Run as
administrator), signed in as `golde`, from the repository folder:

```powershell
# a. put the watchdog script into the install folder (a copy; nothing is started)
Copy-Item ".\tools\print-intake-watchdog.ps1" "C:\GSO-Print-Intake-Agent\print-intake-watchdog.ps1" -Force
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-Print-Intake-Agent\print-intake-watchdog.ps1" -SelfTest
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-Print-Intake-Agent\print-intake-watchdog.ps1" -Once -WhatIf

# b. preview, then apply
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\register-print-intake-startup-task-ELEVATED.ps1" -WatchdogMinutes 5 -WhatIf
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\register-print-intake-startup-task-ELEVATED.ps1" -WatchdogMinutes 5
```

- `-SelfTest` ends with `self-test failures: 0`. `-Once -WhatIf` prints one line with what the watchdog
  sees right now and what it would do (expected today: `health_healthy … last sign of life N min ago`); it
  stops, starts and writes nothing.
- The `-WhatIf` preview of the register script reads the tasks and changes nothing. With the task as it
  is today (IgnoreNew, no time limit, restart 10 × 1 min) it lists **one** change:
  ```
  - watchdog: register the task 'GSO Print Intake Watchdog' (same user / logon type / run level as the watcher; at logon; IgnoreNew): powershell.exe … -File "C:\GSO-Print-Intake-Agent\print-intake-watchdog.ps1" -Loop -TaskName "GSO Print Intake Agent" -InstallPath "C:\GSO-Print-Intake-Agent" -CheckMinutes 5 -StaleMinutes 15
  ```
  and no change to the watcher task.
- The second line asks "Are you sure?", registers the watchdog task, starts **the watchdog** (never the
  watcher) and prints how to pause and remove it. Run it twice: the second run says
  `Already configured - nothing to change. No backup written.`
- Other switches: `-StaleMinutes N` (default 15) — how long the watcher may show no sign of life;
  `-NoStart` — register the watchdog but start it at the next sign-in; `-AddStartupTrigger` — also add an
  "At startup" trigger to the watcher task (off by default: nearly useless on an interactive task).
- **`-RunWhetherLoggedOn` is refused**: the script explains why and exits without changing anything.

Check / pause / remove the watchdog:

```powershell
Get-ScheduledTask -TaskName "GSO Print Intake Watchdog" | Select-Object TaskName, State
Get-Content "C:\GSO-Print-Intake-Agent\print-intake-watchdog-$(Get-Date -Format yyyyMMdd).log" -Tail 10
# pause (before maintenance) / resume
New-Item -ItemType File -Path "C:\GSO-Print-Intake-Agent\print-intake-watchdog-hold.txt"
Remove-Item "C:\GSO-Print-Intake-Agent\print-intake-watchdog-hold.txt"
# remove it completely (elevated)
Stop-ScheduledTask -TaskName "GSO Print Intake Watchdog"; Unregister-ScheduledTask -TaskName "GSO Print Intake Watchdog" -Confirm:$false
```

**Step 2 — Windows signs in by itself after a reboot (James's decision, once).** This stores the
Microsoft-account password on the PC, so it is his call:

1. Run Microsoft Sysinternals **Autologon**. User name = the Microsoft-account e-mail of the `golde`
   profile, domain = `MicrosoftAccount`, password = the Microsoft-account **password** (not the PIN). Enable.
2. Reboot once and confirm: the desktop appears without typing anything, VersaWorks and RasterLink start,
   and Incoming Print Files shows the green banner within a few minutes.
3. If the account has no password at all (passwordless), this step is not possible; then the rule is
   "after any reboot, someone signs in" and the red banner (section 5) is the reminder.

Until step 2 is done the PC behaves as it does today: after a reboot the watcher starts when someone
signs in. Restarts caused by Windows Update normally sign back in by themselves already (the default
"use my sign-in info to finish setting up after an update" is not switched off on this PC); a power cut
does not.

### What `tools/register-print-intake-startup-task-ELEVATED.ps1` does and does not do

- **Watcher task — settings only.** No time limit, `IgnoreNew`, restart on failure at least 3 × 1 minute
  (the existing 10 × 1 minute is kept). The action, the user, the logon type (`InteractiveToken`), the run
  level, the logon trigger and every other trigger stay as they are; the script refuses to apply a plan in
  which the principal or the action would differ. On this PC today that means **no change at all** to the
  watcher task.
- **It removes the old "relaunch" trigger** (`GsoPrintIntakeWatchdog`) if an earlier version of the script
  added it. That trigger only checked "is the task running" and re-launched the watcher every few minutes
  after a deliberate safety stop. (It was never applied on this PC.)
- **Health watchdog task** `GSO Print Intake Watchdog` (with `-WatchdogMinutes N`): same user, same logon
  type, same run level as the watcher task, starting 3 minutes after logon, `IgnoreNew`. Section 7.
- **Never:** starts or stops the watcher; registers a second watcher task (it refuses when another enabled
  task runs the watcher script); converts the logon mode; asks for, stores, prints or passes a password;
  touches Windows automatic sign-in. `-RunWhetherLoggedOn` is refused with an explanation — that was
  option B, and it pre-filled the local alias (`DESKTOP-KD7NQTS\golde`) that already failed for this
  Microsoft-account profile.
- **Backups and undo.** A task is exported into `C:\GSO-Print-Intake-Agent` before it is changed
  (`print-intake-task-backup-<stamp>.xml`, `print-intake-watchdog-task-backup-<stamp>.xml`) and the exact
  undo line is printed. Nothing to change = no backup written.
- It does not change the two battery settings (see section 1).
- **Not run yet.** Checked with the Windows PowerShell 5.1 and PowerShell 7 parsers; its planning functions
  were exercised in memory against the live task's exported definition (read-only), and the task XML it
  would register was validated by Task Scheduler in memory without registering it.

---

## 3. What the watcher does when something fails (v1.10 — the installed version)

Line numbers are for `gso-print-intake-agent.ps1` v1.10 (the installed file).

| Failure | What happens in v1.10 | Loop survives? | File routed twice? | File lost? |
|---|---|---|---|---|
| NAS log write fails | `Write-IntakeLog` tries 3 times, then writes `gso-print-intake-local-YYYYMMDD.log` beside the script; never throws (116–133) | Yes | No | No |
| A scan pass throws | Caught by the pass guard, logged as `pass_error`, next pass retries (792, 837–839) | Yes | No | No |
| NAS not reachable at start (not mounted yet at logon) | **Not fatal.** The config is on `C:`; `agent_started` goes to the local log; the ledger reads as empty (177–189); the folder listing returns nothing (311); the watcher idles and picks up when the NAS answers | Yes | See "ledger" row | No |
| NAS drops mid-run | Per-file error → `file_error`, file left in place (834). A claim file that could not be removed blocks that file for `ClaimStaleMinutes` (30) after the NAS returns (148–151) | Yes | No | No (delayed up to 30 min) |
| Ledger unreadable while the inbox is readable | The ledger is treated as **empty** with no log line (180–181, `SilentlyContinue`). A routed file still sitting in the inbox would be planned and copied again | Yes | **Possible** | No |
| Hot folder not reachable | `hot_folder_unreachable`, retried next pass (506–509). The ERP row already says `routed` (set at plan time) | Yes | No | No |
| ERP / API not reachable | Heartbeat call ignored (800–808); `plan_unreachable`, retry next pass (466–469); held files `disposition_unreachable` (426–430). A `routed` report that fails is **ignored** (520): the file is delivered but the job has no "print file routed" record | Yes | No | No (ERP record may be missing) |
| Config missing or malformed | `Read-IntakeConfig` throws before any logging (774): the hidden process ends with exit 1 and **nothing is written anywhere**. Task Scheduler retries 10 times, then stops | No (by design) | No | No |
| Token rejected (401/403) | Only a **plan** call stops the agent (exit 2, 470–473, 832). With nothing new to plan it keeps looping with a dead token; only the banner shows it | Stops on the next new file | No | No — the file is not copied, not moved, not ledgered |
| Short network loss | Same as the NAS / API rows; everything is retried on the next pass | Yes | No | No |
| Second watcher started | The task cannot start twice (`IgnoreNew`). A watcher started by hand runs beside it; `.gsoclaim` files (139–156) stop both working on one file at the same moment, but each reads its own ledger snapshot | Yes | Unlikely, not excluded | No |
| Stale `.gsoclaim` | Removed after `ClaimStaleMinutes` (30) and the file is processed (148–151) | Yes | No | No (delayed 30 min) |
| Process crash / kill mid-file | Restarted by Task Scheduler (10 × 1 min) or at the next logon. The claim blocks that file for 30 minutes. If the crash was after the copy and before the ledger line (526), the file is copied again | Restarted | **Possible** (narrow) | No |
| **G4** — copy and report succeeded, archive move throws | No ledger line is written (it came after the move, 524–527). The next pass plans and copies the file again, **every pass** until the move works | Yes | **Yes** | No |

### G4 — does the server stop the second copy? No.

- `app/routes/api.print-intake.route-plan.tsx:99–104` refuses only a **rejected** hash.
- A hash that is already `routed` and matches its job again falls through to the normal match and gets
  `decision: "route"` again (`:263–313`). The row is set to `routed` at **plan** time (`:287–289`), so the
  server cannot tell "planned" from "delivered".
- `dispositionOf` (`app/lib/print-intake-review.server.ts:94`) does answer `already_routed`, but the watcher
  only asks it for hashes that are **in** its ledger as needs-review/rejected — never for a hash missing
  from the ledger.

Reproduced offline (temp folders, stubbed server, original held open so the move fails): v1.10 produced a
second file in the hot folder on the second pass and re-copied on every pass; v1.11 produced exactly one.
This happens in practice when someone has the original open (a preview, an Adobe application) at the
moment the watcher archives it. The NAS logs for 2026-11-19 and 2026-11-20 contain no `file_error`, so it
has not been seen since v1.10 was installed.

A server-side guard would be the complete fix and is **not built**: record a delivered-at time when the
`routed` report arrives, and have route-plan answer `review` with reason `already_delivered` for a hash
that has one, unless its status is `retry_allowed` / `assigned`.

---

## 4. Watcher v1.11 — in the repository, NOT installed

`tools/gso-print-intake-agent.ps1` is now v1.11. `C:\GSO-Print-Intake-Agent\gso-print-intake-agent.ps1` is
still v1.10 and was not touched. Checks run on the repository copy: PowerShell 5.1 and 7 parser, 0 errors;
`-SelfTest`, 69 PASS / 0 FAIL; the offline G4 simulation above. The live loop was **not** run with v1.11.

Every existing safety exit is unchanged: 2 (token), 3 (flood cap), 4 (no cutoff), 5 (dry run not honoured).

| # | Change | Why | Where (v1.11) |
|---|---|---|---|
| 1 | The `routed` ledger line (and an in-memory record) is written right after the verified copy, **before** the report and the archive move. The archive move has its own `try`; a failure logs `archive_move_failed` and leaves the original in place | G4: no second copy to the press | 638–665 |
| 2 | A ledger line that cannot be written is kept in memory and retried every pass; a file routed in this run stays routed for the rest of the run | The ledger lives on the NAS | 272–287, 1009–1011 |
| 3 | `Read-IntakeLedger` **fails closed**: log folder unreachable or read error → the pass is skipped (`pass_error`), never an empty ledger | An empty ledger makes routed files look new | 243–262 |
| 4 | The `routed` report is retried 3 times on no-answer / 5xx; a lost report is logged as `report_failed` | The report is what records the print file on the job | 344–352, 652–655 |
| 5 | A claim left by a **dead process on this PC** is reclaimed at once; a claim that could not be released is retried next pass | No 30-minute wait after a crash or a NAS drop | 194–200, 216, 289–293, 677 |
| 6 | One `-Loop` watcher per PC (named mutex). A second one logs `duplicate_instance` and exits **6**. `-Once`, `-DryRun`, `-Health`, `-SelfTest` never take the lock | A hand-started second watcher | 168–183, 989–996 |
| 7 | A config that cannot be loaded writes one `config_error` line to the local log beside the script, then exit 1. A JSON parser message is reduced to its exception type so no piece of the file (which holds the token) can be logged | The hidden process used to die silently | 149–162, 969–974 |
| 8 | The ERP's own "token not accepted" answer on the once-per-pass status call stops the agent with exit 2 (a bare proxy 403 does not) | A rotated token used to be noticed only when a new file arrived | 356–360, 1018–1024 |
| 9 | The same `pass_error` repeated every pass is logged once, then every 20th time | With change 3, a NAS outage would otherwise write a line every 30 s | 1061–1070 |

Behaviour that changes for the shop, stated plainly:

- With change 3, while the NAS log folder cannot be read the watcher processes nothing **and sends no
  heartbeat**, so the banner turns red after 15 minutes. In v1.10 it stayed green while blind.
- With change 1, a file whose archive move failed stays in Prints For Today and is skipped
  (`ledger_skip`) from then on. Someone moves it by hand. It is not printed twice.
- With change 8 plus Task Scheduler's restart-on-failure, a watcher with a dead token stops and is
  relaunched once a minute up to 10 times, re-reading the config each time.

Version pins updated from 1.10 to 1.11 in seven existing test files; new source-pin tests in
`tests/print-intake-watcher-recovery-2026-11-20.test.ts` (23 tests, passing).

### Still open after v1.11 (not fixed — each needs a decision or a server change)

- Crash in the instant between the copy and the ledger line still allows one second copy after restart.
  Only the server-side guard in section 3 closes it.
- `Copy-Item` writes straight to the final name in the hot folder; a copy interrupted half-way can leave
  a partial file that the RIP may pick up. A temp-name-then-rename copy needs a test with both RIPs first.
- The ERP row says `routed` from the moment of the plan, even if the hot folder was unreachable.
- Held files are re-checked every pass (two log lines and one ERP call each): about 2 MB of log per day
  with 31 held files, and no log rotation.

### If the lead engineer decides to install it (not done; elevated PowerShell)

1. Wait until the last lines of today's NAS log are only `detected` / `ledger_skip` (nothing being routed).
2. `Stop-ScheduledTask -TaskName "GSO Print Intake Agent"`
3. Copy `C:\GSO-Print-Intake-Agent\gso-print-intake-agent.ps1` to `gso-print-intake-agent.v1.10-backup-20261120.ps1` in the same folder, then copy the repository `tools\gso-print-intake-agent.ps1` over it.
4. `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-Print-Intake-Agent\gso-print-intake-agent.ps1" -SelfTest` → `self-test failures: 0`.
5. `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-Print-Intake-Agent\gso-print-intake-agent.ps1" -ConfigPath "C:\GSO-Print-Intake-Agent\gso-print-intake-agent-config.json" -Health` → cutoff shown, token accepted, folders reachable.
6. `Start-ScheduledTask -TaskName "GSO Print Intake Agent"`; the NAS log shows `agent_started ... version=gso-print-intake-agent/1.11`; the banner is green within a few minutes.
7. Roll back: stop the task, copy the v1.10 backup over the script, start the task.

---

## 5. Heartbeat and the ERP banner

- **Stamp.** Once per pass the watcher posts `{ token, pending: true, agentVersion, agentHost }` to
  `/api/print-intake/status`. After the token check (`app/routes/api.print-intake.status.tsx:28–31`) the
  server sets `PrintLogAutoImportSetting.intakeAgentLastSeenAt` (plus version and host) (`:37–51`).
  A failed stamp never fails the call.
- **Status.** `app/lib/print-intake-heartbeat.ts`: never checked in → `never`; more than
  `WATCHER_STALE_AFTER_MINUTES = 15` minutes ago → `stale`; otherwise `ok`.
- **Banner.** `app/routes/app.erp.print-intake.tsx:96` (loader) and `:344–348`:

| State | Colour | Text |
|---|---|---|
| `ok` (seen ≤ 15 min ago) | green | "The print-file watcher is running (checked in N min ago)." |
| `never` | amber | "The print-file watcher has not checked in yet…" |
| `stale` (> 15 min) | red | "…has not checked in for N minutes. New files are NOT being picked up. On the RIP PC, start the task "GSO Print Intake Agent" (or sign in to Windows)." |

Gaps:

1. The banner is **only** on Incoming Print Files. It is not on the Production Board
   (`app.erp.production-board.tsx`) or Home (`app._index.tsx`), and nothing notifies anyone. The page works
   out the state when it loads; a tab left open stays green.
2. Green means "the loop is alive, the ERP answers and the token is accepted". In v1.10 it does **not**
   mean the NAS is readable (v1.11 change 3 fixes that) and it never reflects an unreachable hot folder.
3. Timing margin. The stamp is made at the start of a pass, so the gap between stamps is one pass plus
   `PollSeconds`. Measured today: about 125 s with 31 held files — far inside 15 minutes. The first pass
   after a restart hashes every held file again (about 5 minutes for 31 × 200 MB); at the flood cap of 60
   large files that first pass is about 10 minutes, which is still green but with little room. The v1.10
   hash cache keeps every later pass short.
4. The stored `intakeAgentVersion` / `intakeAgentHost` are not shown anywhere in the ERP; the running
   version is only visible in the NAS log (`agent_started … version=`).

---

## 6. Token rotation runbook

The Print Intake upload token was exposed during troubleshooting and must be replaced.

### Where the token lives

- **Server:** `PrintLogAutoImportSetting.uploadToken` (`prisma/schema.prisma:1212`, unique, one per shop).
  The same token authorises every agent endpoint: `api.print-intake.route-plan.tsx:65`,
  `api.print-intake.report.tsx:47`, `api.print-intake.status.tsx:30`, `api.rip-imports.upload.tsx:124`,
  `api.print-logs.upload.tsx:54`, `api.quote-rip-results.sync.tsx:180`.
- **Regenerate action: it exists.** `app/routes/app.erp.print-log-settings.tsx:134–150`
  (`intent = "rotateToken"`), button "Rotate token" at `:224–227`. The action is **owner only**
  (`requireOwner`, `:98`) — the Shopify account owner, or a staff user ID listed as owner. An authorised
  manager can open the page (`:54`) but cannot rotate. The new token is shown **once** (`:218–223`); the
  old one stops working in the same instant. `app.erp.print-intake.tsx` has no rotate action of its own;
  it links to Print Log Settings (`:570–577`).
- **Local files that hold the token on this PC** (key name `UploadToken` in each; all five hold the same
  57-character value today):

| File | Read by | In the rotation |
|---|---|---|
| `C:\GSO-Print-Intake-Agent\gso-print-intake-agent-config.json` | the running watcher | **update** |
| `C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json` | nothing yet (Mimaki sync is not registered) | **update** (so enablement works later) |
| `C:\Users\golde\GSO-ERP-WORKSPACE\wholesale-lite-mvp\tools\gso-print-intake-agent-config.json` | nothing (old clone) | leave — the token in it dies with the rotation |
| `C:\Users\golde\GSO-ERP-WORKSPACE\wholesale-lite-mvp\tools\gso-rasterlink-sync.config.json` | nothing (old clone) | leave |
| `C:\Users\golde\GSO-ERP-WORKSPACE\wholesale-lite-mvp\tools\gso-roland-sync.config.json` | the **disabled** Roland task | leave — if that task were ever enabled it would be refused (403) and stop |

  A text search of the workspace and both runtime folders (`.ps1`, `.txt`, `.md`, `.log`, `.xml`, `.env`)
  found the token in no other file.

### The window, honestly

From the click on "Rotate token" until the watcher has been restarted with the new config, the watcher is
**not authorised**. It reads its config only at start, so the restart is required. With the steps below the
window is about two minutes.

What happens to files in that window (v1.10, from the code):

- The heartbeat call is refused, so nothing is stamped; the banner turns red if the window exceeds 15 minutes.
- Held files: the disposition call is refused → `disposition_unreachable`, file untouched (426–430).
- A new file: the plan call is refused → `fatal_config` is logged, the claim is released, the agent stops
  with exit 2 (470–473, 537–539, 832). The file was **not copied, not moved and not written to the
  ledger**. It waits in Prints For Today and is processed after the restart. **Nothing is lost.**
- One edge: a file whose plan was answered just before the rotation is still delivered and archived, but
  its `routed` report is refused and (in v1.10) not retried — the job would lack its "print file routed"
  record. Avoid it by rotating while the inbox is quiet (step 2).

### Steps, in order

Do it at the RIP PC, with the ERP open in a browser **on that PC**, so the token is pasted and never
retyped. One **elevated** PowerShell window in the repository folder is used for every command.

1. **Preview the local half.** Nothing is asked or changed:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\rotate-print-intake-token.ps1" -RestartWatcher -WhatIf
   ```
   Expected: two `FOUND UploadToken (set, 57 chars)` lines and two `PREVIEW ONLY` lines.
2. **Check the inbox is quiet.** The last lines of today's log must be `detected` / `ledger_skip` only:
   ```powershell
   Get-Content "\\SynologyNAS\GSOP\GSOP\print-intake\agent-logs\gso-print-intake-$(Get-Date -Format yyyyMMdd).log" -Tail 12
   ```
3. **Pause the watchdog** (only if it is installed — section 7), so it does not act in the middle:
   ```powershell
   New-Item -ItemType File -Path "C:\GSO-Print-Intake-Agent\print-intake-watchdog-hold.txt"
   ```
4. **Generate the new token (owner, in the ERP).** Embedded admin → Print Log Settings
   (`/app/erp/print-log-settings`) → **Rotate token**. Copy the value from the yellow "New token — shown
   ONCE" box. Do not reload the page, do not paste it into a document, chat or e-mail. *The window starts
   here: from this click the running watcher's token is dead.*
5. **Write it into the two runtime configs and restart the watcher** — one command:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\rotate-print-intake-token.ps1" -RestartWatcher -ClearClipboard
   ```
   Paste the token at both hidden prompts (`Read-Host -AsSecureString`; nothing is shown). The script:
   backs up each config beside itself (`….before-token-rotation-<stamp>.json`), changes only the
   `UploadToken` value in `C:\GSO-Print-Intake-Agent\gso-print-intake-agent-config.json` and
   `C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json` (any other path is refused), reads each
   file back and checks it is valid JSON with only the token changed, then stops and starts the
   **existing** task `GSO Print Intake Agent` and waits for a fresh log line.
   Expected: two `UPDATED UploadToken (set, 57 chars)` lines, `2 updated, 0 already current, 0 failed`,
   then `Fresh log line: [agent_started], no [agent_stopped] after it; task state: Running. The watcher
   runs with the new token.` *The window ends here.* It never prints a token and writes no log file.
   If it says it could not restart the task (window not elevated), run the two lines it prints.
6. **Verify the new token** (writes nothing) — the script prints this line too:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-Print-Intake-Agent\gso-print-intake-agent.ps1" -ConfigPath "C:\GSO-Print-Intake-Agent\gso-print-intake-agent-config.json" -Health
   ```
   Expected line: `token accepted: OK (400 missing-fileName as expected, nothing written)`.
7. **Verify the heartbeat.** Open Incoming Print Files (`/app/erp/print-intake`): the banner is **green**
   and says "checked in just now" / "N min ago" with N small. The NAS log has a fresh `agent_started` line
   and no `agent_stopped` / `fatal_config` after it.
8. **Prove the old token is rejected.** Copy the three lines the script printed under "VERIFY … 3." (they
   read the old token from the backup written in step 5 and print only a status code):
   ```powershell
   $old = (Get-Content -LiteralPath "C:\GSO-Print-Intake-Agent\gso-print-intake-agent-config.before-token-rotation-<stamp>.json" -Raw | ConvertFrom-Json).UploadToken
   $api = (Get-Content -LiteralPath "C:\GSO-Print-Intake-Agent\gso-print-intake-agent-config.json" -Raw | ConvertFrom-Json).ApiBaseUrl
   try { Invoke-WebRequest -Uri ($api.TrimEnd('/') + '/api/print-intake/route-plan') -Method POST -ContentType 'application/json' -Body (@{ token = $old } | ConvertTo-Json) -UseBasicParsing | Out-Null; 'UNEXPECTED: the old token was accepted' } catch { 'old token -> HTTP ' + [int]$_.Exception.Response.StatusCode }
   $old = $null
   ```
   Expected: `old token -> HTTP 403`. (A token that is accepted answers 400 here, because no file name was sent.)
9. **Tidy up.** Delete the two `*.before-token-rotation-*.json` backups (they hold the old, now dead,
   token). Remove the watchdog hold file from step 3
   (`Remove-Item "C:\GSO-Print-Intake-Agent\print-intake-watchdog-hold.txt"`). Close the browser tab that
   showed the new token.

What the server does at step 4 (checked through the real action and endpoints in
`tests/mimaki-sync-and-watchdog-2026-11-20.test.ts`): only the owner can rotate (a manager, a print
operator and an unknown user get 403 and nothing changes); the new token is 24 random bytes from Node's
`crypto.randomBytes` and is returned once, in `rotatedTokenOnce`, and nowhere else; nothing is logged; from
that moment the old token is answered 401 / 403 by `api.print-intake.route-plan`, `.report`, `.status`,
`api.rip-imports.upload`, `api.print-logs.upload` and `api.quote-rip-results.sync`, and the new one is
accepted by all six. No defect was found in the rotate action; it was not changed. (The settings page
keeps showing the last four characters of the current token as `****abcd`; that is by design.)

### If something goes wrong

- **There is no way back to the old token.** Rotation overwrites it; no action sets a chosen value. The
  backup files restore a config file, not the token's validity.
- Step 5 or 6 fails (wrong paste, `THE WATCHER STARTED AND STOPPED AGAIN`, `token accepted: REJECTED`):
  repeat steps 4 to 6 — rotate again and paste again. Files keep waiting in Prints For Today meanwhile;
  nothing is lost.
- The watcher will not start after step 5: read the last lines of the NAS log and of
  `C:\GSO-Print-Intake-Agent\gso-print-intake-local-YYYYMMDD.log`. If the helper reported a failure for a
  file, it has already put that file back from its backup; run step 5 again.
- The ERP is unreachable at step 4: do not start; the old token stays valid until Rotate succeeds.

### Can it be done today?

Yes. The server action exists and needs no deploy. It must be done by the **owner** (the Rotate button is
refused for anyone else), at the RIP PC, with an elevated PowerShell for step 5. Nothing else blocks it.
Until it is done, the exposed token still authorises every agent endpoint listed above.

---

## 7. The health watchdog (`tools/print-intake-watchdog.ps1`)

Not installed. Install = section 2, step 1. It needs no token and talks to no server.

**What it reads (all local, read-only):**

1. The task: state, last start time, last exit code.
2. A heartbeat file, `C:\GSO-Print-Intake-Agent\gso-print-intake-heartbeat.txt`, if the watcher writes one.
   **Watcher v1.11 as installed does not** (the change is in section 8, item 6).
3. The newest line of the watcher's own log — the NAS log and the local fallback log
   (`gso-print-intake-local-YYYYMMDD.log`), whichever is newer. The log is opened shared, so the watcher's
   own writes are never blocked.

**What v1.11 lets it conclude today (log only):** v1.11 writes at least one line per waiting file per pass,
and nothing at all while the inbox is empty.

| Watcher log | Verdict | Action |
|---|---|---|
| a line within `-StaleMinutes` (15) | healthy | none |
| files were being processed, then silence for more than 15 minutes | **stale** | stop + start the existing task |
| last line is `scan_summary … eligible=0` (empty inbox) and old | cannot tell | **none** — logged as `health_idle_unknown` |
| last line is `pass_error` (alive, a pass keeps failing — NAS?) | degraded | none until 45 minutes of silence (repeats are logged only every 20th pass) |
| nothing readable (NAS log and local log) | unknown | none |

With the heartbeat file the watchdog can always tell: a file from the current run older than 15 minutes is
stale, whatever the log says.

**Threshold.** A pass takes about 2 minutes with 31 held 200 MB files, plus 30 s between passes. 15 minutes
is seven passes of margin and equals the limit after which the ERP banner turns red. After a start the
first pass re-hashes every held file (about 5 minutes for 31, about 10 at the flood cap of 60), so no
verdict is given for the first 15 minutes (`-StartupGraceMinutes`). Both are parameters.

**When the task is not running:**

| Situation | Action |
|---|---|
| a watcher process exists anyway (started by hand) | none — never a second watcher (v1.11 would exit 6 as well) |
| last exit 2 (token), 3 (flood cap), 4 (no cutoff), 5, 6, 1 (config), or stopped by a person | **deliberate stop**: nothing for 60 minutes (`-SafetyStopDelayMinutes`), then one start, then back off |
| anything else (crash) | start the existing task |
| the task is disabled, or the hold file exists | none |

**Back-off.** Every stop/start is counted. After an action that did not make the watcher healthy the next
one waits 30 minutes (`-BackoffMinutes`), then 60, 120 … at most once a day. The count resets when the
watcher is seen healthy. So a watcher that stops again on its flood cap or its dead token is retried a few
times a day, not every five minutes.

**It never:** registers a task, launches the watcher script, starts the task while a watcher is still
running (a restart is abandoned if the old watcher has not gone after 60 s), or touches a config.

**Log:** `C:\GSO-Print-Intake-Agent\print-intake-watchdog-YYYYMMDD.log` — one line when the verdict
changes and one for everything it does (`restart_begin`, `restart_done`, `start_done`, `restart_aborted`,
`*_failed`). State for the back-off: `print-intake-watchdog-state.json` beside it.

**Checked:** parser (5.1 and 7), `-SelfTest` 36 PASS / 0 FAIL (the decision table), and its signal reader
exercised in memory against the live task and log (read-only): verdict `healthy`, no action. **Not checked:**
a real stop + start by the watchdog, and whether Windows shows a console flash when the watchdog task
starts at logon (it runs as one long hidden process, like the watcher, so at most once per sign-in).

---

## 8. Watcher v1.11 — remaining logging-only weaknesses (audit 2026-11-20, NOT applied)

Read-only audit of `tools/gso-print-intake-agent.ps1` v1.11 (= the installed file, byte for byte). The
watcher was not edited. Line numbers are for that file. Items 1–3 are worth applying with the next watcher
change; 4–5 are low; 6 is the heartbeat file for the watchdog.

**1. `Write-Host` is outside every guard — lines 130 and 151.** `Write-IntakeLog` guards the file write but
not the console write. If the console write ever throws (no usable output handle), then: the `exit 2` at
1022–1023, the `exit 3` at 1046–1048 and the `exit 2` at 1056 are **never reached** (the pass guard catches
the exception and the loop carries on with a dead token / over the flood cap — nothing is processed, but it
never stops and never says why); and the same call inside the pass guard's own `catch` (1067), at start-up
(992, 995, 998) or at the end (1075) **ends the process**. Low probability under Task Scheduler, high
consequence.

```diff
@@ line 130 (Write-IntakeLog) and line 151 (Write-IntakeLocalLog)
-  Write-Host $line
+  try { Write-Host $line } catch { }
```

The bare `Write-Host` calls at 607–608, 981, 1047, 1050 and 1057 have the same weakness; 981 / 1047 / 1057
sit directly before an `exit`, so a throw there changes the exit code to 1. Same one-word fix
(`try { … } catch { }`) on each.

**2. The local fallback drops the line silently when the script folder is not writable — lines 143 and 152.**
`$PSScriptRoot` is tried once and the failure is swallowed (`catch { }`): with the NAS log down *and*
`C:\GSO-Print-Intake-Agent` not writable, every line — including `config_error`, `pass_error` and
`agent_stopped` — is lost and the failure is invisible. (Today the folder is writable by every signed-in
user, so this does not happen now.)

```diff
@@ line 143 (same change at line 152)
-    try { Add-Content -Path (Join-Path $PSScriptRoot ("gso-print-intake-local-" + (Get-Date -Format "yyyyMMdd") + ".log")) -Value $line } catch { }
+    foreach ($localDir in @($PSScriptRoot, (Join-Path $env:LOCALAPPDATA "GSO-Print-Intake-Agent"), $env:TEMP)) {
+      try { if (!(Test-Path -LiteralPath $localDir)) { New-Item -ItemType Directory -Path $localDir -Force | Out-Null }; Add-Content -Path (Join-Path $localDir ("gso-print-intake-local-" + (Get-Date -Format "yyyyMMdd") + ".log")) -Value $line; break } catch { }
+    }
```

**3. The heartbeat is sent while the inbox is unreadable — line 1017 (before the scan at 1034; listing at 430).**
v1.11 skips the pass (and the heartbeat) when the *log* folder is unreachable (line 250), but the inbox is
a different folder. `Get-ChildItem … -ErrorAction SilentlyContinue` (430, also 405 and 432) turns an
unreachable or renamed `Prints For Today` into "0 files": the log says `scan_summary eligible=0`, the
heartbeat is stamped, **the banner stays green and nothing is picked up.**

```diff
@@ after line 1010 (Merge-RoutedThisRun $ledger), before the heartbeat call
+  if (!(Test-Path -LiteralPath $config.PrintsForTodayFolder)) { throw "inbox_unavailable: Prints For Today is not reachable - nothing is processed and no heartbeat is sent until it is" }
```

The pass guard logs it as `pass_error` (once, then every 20th pass) and the banner turns red after 15
minutes. Still not covered: an unreachable hot folder (logged per file as `hot_folder_unreachable`, banner
green).

**4. A log expression can abort the whole pass — line 1028.** `([string]$pendingRow.hash).Substring(0,8)`
exists only to print `sha8=`; a pending row with a hash shorter than 8 characters throws inside the pass,
every pass, and nothing is processed while the server returns that row. (The server sends full SHA-256
hashes today.)

```diff
@@ line 1028
-          Write-IntakeLog $config "pending_retry" ([string]$pendingRow.fileName) "server requests re-processing (sha8=$(([string]$pendingRow.hash).Substring(0,8))) - ledger cache overridden"
+          Write-IntakeLog $config "pending_retry" ([string]$pendingRow.fileName) "server requests re-processing (sha8=$(([string]$pendingRow.hash + '00000000').Substring(0,8))) - ledger cache overridden"
```

**5. A failed ledger write after a review report — lines 621–622 and 672–673 (also 556–557, 561–562).** The
`needs_review` report has already been sent; if the ledger line then cannot be written the exception
becomes `file_error` (1058) and the in-memory ledger is not updated, so the file is planned and reported
again every pass until the ledger is writable. Not fatal, and visible as `file_error`; noisy.

```diff
@@ lines 621-622 (same at 672-673)
-        Add-IntakeLedgerEntry $Config $hash $File.Name "needs_review"
-        $Ledger[$hash] = "needs_review"
+        $Ledger[$hash] = "needs_review"
+        try { Add-IntakeLedgerEntry $Config $hash $File.Name "needs_review" } catch { Write-IntakeLog $Config "ledger_write_failed" $File.Name "needs_review line not written ($($_.Exception.Message)); checked again next pass (sha8=$sha8)" }
```

**6. Heartbeat file for the watchdog (new; closes the "empty inbox = cannot tell" gap of section 7).**

```diff
@@ after line 153 (end of Write-IntakeLocalLog)
+# Local sign of life for print-intake-watchdog.ps1 (no token, no network). Never throws.
+function Write-IntakeHeartbeat([string]$State) {
+  try { [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "gso-print-intake-heartbeat.txt"), ($State + " " + (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"))) } catch { }
+}
@@ line 1061
   $lastPassError = ""
+  if ($Loop -and -not $DryRun) { Write-IntakeHeartbeat "ok" }
@@ line 1070
     $lastPassError = $passError
+    if ($Loop -and -not $DryRun) { Write-IntakeHeartbeat "pass_error" }
```

The watchdog works without it (section 7) and uses it automatically once the running watcher writes it.

Checked and found sound: start-up before the loop (config errors go to the local log and exit 1, lines
969–974; no cutoff exits 4; a second instance exits 6); the NAS log write (three tries, then local, inside
`try`); the ledger read (fails closed, line 250); the `routed` ledger line (guarded, 645–650); the archive
move (guarded, 657–664); claim release (guarded, 677).
