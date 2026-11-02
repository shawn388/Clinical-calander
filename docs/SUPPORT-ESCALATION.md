# Recurring Apps Script execution failure: investigation packet

Status: application attribution remains unproven; do not submit a claim of a confirmed Google defect. This packet is a draft for an authorized owner support request, not a report already filed.

## Incident handling

Keep exact production timestamps, execution identifiers, ledger checksums/counts, accepted-send evidence, pending-due times and source-audit details in private owner evidence. Do not publish them in a public PR or issue without authorization. The original release emitted no application ENTRY/phase console records and later successful runs overwrote its latest diagnostic property. That evidence cannot distinguish failure before application entry, during initial property access, or later.

Do not attach student data, source PDFs, raw ledger snapshots, properties, tokens, addresses or message bodies to a public issue. Do not resend an accepted notification to investigate an execution failure.

## Add for a recurrence on the candidate release

1. Project ID (private support channel), timezone, trigger function, trigger UID, native execution identifier/detail URL, deployment/release, exact UTC start/end and duration.
2. Export the same execution's ENTRY, correlated BEFORE/AFTER/ERROR and terminal records. Include the final observed phase and elapsed time; indicate log/checkpoint truncation if applicable.
3. Preserve the independent retained execution record before capacity eviction. Record status and timestamp; an unfinished record does not by itself prove the business lock was held.
4. Capture successful surrounding control executions and the independent health results. Confirm installation time, log visibility/ingestion, filter settings and retention. No ENTRY alone is insufficient to prove pre-start failure.
5. Record alert status, pending-due age and accepted/uncertain counts without personal content. State whether other invocations continued and whether service-specific failures were observed.

## Questions for Google support

- Does backend execution telemetry identify the last completed runtime/service operation for this execution?
- Does the reported duration include queue/startup time, logging delay or an execution whose service call never returned?
- Is there an internal platform error identifier unavailable in the generic Apps Script error?
- If ENTRY is absent on the candidate but surrounding controls log normally, can Google distinguish failure before application execution from console/Cloud Logging ingestion failure?

References: [Google troubleshooting](https://developers.google.com/apps-script/guides/support/troubleshooting), [Google logging](https://developers.google.com/apps-script/guides/logging). Keep native failure alerts enabled. A code deadline cannot cancel a synchronous Google call that never returns.
