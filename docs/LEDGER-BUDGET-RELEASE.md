# Ledger budget recovery candidate

Status: PREPARATION ONLY. No production installation, staging execution, trigger change or mail send is established by this document.

## Incident and change

The November 14, 2026 09:12:54 America/New_York dispatch failed after 248.482 seconds. Application run `mwghjodw-kesae766ilj` logged the head sheet lookup AFTER at 14:12:58.114Z, then LEDGER_LOAD ERROR at 14:17:01.468Z and `Execution budget exhausted before LEDGER_HEAD_READ`. Source places the synchronous, previously uninstrumented `head.getLastRow()` between these checkpoints. This localizes the delay to that row-count boundary; it does not identify Google's internal cause. The committed ledger subsequently verified against SHA-256 `419e960b40dbf8b7ff9f060b11620575e87e113682eaa908bf52b0990ac8c15a` with 99 chunks and an unchanged head across the inspection. No ledger restoration is warranted by this incident.

The separate November 14 23:07:54 execution ran 1919.934 seconds and has only Google's generic server error, with no application entry log. Its cause remains unconfirmed. This candidate cannot prevent platform failures or interrupt a synchronous Google call that never returns.

`ledger-budget-recovery-v1` changes:

- Read the four fixed head cells directly through the existing deadline-aware read wrapper, removing the row-count call. An entirely empty pointer retains fresh-ledger initialization; any partial pointer is rejected. Chunk/index/encoding/checksum verification remains mandatory.
- Mark budget exceptions with a fixed internal code. Only a DISPATCH deadline reached before ledger loading completes may return DEFERRED. No processing, notification attempt, ledger save, projection or cancellation cursor advance occurs on that path. No immediate custom failure email is sent for this safe deferral. The existing next five-minute execution loads and verifies fresh state; it does not retry a send.
- Retain the last real successful heartbeat, pending due time and uncertain count, increment consecutive failures, and preserve execution diagnostics. Deferred runs do not claim success. The independent ten-minute monitor still alerts if successful dispatch/cancellation checking is older than 15 minutes or a known pending reminder is more than ten minutes overdue. These are existing thresholds, plus trigger scheduling delay.
- Keep all other errors actionable, including ingestion failures, errors after ledger loading, and integrity failures. Owner alerts distinguish confirmed integrity errors from execution/service errors. Snapshot restoration advice now requires confirmed corruption and reconciliation of newer accepted/uncertain sends.

No Engine.gs, parser, notification ID, recipient, 24-hour timing, correction rule, OAuth scope or trigger changes are included. Google's native failure notifications remain enabled. The deliberate safe deferral returns normally with DEFERRED diagnostics; actual unhandled errors remain native failures.

## Local verification

Run `node --test tests/*.test.cjs`. New regressions prohibit the metadata call, reject partial heads, simulate the pre-load deadline with live policy enabled and a forbidden real transport, verify silent deferral/recovery without state or cursor mutation, confirm persistent/overdue conditions reach the independent monitor, and ensure post-load/ingestion failures and owner-alert send deduplication remain intact. Tests use fictional adapters; no Google services or real mail are invoked. The private-fixture integration test is skipped when its fixture is absent.

Local result: 112 passed, zero failed, one private-fixture test skipped (113 total). The separate Python parser suite could not start under the system Python because reportlab is absent; the repository CI environment installs its pinned development dependencies and must pass before release. Parser source is unchanged.

## Remaining acceptance and release sequence

1. Review and pin the candidate commit; retain this as a separate scheduler release dependency for Phase 1. Do not add these files to the reduced W009 mCE harness.
2. In the separately approved scheduler TEST project, verify identity, workbook ID, LIVE_EMAIL=false, exact source hashes and existing permissions. Install Code.gs and Ledger.gs together, keeping Engine.gs and the manifest unchanged. Rehearse normal dispatch/health and a synthetic pre-load deadline using fictional state, capturing DEFERRED diagnostics, retained old success time, no mail and subsequent recovery. Local mocks do not establish this cloud evidence.
3. Before any production release, obtain approval for the exact commit and installation. Merging main also redeploys the existing Render service, though parser source is unchanged. Back up and checksum the fresh authoritative ledger and reconcile accepted/uncertain sends.
4. Briefly pause live email for installation, install the two files, verify source and saved settings, and restore the existing approved mail policy. Preserve all trigger owners, schedules and native failure settings. Do not run an extra live dispatcher to force a reminder test.
5. Verify ordinary timed dispatch and independent health, then inspect Gmail and the checksum-verified ledger after the next due batch. Exactly one Sent marker and accepted attempt are required for each unsuperseded reminder; check bounces and legitimate cancellations/reschedules.

Rollback Code.gs and Ledger.gs together to the previous pinned release. Preserve the latest ledger, accepted/uncertain notification IDs, cancellation exclusions, cursors and evidence. Never restore an older business snapshot merely to roll back source code.
