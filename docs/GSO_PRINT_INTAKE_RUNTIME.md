# GSO Print Intake — runtime, reboot safety, failure behaviour, token rotation

> **UPDATE 2026-11-20, 10:25 AM (after this audit was written):** watcher **v1.11 was installed and is
> running**. It was first run read-only against the live configuration (clean), the task was stopped,
> v1.10 was kept beside it as `gso-print-intake-agent.v1.10-backup-20261120.ps1`, and the task was started
> again. Where the text below says v1.11 is "not installed" or describes v1.10 as "the installed
> version", read it as history: sections 3 and 4 now describe the previous and the current version.
> Roll back: stop the task, copy the v1.10 backup over the script, start the task.

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
| Restart behaviour | Logon trigger + restart 10 × 1 min (unchanged) | Startup trigger + restart on failure | Adds: relaunch within N minutes whenever the watcher is not running, for as long as the user is signed in | Service recovery actions; needs a third-party wrapper to run a PowerShell script as a service |
| Duplicate watchers | No — one task, `IgnoreNew` | Risk if the old logon task is left beside a new one | No — same task, `IgnoreNew` | Risk: service and task could both run |
| What James does | Run one command (below) + set up sign-in once | Enter the Microsoft-account password into Task Scheduler and prove the NAS works in the background session | Run one command | Install a wrapper, create a service, enter a password |
| Risk | Anyone at the PC after a reboot has a signed-in admin session. A changed account password silently breaks the sign-in | Already failed once on this PC. Breaks silently on a password change. Files queue in hot folders with no RIP | Does not help while nobody is signed in | Most moving parts, new software on the live RIP PC, same credential problem |

### Recommendation: **A** — keep the logon-triggered task and have Windows sign in by itself

It is the only option that brings back the whole print station (session, NAS credential, both RIPs and the
watcher) and it leaves the working task exactly as it is. The watchdog trigger from option C goes onto the
same task as part of the one command below — it is what would have restarted the watcher after it stopped
at 4:47 PM on 2026-11-19, and it costs nothing while the watcher is running.

B and D are not recommended: they need the Microsoft-account password in a place that already failed, and
even when they work the RIPs are still not running. Do not retry the credential route.

### What James does

**Step 1 — add the watchdog (today, 2 minutes).** In an **elevated** PowerShell (Run as administrator), from the repository folder:

```powershell
powershell -ExecutionPolicy Bypass -File ".\tools\register-print-intake-startup-task-ELEVATED.ps1" -WatchdogMinutes 5 -WhatIf
powershell -ExecutionPolicy Bypass -File ".\tools\register-print-intake-startup-task-ELEVATED.ps1" -WatchdogMinutes 5
```

The first line is a preview. On 2026-11-20 it reported exactly two changes and nothing else:

```
- Triggers : add 'At startup' trigger (delay 2 min); existing triggers kept
- Triggers : watchdog repeat (none) -> every 5 min (no effect while the watcher is running: IgnoreNew)
```

The second line asks "Are you sure?", writes a backup of the task into `C:\GSO-Print-Intake-Agent`, applies
the two triggers and prints the undo line. If it ends with a state other than `Running`, start the task
with the line it prints. **Never add `-RunWhetherLoggedOn`** (see the review below).

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

### Review of `tools/register-print-intake-startup-task-ELEVATED.ps1`

- Safe for the recommendation when run as shown. It only updates the one existing task, refuses if the
  task does not run from `C:\GSO-Print-Intake-Agent`, keeps the logon trigger, the action, the user, the
  run level and the stronger existing restart policy (10 × 1 min is kept; its default of 3 is not applied),
  writes and verifies a backup first, and never starts or stops the watcher.
- `-WatchdogMinutes 5`: a repeating trigger. While the watcher runs it does nothing (`IgnoreNew`). When
  the watcher has exited it starts it again within 5 minutes — well inside the 15 minutes after which the
  ERP banner turns red. It only fires while `golde` is signed in.
- Side effect to know: after a deliberate safety stop (flood cap, exit 3) the watchdog starts the watcher
  again every 5 minutes. Each start re-scans, processes **nothing** while the count is above the cap, and
  stops again — but once the folder is back under the cap the watcher resumes without a person restarting
  it. Today's restart-on-failure setting already does the same for the first 10 minutes.
- The "At startup" trigger it also adds is harmless and nearly useless on this task: the task can only
  start when the user is signed in, and by then the logon trigger has already started it.
