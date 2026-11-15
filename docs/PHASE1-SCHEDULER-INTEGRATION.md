# Calendar scheduler dependency for the Phase 1 upgrade

As inspected November 15, 2026, the live Clinical Calendar Scheduler in `shawn388/Clinical-calander` is separate from the proposed Master Tracker and ER/mCE Phase 1 applications. The latest inspected `Master Student Tracker Upgrade Investigator 00` handoff is W012, with production on HOLD pending isolated-account cloud testing. `Audit student tracking system` published the W009 local candidate and reduced mCE harness. Neither handoff establishes an approved program merge. This note records a dependency; it does not change their pinned source or release authorization.

## Recommended sequence

Prepare and validate the scheduler budget repair independently. Keep its current production sender and authoritative RR_V2 ledger intact while the tracker/ER upgrade completes its separate acceptance gates. Do not import Gmail/Drive-capable scheduler code into the W009 reduced `spreadsheets.currentonly` harness. Do not widen that harness's scopes, modify its immutable package, resume its paused engineering work, or bypass its staging identity requirements for this repair.

Before the broader upgrade is released, include this scheduler candidate's exact commit and cloud acceptance evidence in the release dependency list. Inventory all timer triggers and sender entry points across the old and new applications. There must be exactly one active authority for ride reminder/correction delivery throughout cutover. Retire an old trigger only as part of a reviewed handover; copying source alone does not disable it.

## Interface and migration acceptance

- Treat the existing immutable Student ID as the join key. Preserve IDs in Students and Archive across roster edits, moves and any schema migration. Do not regenerate IDs from a corrected email or row number. Existing columns, headers and active/archive semantics require a fresh compatibility check before a tracker release.
- Keep the scheduler as owner of calendar source versions, verified shifts, correction/cancellation history, notification IDs and durable send attempts. Tracker/ER status, hospital clearance and program review clocks remain their respective application's authority. A placement approval is not a ride reminder or evidence of calendar delivery.
- Verify roster header and ID mappings against both candidate and live schemas. Exercise new students, email corrections, archive moves, duplicate names, missing IDs and unknown identities with fictional no-email tests. Explicitly plan who writes IDs for newly added students; this patch does not add automatic ID write-back.
- Preserve all RR_V2 business state, accepted/uncertain markers and cancellation exclusions. Do not recreate pending notifications from a tracker migration, replay historical mail or clear uncertain send claims. Recipient changes must follow existing verified correction policy.
- Keep the user's email policy: 24-hour ride reminders, pre-start cancellation/reschedule corrections and actionable failures. Historical records, successful runs and recovery stay silent.
- Any eventual consolidation needs a separate, versioned interface/migration plan, one-sender cutover, failure/rollback rehearsal and owner approval. Keep both systems independently deployable until that plan is verified. Sharing a project folder does not establish a safe code merge.

The proposed scheduler repair and its remaining cloud/release checks are documented in [LEDGER-BUDGET-RELEASE.md](LEDGER-BUDGET-RELEASE.md).
