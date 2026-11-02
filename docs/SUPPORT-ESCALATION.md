# Recurring Apps Script execution failure: investigation packet

Status: application attribution remains unproven; do not submit a claim of a confirmed Google defect. This packet is a draft for an authorized owner support request, not a report already filed.

## Verified October 31 incident supplied by owner

Timezone: America/New_York (EDT, UTC-04 on October 31, 2026).

- `dispatchClinicalNotifications` time-driven start: 2026-10-31 13:17:54 EDT (17:17:54 UTC).
- Failed at 13:49:54 EDT (17:49:54 UTC), reported duration 1920.187 seconds.
- Visible Cloud log: generic Google server error, no source line or stack.
- Subsequent 13:22:54 dispatch completed in 6.8 seconds; later scheduled dispatchers also completed.
- Independent health jobs at 13:19:09, 13:29:09, 13:39:09 and 13:49:09 completed.
- The reminder had already been accepted in Gmail Sent at 09:03:57 EDT. Do not resend it to investigate this failure.
- PR5 was useful but did not eliminate the recurrence. The old release had no application ENTRY/phase console records, and later successful runs overwrote its diagnostic property. The old evidence cannot distinguish failure before application entry, during initial property access, or later.

The project identifiers and accepted-send message/event identifiers remain in private owner evidence and the task handoff. Do not attach student data, source PDFs, raw ledger snapshots, properties, tokens, addresses or message bodies to a public issue.

## Add for a recurrence on the candidate release

1. Project ID (private support channel), timezone, trigger function, trigger UID, native execution identifier/detail URL, deployment/release, exact UTC start/end and duration.
2. Export the same execution's ENTRY, correlated BEFORE/AFTER/ERROR and terminal records. Include the final observed phase and elapsed time; indicate log/checkpoint truncation if applicable.
3. Preserve the independent retained execution record before capacity eviction. Record status and timestamp; an unfinished record does not by itself prove the business lock was held.
4. Capture successful surrounding control executions and the independent health results. Confirm installation time, log visibility/ingestion, filter settings and retention. No ENTRY alone is insufficient to prove pre-start failure.
5. Record alert status, pending-due age and accepted/uncertain counts without personal content. State whether other invocations continued and whether service-specific failures were observed.

## Questions for Google support

- Does backend execution telemetry identify the last completed runtime/service operation for this execution?
- Does the 1920-second duration include queue/startup time, logging delay or an execution whose service call never returned?
- Is there an internal platform error identifier unavailable in the generic Apps Script error?
- If ENTRY is absent on the candidate but surrounding controls log normally, can Google distinguish failure before application execution from console/Cloud Logging ingestion failure?

References: [Google troubleshooting](https://developers.google.com/apps-script/guides/support/troubleshooting), [Google logging](https://developers.google.com/apps-script/guides/logging). Keep native failure alerts enabled. A code deadline cannot cancel a synchronous Google call that never returns.
