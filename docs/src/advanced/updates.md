# Updates and Sync

TODO: Cross-link in CRuntime/AbstractDoc class header

To synchronize different copies of a document, Collabs gives you _updates_. You and your [providers](../guide/providers.html) are responsible for moving these updates around.

This page describes Collabs's update model and rules for syncing documents. It complements the API docs for [CRuntime](TODO) and [AbstractDoc](TODO) (which have the same updated-related APIs).

For examples of how to work with updates, see our published providers' [source code](https://github.com/composablesys/collabs).

## Terminology

TODO: Link from all 3 transact() functions and CRDTMessageMeta header (should have TODOs)

An **operation** is a Collab method call that mutates its collaborative state. E.g., a call to [CText.insert](TODO).

A **transaction** is a sequence of operations by the same user. These operations are grouped together so that all users apply them together (atomically), without interleaving other operations.

By default, all Collab operations in the same microtask are grouped into a transaction. This is network-efficient and avoids accidentally splitting up compound operations (e.g., CText.insert can be a composition of two lower-level operations). However, you can customize this behavior using the TODO option in CRuntime/AbstractDoc's constructor and the [CRuntime.transact](TODO)/[AbstractDoc.transact](TODO) method.

> Although we use the term "transaction", these are not ACID transactions like in a database - it is okay for concurrent transactions to mutate the same state.

An **update** is a Uint8Array describing a set of transactions. They come in two types:

- A **message** describes a single transaction. The user who performed the transaction emits its message in a ["Send" event](TODO) on its CRuntime/AbstractDoc. Any user can deliver this message to [CRuntime.receive](TODO)/[AbstractDoc.receive](TODO) to apply the transaction.
- A **saved state** describes all transactions up to a certain point. Any user can call [CRuntime.save](TODO)/[AbstractDoc.save](TODO) at any time to get a saved state describing all transactions applied to their document so far. Any user can deliver that saved state to [CRuntime.load](TODO)/[AbstractDoc.load](TODO) to apply all of its transactions.

## Syncing Documents

The golden rule for syncing documents is: **Two documents that have applied the same transactions will be in the same state.**

> This assumes that the documents have the same "schema" in the sense of [Using CRuntime](../guide/documents.html#using-cruntime).

You can "apply" a transaction by applying any update that contains that transaction, whether it's a message or saved state. It's okay to apply a transaction more than once; duplicates will be ignored. For example, if you load two saved states that overlap, you'll get the "merged" result that you expect. It's also okay if some users apply a transaction via a message while others apply it via a saved state.

Whenever a doc applies an update (including at the end of a local transaction), it emits an ["Update" event](TODO). This includes a copy of the update itself, as well as the "caller" that delivered the update (an optional argument to `receive` and `load`). Our providers use this to work together: if @collabs/ws-server applies an update to the document, @collabs/indexeddb learns of it from the "Update" event and saves it in IndexedDB, just like for local operations.

Internally, messages are *not* always applied immediately. Instead, they are buffered until all after applying all [causally prior](TODO) transactions, to enforce [causal consistency](TODO). Saved states *are* always applied immediately, since they have all causally prior transactions built-in.

## Patterns

An easy way to sync two documents is to exchange saved states:

1. Peer A calls `save()` and sends the result to peer B.
2. Peer B calls `save()` and sends the result to peer A.
3. Each peer calls `load(savedState)` on the saved state they received from the other peer.

Now they've both applied the same set of transactions - the union of their starting sets.

Another common pattern that our providers use is:

1. When you first connect to a new peer, send your current saved state.
2. Register an "Update" handler on your copy of the document and forward all further updates to that peer, except for updates that you delivered yourself (`e.caller === this`).

If the peer actually receives all of your updates, then their state will be as up-to-date as yours. If they ever miss one (e.g., the connection drops temporarily), start over at step 1, even though you know this is a bit redundant.

A third pattern eliminates this redundancy at the cost of more storage:

1. TODO: trID/vc-based sync.