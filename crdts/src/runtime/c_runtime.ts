import {
  AbstractRuntime,
  CObject,
  Collab,
  CollabEventsRecord,
  InitToken,
  IRuntime,
  MessageMeta,
  MetaRequest,
  nonNull,
  ReplicaIDs,
  SavedStateMeta,
  SavedStateTreeSerializer,
} from "@collabs/core";
import { CausalMessageBuffer } from "./causal_message_buffer";
import { CRDTMessageMeta, CRDTMetaRequest } from "./crdt_meta";
import { SendCRDTMeta } from "./crdt_meta_implementations";
import { MessageSerializer } from "./message_serializer";

class PublicCObject extends CObject {
  registerCollab<C extends Collab>(
    name: string,
    childCallback: (init: InitToken) => C
  ): C {
    return super.registerCollab(name, childCallback);
  }
}

/**
 * Event emitted by [[CRuntime]] or [[AbstractDoc]]
 * when a message is to be sent, due to a local transaction.
 */
export interface SendEvent {
  /**
   * The message.
   */
  message: Uint8Array;
  /**
   * The message's sender: our [[AbstractDoc.replicaID]] / [[CRuntime.replicaID]].
   */
  senderID: string;
  /**
   * A 1-indexed counter for our local transactions.
   *
   * The pair `(senderID, senderCounter)` uniquely
   * identifies the message's transaction. It is sometimes called a *causal dot*.
   */
  senderCounter: number;
}

/**
 * Event emitted by [[CRuntime]] or [[AbstractDoc]]
 * after applying an update.
 */
export type UpdateEvent =
  | {
      /**
       * The serialized update.
       *
       * Specifically, this is:
       * - For a local message, its [[SendEvent.message]].
       * - For a remote message, the `message` passed to [[receive]].
       * - For a loaded state, the `savedState` passed to [[load]].
       */
      update: Uint8Array;
      /**
       * The caller who triggered this update.
       *
       * Specifically, this is:
       * - For a local message, `undefined`.
       * - For a remote message, the `caller` passed to [[receive]].
       * - For a loaded state, the `caller` passed to [[load]].
       * - For a remote message delivered as part of a loaded state
       * (due to unmet causal dependencies), the `caller` passed to [[load]].
       */
      caller: unknown | undefined;
    } & (
      | {
          /**
           * The update's type.
           */
          updateType: "message";
          /**
           * The replicaID that sent the message.
           */
          senderID: string;
          /**
           * A 1-indexed counter for senderID's transactions.
           *
           * The pair `(senderID, senderCounter)` uniquely
           * identifies the message's transaction. It is sometimes called a *causal dot*.
           */
          senderCounter: number;
          /**
           * Whether the message is for a local transaction, i.e., it results
           * from calling [[Collab]] methods on this replica.
           */
          isLocalOp: boolean;
        }
      | {
          /**
           * The update's type.
           */
          updateType: "savedState";
          /**
           * The vector clock for this saved state, mapping each replicaID
           * to the number of included transactions from that replicaID.
           *
           * This saved state includes precisely the transactions
           * with ID `(senderID, senderCounter)` where
           * `senderCounter <= (vectorClock.get(senderID) ?? 0)`.
           */
          vectorClock: Map<string, number>;
          /**
           * For each replicaID in [[vectorClock]]'s keys, the number of
           * transactions from that sender that were redundant
           * (i.e., we had already applied them), possibly 0.
           *
           * The effect of this saved state on our state was to
           * apply precisely the transactions with ID `(senderID, senderCounter)`
           * where:
           * - `vectorClock.has(senderID)`
           * - `redundant.get(senderID) < senderCounter <= vectorClock.get(senderID)`.
           */
          redundant: Map<string, number>;
          /**
           * Whether the message is for a local transaction, i.e., it results
           * from calling [[Collab]] methods on this replica.
           */
          isLocalOp: false;
        }
    );

/**
 * Events record for [[CRuntime]] and [[AbstractDoc]].
 */
