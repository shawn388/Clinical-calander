# Implementation results and design

The approved work is implemented locally on `codex/clinical-scheduling-repair`, based on `d831c0640f769ac986b3b02242570d627a50d557`. No production system was modified and no real email was sent. The detailed read-only root-cause report and frozen baseline remain in the shared workspace's separate review directory.

## Measured results

| Measure | Existing baseline | Repaired local implementation |
| --- | --- | --- |
| Owner reference student-shift extraction | 0 / 7 | 7 / 7 |
| Four-PDF verified extraction | 0 / 29 | 29 / 29 |
| Exact tuple precision and recall | Recall 0%; precision undefined with no output | 100% / 100% on this corpus |
| Unique roster match coverage | Loader chooses stages instead of actual names | 27 / 29 observations, 93.1% |
| Unmatched observations | Disappear | 2 / 2 persisted with review events |
| Upcoming reference dispatch simulation | Coupled to failed import | 6 / 6 API-accepted in mock transport |
| Missed / duplicate notices in that simulation | Not measured in live history | 0 / 0 |

The four rendered PDFs were independently read to establish the expected tuples: October 10 Lee (11), October 17 Lee (9), October 24 Lee (7), and October 24 Collier (2). There are 29 observations across versions, representing 19 distinct student/date/time/site tuples. Repeated versions are useful regression cases but do not provide independent statistical evidence. The same count/tuple result was obtained on Python 3.9 and 3.12.14 with pinned pdfplumber 0.10.3.

One historical student absent from the roster snapshot accounts for the two unmatched observations; identity details remain in the private local evidence. The system retains those entries and owner review records without assigning a different student. Every entry in the supplied seven-shift reference has a unique roster match. Two malformed roster rows also surface as issues. The 93.1% figure is automated match **coverage**, not proof of identity from name similarity.

The six-shift simulation begins after the October 24 source arrives; October 18 is historical at the cutover and is suppressed. Five-minute clock ticks and repeated dispatcher calls yield six accepted events, zero duplicates and zero missed eligible notices, including the daylight-saving change. These are simulated API results, not real delivery evidence or estimates of production missed/duplicate rates.

The automated local suite has 14 Python tests and 51 Node tests. Python tests passed on 3.9 and 3.12.14; Node tests passed on 24.22.1. Fault-injection assertions cover parser/HTTP/JSON failures, textless/invalid/ambiguous PDFs, missing attachments, unknown/ambiguous/archived identities, missing emails, invalid roster rows, retries, uncertain sends, crash recovery, ledger corruption, ledger failure fallback and overlapping trigger acquisition. Every enumerated injected fault is asserted to reach its expected error, review, held or safe-failure state. This is not a guarantee that every possible future defect will be detected.

Two tests require private review fixtures and skip in a clean public checkout. The GitHub workflow is authored but was not run remotely. A Google/Render staging integration and an owner-authorized real test message remain deployment gates.

## Parser design

The parser reads word coordinates and validates the seven weekday positions, date rows, consecutive dates, weekday consistency, printed heading and filename month windows. It groups coherent text runs beneath time anchors. A name that extends over a column boundary stays with its leading event anchor. It independently checks colored event paths, which the supplied PDFs encode as PDF curves rather than rectangles; a visible card with missing time text is a failure, not a zero-shift success.

Multi-student blocks expand into separate objects. Multiple cards in one day remain separate. Offset-aware start/end instants preserve overnight shifts and elapsed-hour notification timing. Ambiguous/nonexistent daylight-saving clock times require review. Invalid dates cannot normalize silently into another month. Every emitted shift retains raw text, source words, page, coordinates and validation reasons. “Verified” names the satisfied extraction rules; it is not a calibrated probability.

Unsupported layouts, scanned pages, unreadable generation timestamps, clipped text and merged event ownership fail closed. A complete supported empty calendar can authorize absence only inside its actual validated date coverage. The implementation does not add OCR or pretend an unsupported layout is empty.

## Data model

| Logical collection | Key information |
| --- | --- |
| Sources | Message/attachment identity, hash, filename, archive reference, publication time, parser version, coverage, import status |
| Extracted | Raw shift/provenance, source, match status and candidate IDs; unresolved entries retained |
| Students | Immutable registry ID, original normalized identity/cohort and creation time |
| Shifts | Stable ID, revision, active/cancelled/superseded status, student identity/status/email, time/site, source |
| History | Prior/next state, added/cancelled/rescheduled/roster metadata changes, source and timestamp |
| Notifications | Durable event ID, type, shift revision, recipient snapshot, due time, lifecycle and provider evidence |
| Attempts | Preparation/send/acceptance/uncertainty, attempt count, error and recovery evidence |
| Reviews | Stable ID, category, context, source links, instructions, blocking state, occurrences and resolution |
| Runs | Expected job type, start/end, completion/failure/continuation |
| Legacy / aliases / actions | Preserved historical rows and explicit auditable owner decisions |

Whole logical state is serialized into bounded text fragments in the inactive bank, verified with a SHA-256 head pointer, and committed through one head-range update. A crash cannot expose half of a new state as committed. Alternating banks bound duplicate snapshot storage while retaining all logical historical records in current state. Human-readable projections regenerate from the authoritative ledger; raw evidence remains in the ledger and content-addressed archive.

The caller holds the script lock for ingestion, persistence and sending. Delivery records PREPARING before creating a draft and SENDING before invoking send. A crash after send can be recovered using the unique subject marker and Sent-message evidence. If evidence is unavailable, the event becomes UNCERTAIN and requires investigation. Exactly-once delivery cannot be guaranteed by Gmail's send API; safe uncertainty handling prevents automatic duplicate retries at the cost of occasionally requiring owner intervention.

## Remaining operational limits

- Real staging is still required to verify Google permissions, Apps Script execution quotas, Linux runtime behavior, latency and provider API acceptance. Local adapters are mocks.
- Timers are not exact schedulers. Default semantics are 24 elapsed hours with a proposed five-minute due-work timer; lock contention and service outages can add delay. The owner must approve acceptable timing tolerance at cutover.
- The watchdog is a separate job but still depends on Google. A platform-wide outage needs independent external monitoring for an out-of-band guarantee.
- Ingestion scans a bounded 180-day Gmail window with checkpoints. Longer outages require an owner-reviewed recovery query/backfill. Existing history is not deleted by this bound.
- A source with any unresolved identity is held as a whole, protecting against unsafe cancellations. Confident extracted entries remain visible while that source awaits review.
- One-to-one site-local changes and exact-time cross-site changes with a common publication day are linked automatically. Other cross-site or many-to-many changes cannot safely establish a stable reschedule identity from these PDFs alone and require review/correction of the authoritative source.
- Stable IDs should be assigned in the roster during migration. Email changes without a verified explicit ID are held; duplicate active/archive records require resolution.
- Equal-publication conflicting content cannot be resolved by traversal order. The authoritative source needs owner review.
- No automatic deletion of source PDFs, historical records or old legacy tabs is included. State history grows; monitor workbook quota and execution duration and plan an audited database migration if volume outgrows Sheets.
- Existing production missed-notification and delivery rates remain unknown. Historical log absence is not proof that no external/manual email was sent.

The supplied evaluation exceeds the 90% extraction target on this limited verified corpus. It does not establish 90% accuracy on all historical or future Platinum Planner layouts; expand the manually verified set before a wider rollout.
