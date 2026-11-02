# Streamlined scheduling and failure monitoring

The five-minute dispatcher retains its reminder timing, recipients, cancellation preflight, exclusive business lock and durable send protocol. This update reduces service work and adds diagnostics; it does not guarantee that Google will never fail an execution before the script starts.

## Efficient persistence and views

The checksum-verified two-bank ledger remains authoritative. Unchanged state does not write a new snapshot. A quiet cancellation pass records its success in small Script Properties rather than rewriting the entire ledger for a heartbeat. Full daily scans, business changes and failures retain run records in the ledger; the most recent 100 cancellation journal records are retained. Live scan counts and freshness are in RR_CANCEL_CURSOR and RR_DIAG_DISPATCH.

Each display tab has a content hash in RR_VIEW_HASHES. Only changed views are rebuilt, once at session completion. A separate full-repair timestamp forces every view to refresh at least daily, even when other tables change frequently. `refreshClinicalViews()` provides a manual complete rebuild without sending mail. Human display tabs are projections; the ledger remains the recovery source.

A private replay using a saved production ledger measured 74 Sheets write operations per unchanged dispatch in the prior implementation and zero in the new implementation, across five repeated passes. Shifts, reviews, notifications and attempts remained unchanged, and transport was forbidden. This measures mocked Sheets operations, not live latency or a promised reduction in Google errors.

## Cancellation cursor

The first scan and each daily reconciliation search 180 days. Other scans use the last successful scan timestamp with a 48-hour overlap. Invalid/future cursor timestamps force a full reconciliation. A bounded cache of 200 ignored message IDs avoids repeatedly reading unrelated bodies; it stores no message text. Cancellation records under review always retry identity resolution. Existing verified cancellation exclusions remain durable in the ledger.

All business changes commit before RR_CANCEL_CURSOR advances. A partial scan, failed read, failed commit or exhausted execution budget keeps the previous cursor, holds ride email for that execution, and creates a failure review. Idempotent replay covers crashes between ledger commit and cursor save. A daily full scan also covers old/delayed/imported messages outside the recent window.

## Retries and diagnostics

Only safe reads retry, at most three attempts with 250/750 ms waits and the execution deadline. Permanent permission/validation errors do not retry. Ledger writes, draft creation and sending are not automatically retried by this wrapper. The existing durable PREPARING/SENDING/UNCERTAIN handling still governs delivery.

The October 31 recurrence is not yet attributed to a specific Google service or application operation. The generic error and the old absence of application logs do not establish a pre-start failure. Successful overlapping dispatchers and independent health checks rule out a continuous 32-minute dispatcher outage, but do not locate the stalled invocation.

`execution-diagnostics-v1` emits a JSON `console.info` ENTRY before its first PropertiesService, UUID, lock, Sheets or Gmail call. Every record includes release, function/kind, local correlation ID, UTC timestamp and a numeric trigger UID when provided by Google. The ID uses Date/Math only; no UUID service must succeed before the entry. BEFORE/AFTER/ERROR records bracket initial properties access, configuration, locks, workbook/ledger reads, checksum, commits, cancellation reads, draft creation, sends, Sent reconciliation and view writes. Safe-read retry records retain the same execution ID; write/send operations are never passed to the read retry wrapper. Operation durations exclude the preceding checkpoint write; that distinction matters if PropertiesService stalls.

Logs contain only internal phase names, correlation metadata, statuses and durations. They never include exception messages, roster names, addresses, bodies, tokens, provider IDs or ledger contents. Console output is capped at 240 ordinary records plus a reserved terminal record. Long scans can exhaust the cap; absence of a later phase after that limit is not evidence it never ran. Native unhandled exception reporting still applies and is separate from these application console records.

`RR_EXEC_<correlation>` retains a small independent record for each admitted execution. Allocation and pruning use a short user lock; no shared-array append is used. At most 48 keys are admitted, each below 1 KiB. A run writes its entry, up to 24 phase checkpoints and its terminal status. Success removes only its own key; failed, held, skipped-lock and unfinished records survive later successes. At capacity, pruning removes records older than seven days and then the oldest terminal records or unfinished records older than one hour until a slot is available. This is a capacity sweep, not a seven-day timer. Runs older than one hour stop updating their retained key. If all slots are active, the retention lock is busy, or properties fail, console records continue and retention is explicitly marked unavailable. Retained phases can lag after the checkpoint budget; consult console phase records and native execution history. Retention is bounded best-effort forensic evidence, never notification authority. The 48 KiB payload allowance is additional to existing property use; quota exhaustion degrades retention rather than business logic.