export interface RuntimeEventsRecord {
  /**
   * Emitted when a message is to be sent.
   *
   * Its message should be delivered to each other replica's
   * [[CRuntime.receive]] /[[AbstractDoc.receive]]
   *  method, eventually and at-least-once.
   */
  Send: SendEvent;
  /**
   * Emitted after applying an update.
   *
   * The update may be a local message, remote message,
   * or saved state. Note that it may consist of multiple transactions.
   */
  Update: UpdateEvent;
  /**
   * Emitted after applying a synchronous set of updates. This
   * is a good time to rerender the GUI.
   *
   * Specifically, this event is emitted in a new microtask
   * scheduled at the end of the set's first update.
   */
  Change: object;
}

/**
 * Constructor options for [[CRuntime]] and [[AbstractDoc]].
 */
export interface RuntimeOptions {
  /**
   * If you guarantee that messages will always be delivered to
   * [[CRuntime.receive]] / [[AbstractDoc.receive]] in causal order, on all replicas (not just
   * this one), you may set this
   * to true to turn off causal ordering checks.
   *
   * For example, this may be true if all messages
   * pass through a central server that forwards them
   * in the order it receives them.
   *
   * [[CRuntime.receive]] / [[AbstractDoc.receive]] will still filter duplicate messages for you.
   */
  causalityGuaranteed?: boolean;
  /**
   * How long transactions should be in the absence of a top-level [[CRuntime.transact]] / [[AbstractDoc.transact]] call:
   * - "microtask" (default): All operations in the same microtask form a transaction
   * (specifically, until `Promise.resolve().then()` executes).
   * - "error": Throw an error if there is an operation
   * outside a top-level `transact` call.
   * - "debugOp": Each operation is its own transaction.
   * This is not recommended except for testing or benchmarking, since
   * individual Collabs may expect that sequential
   * operations are delivered together.
   */
  autoTransactions?: "microtask" | "error" | "debugOp";
  /**
   * For debugging/testing/benchmarking purposes, you may specify `replicaID`, typically
   * using [[ReplicaIDs.pseudoRandom]].
   *
   * Otherwise, `replicaID` is randomly generated using
   * [[ReplicaIDs.random]].
   */
  debugReplicaID?: string;
  /**
   * If true, [[AbstractDoc.load]] / [[CRuntime.load]] always pass loaded
   * state to the Collabs and emit an Update event, even if the saved state
   * appears to be redundant.
   *
   * Set this to true if loading is intentionally not idempotent (loading
   * an already-applied transaction has a nontrivial effect), or if you
   * want to test whether loading is idempotent.
   *
   * A saved state "appears to be redundant" if all of its vector clock
   * entries are <= our own. In that case, [[UpdateEvent]]'s `vectorClock`
   * and `redundant` fields are deep-equal.
   */
  allowRedundantLoads?: boolean;
}

/**
 * A runtime for a Collabs document, responsible for connecting
 * replicas of [[Collab]]s across devices and for other
 * whole-document functionality.
 *
 * Specifically, this runtime is for use with the @collabs/collabs and @collabs/crdts package,
 * which provide CRDT Collabs.
 *
 * For a usage example, see [Entry Points](../../../guide/entry_points.html#cruntime).
 *
 * See also: [[AbstractDoc]], which lets you encapsulate
 * a runtime and your "global variable" Collabs in a single object.
 */
