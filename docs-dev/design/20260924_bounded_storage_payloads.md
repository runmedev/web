# Bounded notebook discovery and OPFS payloads

Opening Drive status caused concurrent `files.toArray()` requests to retain
arrays of complete cached notebooks. A SharedWorker does not serialize async
requests across their `await` boundaries. Repeated change notifications could
therefore retain several copies of the database's payloads. Background discovery
also used bulk reads, so closing status alone did not remove the risk.

## Bounded reads

Status requests use primary-key cursors with a server-enforced maximum of 50
record values. A page enumerates at most 51 keys for lookahead, then reads each
record separately and retains only its small display row. File records and
pending creation records occupy successive pages. Completed creation receipts
count toward the read budget but produce no row; a page can therefore be empty.
Filters, sorting, and Sync Required operate on the current page. There is no
global count query or payload-based sort. Pagination is a live view, not a
snapshot: concurrent inserts before a cursor appear when that page is revisited.

`readTablePage(table, project, options)` owns both caps: 50 source record reads
and 1 MiB of estimated returned metadata per call. Callers may lower these
budgets but cannot raise them. Each record is projected before it enters the
result array, so legacy inline content is discarded immediately. An individually
oversized projection fails explicitly; if the next row would exceed the page's
byte budget, its key is retried on the next page. Missing and filtered-out rows
still consume the read budget and advance the cursor. The byte estimate charges
strings at two bytes per character plus object/property allowances; it avoids
serializing large strings and does not claim to bound all engine heap overhead.

`scanTable()` streams full records for migration and background tasks without
prefetching bodies. Both helpers share private capped key reads. The unbounded
`listFileSyncStatuses()` compatibility API has been removed; callers use the page
API and its cursor. The storage ESLint rule rejects bulk enumeration on file and
creation tables, including query chains and local aliases. An app test runs this
rule over production sources so CI catches regressions even without a lint job.

Each mounted status view coalesces events for 100 ms and allows one active read
plus one pending refresh. The owner shares identical in-flight pages between
tabs. Background work uses batches of 50 keys and reads one record at a time.
It may visit all records to discover pending work; it does not retain all values.

| Path | Previous behavior | Current behavior |
| --- | --- | --- |
| Status / pending creations | Full payload arrays, repeated file reads, overlapping refreshes | Bounded pages, one value at a time, coalesced refreshes |
| Source-sync discovery | Full file array | Bounded key scan; retain only matching IDs |
| Failed export recovery | Full file array | Bounded key scan; retain only matching IDs |
| Creation recovery | Full creation array; retry closure could retain payload | Bounded scan; closures capture request ID only |
| Local folder listing | Full file array | Bounded scan; retain only child IDs |
| Legacy conversion recovery | Full file array | Bounded scan; retain only candidate IDs |
| Training-example lookup | Full file array | Bounded scan; stop at first matching Drive identity |

Remaining unbounded lists found in the audit are folder/workspace metadata and
linked-media cache references. Their entries do not contain notebook bodies.
Comments are queried by remote URI, console cells by session, and ExecuteCode
outputs by operation. Those scoped content reads can still be large, as can
explicitly opening one huge notebook; this change does not impose a universal
heap limit or redesign those APIs. Older pre-version-8 schema upgrades also have
Dexie `modify()` migrations; the deployed version-8 upgrade does not use them.

## Payload ownership and migration

IndexedDB schema 9 holds metadata and immutable OPFS references. Notebook `doc`,
pending initialization, pending Drive creation, and legacy inline conflict bodies
are externalized. A reference contains an opaque path, UTF-8 byte length, and
SHA-256 checksum. Native hashing avoids building JavaScript number arrays for
large strings. This integrity checksum is separate from Drive's MD5 checksum.

Writes close a new OPFS file before publishing its reference in IndexedDB.
Existing content is never overwritten in place. An interrupted write or failed
metadata commit leaves the previous record readable. `getFileRecord()` hydrates
content for explicit consumers; metadata readers use `files.get()` and never
open OPFS. Existing IndexedDB inline records remain readable during migration.

Migration starts in the background, so a large legacy database cannot prevent
the worker handshake. It processes one record at a time, writes its payload,
then rereads and compares the original record inside an IndexedDB transaction.
If anything changed, it preserves the newer record. Failures preserve the
original inline bytes and log a diagnostic; a later worker restart retries.
OPFS operations inside existing Dexie transactions use `Dexie.waitFor()` to keep
the transaction alive. Missing/corrupt referenced bytes fail visibly and retain
the reference; they are never replaced with an empty notebook.

Only the SharedWorker collects obsolete generic payload generations. After its
startup scan has visited every durable reference, it walks OPFS directory entries
lazily and deletes unreferenced files. Dexie reading hooks protect references
before async consumers receive records; writes protect new paths before creating
files. Every reference used during this worker session stays protected, so
collection cannot race an in-flight save/read. Consequently, obsolete generations
created during a long-running session are reclaimed on a later worker restart,
not on every save. Collection touches only the generic payload directory, never
operation-log history, IPYNB shadows, or other OPFS stores.

The protocol version changes along with the schema. Close all same-origin tabs
and worker inspectors before reopening after rollout. Old code cannot reopen
schema 9; rollback needs a compatible reader or a deliberate data migration,
not deletion of site data.

## Validation

Unit tests cover bounded scans, event bursts, multi-port request sharing,
migration races, durable-write failures, missing content, and safe collection.
The real-browser CUJ starts with schema 8, migrates a 50 MiB payload, edits
JSON/IPYNB notebooks, exercises OPFS inside a Dexie transaction, and restarts the
browser to verify both content and collection. The existing SharedWorker smoke
test verifies concurrent tabs, offline creation, and operation-log persistence.
See [the CUJ](../CUJs/drive-sync-recovery.md) for reproduction and artifacts.