`RR_DIAG_<kind>` is now terminal heartbeat metadata, separate from execution evidence. Only a business-lock holder that successfully read the prior heartbeat may update it. Skipped-lock and pre-lock failures never overwrite it. The read occurs after lock acquisition, preserving the newest prior last-success value and pending-due evidence across waiters and failures. A later success does not erase independent failure records. Logging exceptions cannot mask the business exception, prevent the lock-release attempt or make a completed send retry. This exception isolation cannot interrupt a synchronous Google logging/service call that never returns.

The four-minute cooperative deadline bounds subsequent work; it cannot interrupt a synchronous Google call. `RUNNING` without a terminal record means unfinished evidence, not a proven lock hold or scheduler-wide outage. A fresh successful heartbeat from another execution remains valid.

Google supports console records in the Apps Script execution log and simplified Cloud Logging view. A standard Cloud project is required for full Cloud console access; this patch does not change project association or permissions. See [Google logging documentation](https://developers.google.com/apps-script/guides/logging) and [generic server error guidance](https://developers.google.com/apps-script/guides/support/troubleshooting).

## Independent lightweight health check

Change the existing daily `checkClinicalHealth` time trigger to `checkClinicalDeliveryHealth`, every ten minutes. Keep hourly ingestion and the five-minute dispatcher. No trigger is installed by source code. The original full health function remains available for manual review.

The lightweight monitor reads small Script Properties and uses a user lock separate from the dispatcher script lock, so a dispatcher holding its business lock cannot block health monitoring. It requires no Sheets access and never sends student mail. It alerts the owner when:

- Dispatch or cancellation checking has no successful heartbeat within 15 minutes.
- A pending reminder is more than ten minutes overdue.
- Calendar ingestion has no completed run within 26 hours.
- Either expected site's accepted calendar is older than nine days.

RR_SCHEDULE_HEALTH supplies ingestion/calendar freshness from the committed ledger. Run the updated dispatcher successfully before enabling the health trigger to seed this summary and its success heartbeats. Timing is threshold plus trigger scheduling delay, not an exact notification deadline.

RR_DELIVERY_HEALTH deduplicates one owner alert per incident. Recovery resolves it silently; a new incident can alert again. Uncertain health-alert sends never retry blindly. Production maintenance with LIVE_EMAIL=false is quiet; TEST records a dry-run incident without drafts or sends. No success or daily summary mail is introduced.

This is independent of the dispatcher job, but still runs on Google's platform. Keep Google's native failure notifications enabled: Google-wide execution failures could prevent both jobs from starting. An external monitor would require a separate service/setup and is not provisioned by this release.

## Staging evidence and incident attribution

Install the candidate Code.gs and Ledger.gs together in the named staging project. Keep Engine.gs and the manifest unchanged. Check TEST, LIVE_EMAIL=false, the staging workbook ID and an empty Triggers page before running. `tests/staging/Diagnostics.gs` supplies guarded manual failure, recovery and evidence functions; install this helper only in staging. No trigger scope is added. Run one intentional failure, then recovery and evidence. Save the native execution start/end/status and ENTRY/phase/terminal correlation records; a failure retained after recovery demonstrates the property evidence independently of the console. Exercise the ordinary dispatcher and independent health entry points as well. Local regression tests cover lock overlap, interrupted evidence, send uncertainty, cancellation holds, late reminders and owner incident deduplication. Mock success does not satisfy real staging verification.

For a timed failure, first confirm that the candidate release was installed when it started, the correct project/function/execution was selected, and logs have finished loading and have not expired or been filtered. Compare the same execution's application ENTRY and phase records with a successful control invocation. ENTRY plus an unmatched BEFORE localizes the last observed boundary; it does not prove the following service caused the failure (the checkpoint write or log pipeline can also stall). No ENTRY, with controls visible and log ingestion checked, supports escalation for possible pre-entry execution or logging failure; it does not conclusively distinguish those cases. Never infer a pre-start platform failure from an old release that emitted no entry logs.

Use [the support packet](SUPPORT-ESCALATION.md) for a correlated recurrence. A diagnostic-only patch does not resolve or guarantee prevention of a Google platform defect.

## Release and rollback

Install Code.gs and Ledger.gs together in the isolated TEST/LIVE_EMAIL=false project; Engine.gs and OAuth scopes are unchanged. Exercise full and recent scans, view caching, manual health monitoring and retry/uncertainty fault tests. Back up the current production ledger before the separately approved merge and installation. Briefly pause live mail for installation, verify first scan/diagnostic state and unchanged accepted-send evidence, restore the approved live policy and verify saved settings after reload. The existing hourly ingestion, five-minute dispatcher and ten-minute independent health trigger are already configured in PR5. Preserve all three and their immediate native failure alerts.

Rollback Code.gs and Ledger.gs together while preserving the current ledger and all accepted/uncertain IDs. For this diagnostic-only release, rollback to PR5 retains `checkClinicalDeliveryHealth` and its ten-minute cadence. Old code ignores the new operational properties; do not erase ledger history to roll back code.