export class CRuntime
  extends AbstractRuntime<RuntimeEventsRecord>
  implements IRuntime
{
  private readonly registry: PublicCObject;
  private readonly buffer: CausalMessageBuffer;

  private readonly autoTransactions: "microtask" | "debugOp" | "error";
  private readonly allowRedundantLoads: boolean;

  // State vars.
  private used = false;
  private inApplyUpdate = false;

  // Transaction vars.
  private inTransaction = false;
  private crdtMeta: SendCRDTMeta | null = null;
  private meta: MessageMeta | null = null;
  private messageBatches: (Uint8Array | string)[][] = [];

  readonly isCRDTRuntime = true;

  /**
   * Constructs a [[CRuntime]].
   *
   * @param options See [[RuntimeOptions]].
   */
  constructor(options: RuntimeOptions = {}) {
    super(options.debugReplicaID ?? ReplicaIDs.random());
    const causalityGuaranteed = options.causalityGuaranteed ?? false;
    this.autoTransactions = options.autoTransactions ?? "microtask";
    this.allowRedundantLoads = options.allowRedundantLoads ?? false;

    this.registry = super.setRootCollab((init) => new PublicCObject(init));

    this.buffer = new CausalMessageBuffer(
      this.replicaID,
      causalityGuaranteed,
      this.deliverFromBuffer.bind(this)
    );
  }

  /**
   * Registers a [[Collab]] as a ["global variable" Collab](../../../guide/initialization.html#global-variable-collabs)
   * in this runtime with the given name.
   *
   * Typically, you will call this method right after creating this CRuntime, with the style:
   * ```ts
   * const foo = runtime.registerCollab("foo", (init) => new FooClass(init, constructor args...));
   * ```
   * where `const foo: FooClass;` is a top-level variable.
   *
   * Registrations must be identical across all replicas, i.e., all CRuntime instances that share
   * messages and saved states.
   *
   * @param name A name for this property, unique among
   * this runtime's `registerCollab` calls.
   * We recommend using the same name as the property,
   * but you can also use short strings to reduce
   * network usage ("", "0", "1", ...).
   * @param collabCallback A callback that uses the
   * given [[InitToken]] to construct the registered [[Collab]].
   * @return The registered Collab.
   */
  registerCollab<C extends Collab>(
    name: string,
    collabCallback: (init: InitToken) => C
  ): C {
    if (this.used) {
      throw new Error("Already used (sent/received message or loaded state)");
    }
    return this.registry.registerCollab(name, collabCallback);
  }

  private beginTransaction() {
    this.inTransaction = true;
    // Wait to set meta until we actually send a message, if we do.
    // messageBatches was already cleared by the previous endTransaction.
  }

  private endTransaction() {
    this.inTransaction = false;

    if (this.meta === null) {
      // Trivial transaction, skip.
      return;
    }

    const meta = this.meta;
    const crdtMeta = nonNull(this.crdtMeta);
    crdtMeta.freeze();

    const message = MessageSerializer.serialize([this.messageBatches, meta]);

    this.messageBatches = [];
    this.meta = null;
    this.crdtMeta = null;

    // Send. It will be delivered to each other replica's
    // receive function, eventually at-least-once.
    this.emit("Send", {
      message,
      senderID: this.replicaID,
      senderCounter: crdtMeta.senderCounter,
    });

    this.emit("Update", {
      update: message,
      caller: undefined,
      updateType: "message",
      senderID: this.replicaID,
      senderCounter: crdtMeta.senderCounter,
      isLocalOp: true,
    });
    this.scheduleChangeEvent();
  }

  private changePending = false;
  /**
   * Emits a change event in a new microtask, if one is not pending already.
   */
  private scheduleChangeEvent() {
    if (!this.changePending) {
      this.changePending = true;
      void Promise.resolve().then(() => {
        this.changePending = false;
        this.emit("Change", {});
      });
    }
  }

  /**
   * Wraps `f`'s operations in a transaction. <!-- TODO: see transactions doc -->
   *
   * This method begins a transaction (if needed), calls `f()`,
   * then ends its transaction (if begun). Operations
   * not wrapped in a `transact` call use the constructor's
   * [[RuntimeOptions.autoTransactions]] option.
   *
   * If there are nested `transact` calls (possibly due to
   * [[RuntimeOptions.autoTransactions]]), only the outermost one matters.
   */
  transact(f: () => void) {
    const alreadyInTransaction = this.inTransaction;
    if (!alreadyInTransaction) this.beginTransaction();
    try {
      f();
    } finally {
      if (!alreadyInTransaction) this.endTransaction();
    }
  }

  childSend(
    child: Collab<CollabEventsRecord>,
    messageStack: (Uint8Array | string)[],
    metaRequests: MetaRequest[]
  ): void {
    if (child !== this.rootCollab) {
      throw new Error(`childSend called by non-root: ${child}`);
    }
    if (this.inApplyUpdate) {
      throw new Error(
        "CRuntime.send called during a receive/load call;" +
          " did you try to perform an operation in an event handler?"
      );
    }
    this.used = true;

    let autoEndTransaction = false;
    if (!this.inTransaction) {
      // Create a transaction according to options.autoTransactions.
      switch (this.autoTransactions) {
        case "microtask":
          this.beginTransaction();
          void Promise.resolve().then(() => this.endTransaction());
          break;
        case "debugOp":
          this.beginTransaction();
          autoEndTransaction = true;
          break;
        case "error":
          throw new Error(
            'Operation outside of transaction when options.autoTransactions = "error"'
          );
      }
    }

    if (this.meta === null) {
      // First message in a transaction; tick our current VC etc.
      // and use the new values to create the transaction's meta.
      // OPT: avoid this copy (not required by SendCRDTMeta,
      // but required due to tick()).
      const causallyMaximalVCKeys = new Set(this.buffer.maximalVCKeys);
      this.buffer.tick();

      this.crdtMeta = new SendCRDTMeta(
        this.replicaID,
        this.buffer.vc,
        causallyMaximalVCKeys,
        Date.now(),
        this.buffer.lamportTimestamp
      );
      this.meta = {
        senderID: this.replicaID,
        updateType: "message",
        isLocalOp: true,
        runtimeExtra: this.crdtMeta,
      };
    }

    // Process meta requests, including automatic mode by default.
    const crdtMeta = nonNull(this.crdtMeta);
    crdtMeta.requestAutomatic(true);
    for (const metaRequest of <CRDTMetaRequest[]>metaRequests) {
      if (metaRequest.lamportTimestamp) crdtMeta.requestLamportTimestamp();
      if (metaRequest.wallClockTime) crdtMeta.requestWallClockTime();
      if (metaRequest.vectorClockKeys) {
        for (const sender of metaRequest.vectorClockKeys) {
          crdtMeta.requestVectorClockEntry(sender);
        }
      }
    }

    // Local echo.
    this.rootCollab.receive(messageStack.slice(), this.meta);

    // Disable automatic meta request, to prevent accesses outside of
    // the local echo from changing the meta locally only.
    crdtMeta.requestAutomatic(false);

    this.messageBatches.push(messageStack);

    if (autoEndTransaction) this.endTransaction();
  }

  /**
   * Receives a message from another replica's [[RuntimeEventsRecord.Send]] event.
   * The message's sender must be a [[CRuntime]] that is a
   * replica of this one.
   *
   * The local Collabs process the message, change the
   * local state accordingly, and emit events describing the
   * local changes.
   *
   * Messages from other replicas should be received eventually and at-least-once. Arbitrary delays, duplicates,
   * reordering, and delivery of (redundant) messages from this replica
   * are acceptable. Two replicas will be in the same
   * state once they have the same set of received (or sent) messages.
   *
   * @param caller Optionally, a value to use as the [[UpdateEvent.caller]] field.
   * A caller can use that field to distinguish its own updates from updates
   * delivered by other sources.
   */
  receive(message: Uint8Array, caller?: unknown): void {
    if (this.inTransaction) {
      throw new Error("Cannot call receive() during a transaction");
    }
    if (this.inApplyUpdate) {
      throw new Error(
        "Cannot call receive() during another receive/load call;" +
          " did you try to deliver a message in a Collab's event handler?"
      );
    }

    this.inApplyUpdate = true;
    try {
      const [messageStacks, meta] = MessageSerializer.deserialize(message);
      if (this.buffer.process(message, messageStacks, meta, caller)) {
        this.buffer.check();
        this.scheduleChangeEvent();
      }
    } finally {
      this.inApplyUpdate = false;
    }
  }

  /**
   * Called by this.buffer when a (remote) transaction is ready for delivery.
   * This is always within our call to this.buffer.check() in [[receive]]
   * or [[load]], so errors will propagate to there.
   */
  private deliverFromBuffer(
    message: Uint8Array,
    messageStacks: (Uint8Array | string)[][],
    meta: MessageMeta,
    caller: unknown | undefined
  ) {
    for (const messageStack of messageStacks) {
      this.rootCollab.receive(messageStack, meta);
    }
    const crdtMeta = meta.runtimeExtra as CRDTMessageMeta;
    this.emit("Update", {
      update: message,
      caller,
      updateType: "message",
      senderID: crdtMeta.senderID,
      senderCounter: crdtMeta.senderCounter,
      isLocalOp: false,
    });
  }

  /**
   * Returns saved state describing the current state of this runtime,
   * including its Collabs.
   *
   * The saved state may later be passed to [[load]]
   * on a replica of this CRuntime, possibly in a different
   * collaboration session. That is equivalent to delivering all messages
   * that this document has already sent or received.
   */
  save(): Uint8Array {
    if (this.inTransaction) {
      throw new Error("Cannot call save() during a transaction");
    }
    if (this.inApplyUpdate) {
      throw new Error("Cannot call save() during a load/receive call");
    }

    const savedStateTree = this.rootCollab.save();
    // We know that PublicCObject's save has empty self, so it's okay to overwrite.
    savedStateTree.self = this.buffer.save();
    return SavedStateTreeSerializer.instance.serialize(savedStateTree);
  }

  /**
   * Loads saved state. The saved state must be from
   * a call to [[load]] on a CRuntime that is a replica
   * of this one.
   *
   * The local Collabs merge in the saved state, change the
   * local state accordingly, and emit events describing the
   * local changes.
   *
   * Calling load is roughly equivalent to calling [[receive]]
   * on every message that influenced the saved state
   * (skipping already-received messages),
   * but it is typically much more efficient.
   *
   * @param savedState Saved state from another replica's [[save]] call.
   * @param caller Optionally, a value to use as the [[UpdateEvent.caller]] field.
   * A caller can use that field to distinguish its own updates from updates
   * delivered by other sources.
   */
  load(savedState: Uint8Array, caller?: unknown): void {
    if (this.inTransaction) {
      throw new Error("Cannot call load() during a transaction");
    }
    if (this.inApplyUpdate) {
      throw new Error(
        "Cannot call load() during another receive/load call;" +
          " did you try to load in a Collab's event handler?"
      );
    }
    this.used = true;

    this.inApplyUpdate = true;
    try {
      const savedStateTree =
        SavedStateTreeSerializer.instance.deserialize(savedState);
      const loadCRDTMeta = this.buffer.load(
        nonNull(savedStateTree.self),
        caller
      );
      savedStateTree.self = undefined;
      const meta: SavedStateMeta = {
        updateType: "savedState",
        runtimeExtra: loadCRDTMeta,
        isLocalOp: false,
      };

      let isRedundant = true;
      const vectorClock = new Map<string, number>();
      const redundant = new Map<string, number>();
      for (const [replicaID, remote] of loadCRDTMeta.remoteVectorClock
        .vcEntries) {
        vectorClock.set(replicaID, remote);
        const local = loadCRDTMeta.localVectorClock.get(replicaID);
        // If local > remote (fully redundant), set to remote, so that
        // redundant.get(replicaID) == vectorClock.get(replicaID).
        redundant.set(replicaID, Math.min(local, remote));
        if (local < remote) isRedundant = false;
      }

      if (isRedundant && !this.allowRedundantLoads) {
        // The saved state is redundant. Don't load or emit events.

        // We did still call buffer.load. This doesn't affect our VC because
        // the remote VC was redundant, but it may still have added
        // new messages to the buffer. Check if any of these are ready in
        // our state, and if so, emit a Change event.
        if (this.buffer.check()) this.scheduleChangeEvent();

        return;
      }

      this.rootCollab.load(savedStateTree, meta);

      this.emit("Update", {
        update: savedState,
        caller,
        updateType: "savedState",
        vectorClock,
        redundant,
        isLocalOp: false,
      });

      this.buffer.check();

      this.scheduleChangeEvent();
    } finally {
      this.inApplyUpdate = false;
    }
  }

  /**
   *
   * The vector clock for our current state, mapping each replicaID
   * to the number of applied transactions from that replicaID.
   *
   * Our current state includes precisely the transactions
   * with ID `(senderID, senderCounter)` where
   * `senderCounter <= (vectorClock.get(senderID) ?? 0)`.
   */
  vectorClock(): Map<string, number> {
    const vc = new Map(this.buffer.vc);
    if (vc.get(this.replicaID) === 0) vc.delete(this.replicaID);
    return vc;
  }
}
