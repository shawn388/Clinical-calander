# PR #8 email-disabled Apps Script staging acceptance

Result: PASS on November 15, 2026. This establishes scheduler staging acceptance, not production deployment or prevention of all Google platform errors.

## Exact candidate and environment

- Core candidate: `1aff81bcb9d2d3777f03db4668923af7a6ff6271`, release `ledger-budget-recovery-v1`.
- Test-helper commit: `9df9f0eced995fa4328a74443258337ce660cfba`. This adds only `tests/staging/BudgetRecovery.gs`; core candidate bytes are unchanged.
- Staging project: `1p6NHfufLqR-yoc5xQ4SvxsrJmyrT6B3kaQJqrcYv2xHR7jgkQObRADy2` (`RR Clinical STAGING - EMAIL DISABLED`).
- Staging workbook: `1Sht9j8u06FE-S1s2DGDBExoM9AVX0aQ_zupDkJb8l3Y`; America/New_York.
- RUN_MODE=TEST, LIVE_EMAIL=false, separate staging parser, zero installed triggers, verified before and after. No new OAuth authorization was requested.
- Saved Code.gs and Ledger.gs were read back after reloading and compared exactly with the pinned candidate. Engine.gs and appsscript.json were unchanged from staging baseline. Engine's existing editor copy omits the repository's final newline; source otherwise matches the candidate.
- Existing Diagnostics.gs was backed up and extended with the guarded staging helper. This helper stays in staging and must never be installed in production.

Pinned file SHA-256 values:

| File | SHA-256 |
| --- | --- |
| Code.gs | e64c5aeb88b5118768001111261c60f9ff16eef3ddb82348bb4ba5d8b9c52e39 |
| Ledger.gs | 925f2bcab7367be9a690ab0e9284f1dcece42cc5f6ab062872af15354169fb1a |
| BudgetRecovery.gs | be191eab3fd0072733d9bb0ca89f0aa33ba9a1a2dfa0326f72bd577ea07d1ae5 |

## Native cloud executions

All three outer manual runners visibly completed in the native staging Executions page. Times are EST (America/New_York).

| Start November 15 | Function | Duration | Native status |
| --- | --- | --- | --- |
| 12:10:14 | stagingPR8NormalRun | 76.488 s | Completed |
| 12:12:16 | stagingPR8BudgetSuite | 12.462 s | Completed |
| 12:13:01 | stagingPR8NormalRun | 41.577 s | Completed |

First and final normal passes logged `PR8_NORMAL / PASS`: real staging ingestion and dispatch COMPLETED, independent health HEALTHY with no issues, zero forbidden transport calls, unchanged send attempts and unchanged Gmail draft IDs. Their ledger loads completed checksum verification. The final normal pass deliberately follows the injected DISPATCH and INGEST failures, establishing recovery for both entry paths.

Fault acceptance:

- `PR8_PRELOAD_DEFER / PASS`, run `mwi3e7yb-0ugof8cly8cm`: injected deadline at LEDGER_HEAD_READ before processing; DEFERRED retained in independent execution evidence; old successful heartbeat, pending due time and uncertainty count preserved; head/cursor unchanged; no new custom fatal-alert record. The original read wrapper generated the typed budget exception; its provider callback did not execute.
- `PR8_HEALTH_FAULT / PASS`: actual health logic using fictional small-property records detected stale dispatcher/cancellation checks and an overdue reminder, recorded a DRY_RUN incident, then resolved it silently after fresh success evidence. This did not overwrite live staging health properties or send mail.
- `PR8_FAIL_CLOSED / PASS`: actual ledger validation rejected partial pointers and checksum mismatch through fictional sheet adapters; no committed cells were corrupted. Actual sessions with synthetic post-load DISPATCH and INGEST deadline errors remained FAILED and produced an EXECUTION_BUDGET_EXHAUSTED owner record in DRY_RUN. The runner caught expected exceptions so its native outer execution could complete. Failed inner-session diagnostics remain evidence; they were not relabeled successful.
- `PR8_BUDGET_SUITE / PASS`: dispatcher recovered, real staging ledger verified, send attempts unchanged and Gmail draft IDs unchanged.

The test helper forbids transport.prepare and transport.sendPrepared during normal runs and requires both call counts to remain zero. TEST/LIVE_EMAIL=false also applies to direct owner-alert paths. No real mail was created/sent as part of these tests; the authoritative staging ledger contains zero attempts.

## Final independent reads

Fresh metadata, head, and exactly 103 active chunks were read through the Sheets connector. Every chunk matched its digest/index and J: encoding. Concatenated UTF-8 JSON independently hashed to `e1e3fd3f753cd73b4f9b34eba8dfcfd33b9509daa01d0a65dd9d606d62e33e80`; a second head read was unchanged. Active bank RR_V2_Chunks_B, start row 2, count 103.

Staging notifications: 457 SILENT_RETAINED, 197 SUPERSEDED, 137 HISTORICAL, 11 EXPIRED, six PENDING, one DRY_RUN; zero send attempts. The one DRY_RUN is an owner MISSED_NOTIFICATION exception from intentionally unsent staging data. It is not evidence of a missed production email. Historical staged records were retained.

Final safe diagnostics:

- Dispatch `mwi3fuux-czs0o16trq8`: COMPLETED at 17:13:39.637Z, consecutive failures zero, uncertainty count zero.
- Ingest `mwi3f71w-e7z52batxe`: COMPLETED at 17:13:34.146Z.
- Delivery health at 17:13:41.598Z: HEALTHY, no issues.
- TEST, LIVE_EMAIL=false, exact staging workbook and zero triggers remained in place.

Local JavaScript validation previously passed 112 tests with one private-fixture skip. [CI run 43739480273](https://github.com/shawn388/Clinical-calander/actions/runs/43739480273) passed the dependency-installed Python parser and JavaScript suites for helper commit 9df9f0e.

## Release boundary

Production Apps Script, properties, triggers, ledger and mail remain unchanged. PR #8 remains an unmerged draft. The next gate is approval of the exact release commit and the merge/install sequence in [LEDGER-BUDGET-RELEASE.md](LEDGER-BUDGET-RELEASE.md), including a fresh production checksum backup, accepted/uncertain send reconciliation, brief mail pause for joint Code.gs/Ledger.gs installation, restore/verify saved mail policy, then ordinary timed-run verification. Do not install staging helpers in production or force a live reminder test.

This remains independently deployable from the broader tracker/ER-mCE upgrade. Preserve that upgrade's existing HOLD and isolated-test requirements. See [PHASE1-SCHEDULER-INTEGRATION.md](PHASE1-SCHEDULER-INTEGRATION.md).
