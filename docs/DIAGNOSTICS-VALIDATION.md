# Execution diagnostics validation, November 2, 2026

Candidate application source: `fc45149391bd2d3dbd265f08a9b8b3016e52ee94` (PR #6). This verifies diagnostics and heartbeat correctness. It does not reproduce or resolve the October 31 generic Google failure.

## Local and CI

- 100 Node tests passed. New cases cover entry before failing properties access; privacy; failed/unfinished evidence surviving recovery; skipped-lock overlap; reading the latest heartbeat after acquiring the lock; logging/alert failures preserving the original exception and lock release; bounded retention/output; ambiguous send without retries; and retaining last success/next due when heartbeat reads or processing fail.
- 18 Python parser tests passed in a temporary Python 3.12.14 environment using the repository dependencies. No parser source changed.
- GitHub Actions `Clinical scheduling regression`, run 41460034327 / run number 68, completed successfully for the candidate. CI also ran the test suites. Later documentation-only commits require their own CI result.
- Engine.gs, manifest scopes, notification templates and recipients are unchanged.

## Real isolated staging executions

The staging project was confirmed TEST / LIVE_EMAIL=false with the exact staging spreadsheet guard, and its Triggers page showed zero triggers. No trigger was created. Candidate Code.gs and Ledger.gs were installed together; full editor copies matched the candidate text (ignoring a trailing newline). Engine.gs matched the released reference. The manifest retained the existing four scopes, America/New_York timezone, V8 and STACKDRIVER exception logging. A reload confirmed the new files persisted.

| Native function invoked | Application correlation ID | Application UTC start | Application terminal | Measured application interval |
| --- | --- | --- | --- | --- |
| stagingDiagnosticsFailure | mvzcbn7w-x15h26p4uim | 2026-11-02T14:14:37.388Z | FAILED, 14:14:40.423Z | 3035 ms |
| stagingDiagnosticsRecovery (ordinary dispatcher) | mvzccyfs-qc4bqybcdm | 2026-11-02T14:15:38.584Z | COMPLETED, 14:15:47.360Z | 8776 ms |
| checkClinicalDeliveryHealth | mvzchh84-5ezjkpjzp0b | 2026-11-02T14:19:09.556Z | COMPLETED, 14:19:12.919Z | 3363 ms |

The helper deliberately invokes the DISPATCH session, so the application function label is dispatchClinicalNotifications; the native execution function is the helper named above. These are manual editor executions, not staging time-driven triggers. Application intervals exclude native queue/startup time.

Failure ENTRY was visible at 14:14:37.390Z, before PROPERTIES_ACCESS BEFORE at 14:14:37.393Z. Observed AFTER durations: initial properties handle 1 ms; lock acquisition 38 ms; workbook opening 309 ms; ledger head read 101 ms; chunks read 236 ms; checksum 74 ms. STAGING_INJECTED_FAILURE emitted BEFORE at 14:14:39.112Z and ERROR at 14:14:39.154Z. LOCK_RELEASE AFTER was visible at 14:14:40.422Z. The original deliberate exception remained a failed Google execution, with its native stack, rather than being caught as success.

The evidence helper at 14:18:14Z read the new successful dispatch heartbeat with last_success_at 14:15:47.205Z, zero consecutive failures/read retries/uncertain notices, while retaining the earlier FAILED execution and failed_stage STAGING_INJECTED_FAILURE under its separate execution key. Recovery removed only its own retained record. TEST and LIVE_EMAIL=false were reported again. Staging uses an older fixture; its next_due must not be treated as the production next due.

Real staging confirms first-entry/phase console visibility, actual service timings, failure attribution, lock release and retained failure evidence after recovery. Local tests exercise cancellation holds, late reminders, send uncertainty/no duplicates and owner alert deduplication/silent recovery. No real student or owner test email was sent; production delivery was not exercised by these staging checks. No timed generic Google failure has yet been captured on this candidate.

## Production verification after the release decision

Immediately before installation, refresh and checksum the production snapshot again and reconfirm accepted/uncertain notification IDs. Back up source and safe named settings; do not open unrelated secret values. Install Code.gs and Ledger.gs together using the approved maintenance procedure, retain Engine/manifest and all three triggers, and restore/verify the current live policy. Do not install the staging helper.

Verify the next scheduled dispatcher and independent health executions show the installed release, numeric trigger UID, distinct correlation IDs and successful terminals. Check heartbeat/cancellation freshness, next_due, accepted/uncertain counts and existing accepted marker identities; do not resend the protected reminder. Keep native Google failure notifications enabled. For a recurrence, preserve the native execution and correlated console/retained evidence, then use SUPPORT-ESCALATION.md. A successful release observation demonstrates operation/recovery, not prevention of all Google runtime failures.
