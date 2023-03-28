import {
  Collab,
  CollabEventsRecord,
  MetaRequest,
  SavedStateTree,
  UpdateMeta,
} from "../core";

/**
 * Convenience base class for a [[Collab]] implementation that sends
 * its own messages over the network.
 *
 * Extend this class to implement a "primitive" Collab with a simple
 * broadcast interface ([[sendPrimitive]]/[[receivePrimitive]]) and no child
 * Collabs. This matches how most collaborative data structures
 * are described algorithmically.
 *
 * See also:
 * - [[CObject]], for an "object" Collab that does not need to send its own
 * messages.
 * - [[PrimitiveCRDT]], for a primitive CRDT.
 *
 * @typeParam Events Events record indicating the names and types of
 * events emitted by this Collab.
 */
export abstract class CPrimitive<
  Events extends CollabEventsRecord = CollabEventsRecord
> extends Collab<Events> {
  /**
   * Broadcasts a message to other replicas of this Collab.
   * The message will be delivered to all replicas' [[receivePrimitive]],
   * including locally.
   *
   * Call this method instead of [[Collab.send]].
   *
   * @param message The message to send.
   * @param metaRequest A metadata request. The [[runtime]] will use
   * this when creating the [[UpdateMeta]] for [[receivePrimitive]].
   */
  protected sendPrimitive(
    message: Uint8Array | string,
    metaRequest?: MetaRequest
  ) {
    this.send([message], metaRequest === undefined ? [] : [metaRequest]);
  }

  receive(messageStack: (Uint8Array | string)[], meta: UpdateMeta): void {
    if (messageStack.length !== 1) {
      // We are not the target
      throw new Error("CPrimitive received message for child");
    }
    this.receivePrimitive(messageStack[0], meta);
  }

  /**
   * Receives a message sent by [[sendPrimitive]]
   * on a local or remote replica of this CPrimitive.
   *
   * This method processes the message, changes the
   * local state accordingly, and emits events describing the
   * local changes.
   *
   * This method should make assumptions and
   * ensure consistency guarantees
   * appropriate to its use case. For example, CRDTs may
   * assume eventual, exactly-once, causal-order message
   * delivery, and they must ensure strong eventual consistency.
   *
   * See [[Collab.receive]].
   *
   * @param message The message sent by [[sendPrimitive]].
   * @param meta Metadata attached to this message by the [[runtime]].
   * It incorporates the metadata request made in [[sendPrimitive]]. Note that
   * `meta.updateType` is always `"message"`.
   */
  protected abstract receivePrimitive(
    message: Uint8Array | string,
    meta: UpdateMeta
  ): void;

  save(): SavedStateTree {
    return { self: this.savePrimitive() };
  }

  // OPT: allow returning undefined, then call loadPrimitive(undefined).
  /**
   * Returns saved state describing the current state of this Collab.
   *
   * The saved state may later be passed to [[loadPrimitive]] on a replica of
   * this Collab, possibly in a different collaboration session,
   * with rules set by the [[runtime]]. For example, [[CRuntime]]
   * allows [[load]] to be called only at the beginning of a session,
   * before sending or receiving any messages.
   *
   * `savePrimitive` may be called at any time, possibly many times while an app
   * is running. Calling `savePrimitive` should not affect this Collab's
   * user-visible state.
   *
   * @return The saved state.
   */
  protected abstract savePrimitive(): Uint8Array;

  load(savedState: SavedStateTree, meta: UpdateMeta): void {
    this.loadPrimitive(savedState.self!, meta);
  }

  /**
   * Called by this Collab's parent to load some saved state.
   * You may assume that the saved state was generated by
   * [[savePrimitive]] on some replica of this Collab,
   * possibly in a different collaboration session,
   * with guarantees set by the [[runtime]].
   *
   * @param savedState The saved state to load.
   * @param meta Metadata attached to this saved state by the runtime.
   * It incorporates all possible metadata requests. Note that
   * `meta.updateType` is always `"savedState"`.
   */
  protected abstract loadPrimitive(
    savedState: Uint8Array,
    meta: UpdateMeta
  ): void;
}
