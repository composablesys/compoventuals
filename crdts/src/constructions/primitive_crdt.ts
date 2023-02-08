import { CollabEventsRecord, CPrimitive, UpdateMeta } from "@collabs/core";
import { CRDTMeta, CRDTMetaRequest } from "../crdt-runtime";

/**
 * Superclass for a primitive (message-passing)
 * operation-based CRDT.
 *
 * Messages sent with [[sendCRDT]] are delivered to all
 * replica's [[receiveCRDT]] methods (including the sender's)
 * exactly once, in causal order, and tagged with
 * [[CRDTMessageMeta]]. Sent messages are delivered to the local
 * replica immediately. Subclasses are expected to implement
 * an operation-based CRDT algorithm using these methods.
 *
 * Besides renaming send and receive to sendCRDT and receiveCRDT,
 * the only user-facing difference between [[PrimitiveCRDT]]
 * and [[CPrimitive]] is that this class supplies
 * [[CRDTMessageMeta]] to recipients.
 *
 * To function, a [[PrimitiveCRDT]] must have an ancestor
 * that supplies the extra [[UpdateMeta]] key
 * [[CRDTMeta.MESSAGE_META_KEY]] (typically [[CRDTMetaLayer]]). Also, its ancestors
 * must deliver messages exactly once, in causal order,
 * with sent messages delivered to the local replica immediately.
 */
export abstract class PrimitiveCRDT<
  Events extends CollabEventsRecord = CollabEventsRecord
> extends CPrimitive<Events> {
  /**
   * Send `message` to all replicas' [[receiveCRDT]] methods.
   *
   * [[CRDTMeta]] fields used by [[receiveCRDT]] must be requested in
   * `requests` (except for [[CRDTMeta.sender]] and [[CRDTMeta.senderCounter]],
   * which are always included). Possible requests are:
   * - `vectorClockEntries`: Include the vector clock entries with the
   * specified keys (`replicaID`'s). Non-requested entries may return 0
   * instead of their correct value (as if no messages had been received from
   * that replica).
   * - `wallClockTime`: If true, include non-null [[CRDTMeta.wallClockTime]].
   * - `lamportTimestamp`: If true, nclude non-null [[CRDTMeta.lamportTimestamp]].
   * - `all`: If true, include all metadata, including all vector clock entries.
   * Use this with caution, since the number of vector clock entries may be
   * very large.
   * - `automatic`: If true, include any metadata that are accessed during
   * the sender's own [[receiveCRDT]] call, i.e., during the local echo.
   * This is sufficient for most use cases, but you
   * should think carefully through the steps that
   * remote recipients would take, and ensure that they
   * only need to access the same metadata as the sender.
   * In particular, ensure that it is okay for
   * remote replicas to see incorrect 0 entries in
   * the vector clock, so long as that only happens with
   * entries not accessed by the sender.
   */
  protected sendCRDT(
    message: Uint8Array | string,
    request?: CRDTMetaRequest
  ): void {
    // TODO: need to not do this if inside runLocally call. (Probably won't
    // break anything, but is inefficient and abstraction-busting.)
    super.sendPrimitive(message, request);
  }

  /**
   * Do not override; override [[receiveCRDT]] instead.
   */
  protected receivePrimitive(
    message: Uint8Array | string,
    meta: UpdateMeta
  ): void {
    const crdtMeta = <CRDTMeta>meta.runtimeExtra;
    if (crdtMeta === undefined) {
      throw new Error("No CRDTMeta supplied; ensure you are using CRuntime");
    }
    this.receiveCRDT(message, meta, crdtMeta);
  }

  /**
   * Override to receive messages sent with [[sendCRDT]].
   *
   * This abstract method is like [[CPrimitive.receivePrimitive]] or
   * [[Collab.receive]], except it also provides `crdtMeta`.
   * That contains metadata useful for implementing op-based CRDTs,
   * e.g., a vector clock.
   */
  protected abstract receiveCRDT(
    message: Uint8Array | string,
    meta: UpdateMeta,
    crdtMeta: CRDTMeta
  ): void;
}