- **Do not use `-RunWhetherLoggedOn`.** That is option B. On this PC the script pre-fills the account as
  the local alias (`DESKTOP-KD7NQTS\golde`, resolved from the task's SID), which is the exact form that
  already failed for this Microsoft-account profile.
- It does not change the two battery settings (see section 1).

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

Do it at the RIP PC, with the ERP open in a browser **on that PC**, so the token is pasted and never retyped.

1. **Prepare.** Open an elevated PowerShell in the repository folder. Preview the local half:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\rotate-print-intake-token.ps1" -WhatIf
   ```
   Expected: two `FOUND UploadToken (set, 57 chars)` lines and "PREVIEW ONLY". Nothing is asked or changed.
2. **Check the inbox is quiet.** The last lines of today's log must be `detected` / `ledger_skip` only:
   ```powershell
   Get-Content "\\SynologyNAS\GSOP\GSOP\print-intake\agent-logs\gso-print-intake-$(Get-Date -Format yyyyMMdd).log" -Tail 12
   ```
3. **Generate the new token (owner, in the ERP).** Embedded admin → Print Log Settings
   (`/app/erp/print-log-settings`) → **Rotate token**. Copy the value from the yellow "New token — shown
   ONCE" box. Do not reload the page, do not paste it into a document, chat or e-mail. *The window starts here.*
4. **Write it into the two runtime configs.**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\rotate-print-intake-token.ps1" -ClearClipboard
   ```
   Paste the token at both hidden prompts. Expected: two `UPDATED UploadToken (set, 57 chars)` lines, each
   with its backup file, and "2 updated, 0 already current, 0 failed". The script backs up each config
   first (timestamped copy beside it), changes only the token value, reads the file back, never prints a
   token, and restarts nothing.
5. **Restart the watcher** (same elevated window):
   ```powershell
   Stop-ScheduledTask  -TaskName "GSO Print Intake Agent"
   Start-ScheduledTask -TaskName "GSO Print Intake Agent"
   (Get-ScheduledTask  -TaskName "GSO Print Intake Agent").State    # Running
   ```
   *The window ends here.*
6. **Verify an authorised request** (writes nothing):
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-Print-Intake-Agent\gso-print-intake-agent.ps1" -ConfigPath "C:\GSO-Print-Intake-Agent\gso-print-intake-agent-config.json" -Health
   ```
   Expected line: `token accepted: OK (400 missing-fileName as expected, nothing written)`.
7. **Verify the heartbeat.** Open Incoming Print Files (`/app/erp/print-intake`): the banner is green and
   says "checked in just now" / "N min ago" with N small. The NAS log has a fresh `agent_started` line and
   no `fatal_config`.
8. **Prove the old token is rejected.** Use the backup written in step 4 (replace the stamp); only the
   status code is printed:
   ```powershell
   $old = (Get-Content -LiteralPath "C:\GSO-Print-Intake-Agent\gso-print-intake-agent-config.before-token-rotation-<stamp>.json" -Raw | ConvertFrom-Json).UploadToken
   try { Invoke-WebRequest -Uri "https://gso-wholesale-app-live.onrender.com/api/print-intake/route-plan" -Method POST -ContentType "application/json" -Body (@{ token = $old } | ConvertTo-Json) -UseBasicParsing | Out-Null; "UNEXPECTED: the old token was accepted" } catch { "old token -> HTTP " + [int]$_.Exception.Response.StatusCode }
   $old = $null
   ```
   Expected: `old token -> HTTP 403`. (A token that is accepted answers 400 here, because no file name was sent.)
9. **Tidy up.** Delete the two `*.before-token-rotation-*.json` backups (they hold the old, now dead,
   token). Close the browser tab that showed the new token.

### If something goes wrong

- **There is no way back to the old token.** Rotation overwrites it; no action sets a chosen value. The
  backup files restore a config file, not the token's validity.
- Step 4 or 6 fails (wrong paste, `token accepted: REJECTED`): repeat steps 3 to 6 — rotate again and
  paste again. Files keep waiting in Prints For Today meanwhile; nothing is lost.
- The watcher will not start after step 5: read the last lines of the NAS log and of
  `C:\GSO-Print-Intake-Agent\gso-print-intake-local-YYYYMMDD.log`. If the helper reported a failure for a
  file, it has already put that file back from its backup; run step 4 again.
- The ERP is unreachable at step 3: do not start; the old token stays valid until Rotate succeeds.

### Can it be done today?

Yes. The server action exists and needs no deploy. It must be done by the **owner** (the Rotate button is
refused for anyone else), at the RIP PC, with an elevated PowerShell for step 5. Nothing else blocks it.
Until it is done, the exposed token still authorises every agent endpoint listed above.
