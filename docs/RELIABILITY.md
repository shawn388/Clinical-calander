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

RR_DIAG_DISPATCH and other RR_DIAG_* entries record start, phase, completion, last success, read retry count and bounded failure details. Phases distinguish workbook opening, ledger reads and commits, Gmail search/body/authentication reads, draft preparation, sending and view writes. If Google never starts the script, its prior heartbeat remains unchanged. Diagnostics and view caches are operational metadata; keep native Google execution history for platform-level failures.

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

## Release and rollback

Install Code.gs and Ledger.gs together in the isolated TEST/LIVE_EMAIL=false project; Engine.gs and OAuth scopes are unchanged. Exercise full and recent scans, view caching, manual health monitoring and retry/uncertainty fault tests. Back up the current production ledger before the separately approved merge and installation. Briefly pause live mail for installation, verify first scan/diagnostic state and unchanged accepted-send evidence, restore the approved live policy and verify saved settings after reload. Then edit the existing health trigger in place to the ten-minute lightweight monitor, retaining immediate native failure alerts.

Rollback Code.gs and Ledger.gs together while preserving the current ledger and all accepted/uncertain IDs. Repoint the health trigger to the prior `checkClinicalHealth` function and daily cadence. Old code ignores the new operational properties; do not erase ledger history to roll back code.
