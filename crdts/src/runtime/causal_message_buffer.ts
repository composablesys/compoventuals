import {
  int64AsNumber,
  MessageStacksSerializer,
  UpdateMeta,
} from "@collabs/core";
import { CausalMessageBufferSave } from "../../generated/proto_compiled";
import { CRDTMessageMeta } from "./crdt_meta";
import {
  LoadCRDTMeta,
  ReceiveCRDTMeta,
  RuntimeMetaSerializer,
} from "./crdt_meta_implementations";

/**
 * Debug flag, enables console.log's when causality checks
 * fail.
 */
const DEBUG = false;

interface ReceivedTransaction {
  messageStacks: (Uint8Array | string)[][];
  meta: UpdateMeta;
}

/**
 * A buffer for delivering messages in causal order, used
 * by [[CRuntime]].
 *
 * Also manages CRDT metadata (vector clock, causally maximal keys,
 * Lamport timestamp).
 */
export class CausalMessageBuffer {
  /**
   * The vector clock. Missing entries are presumed 0.
   *
   * An entry for this replica is always present, even when 0.
   *
   * Do not modify externally.
   */
  readonly vc = new Map<string, number>();
  /**
   * May include us, if we are causally maximal
   * (no received messages dominate our last sent message).
   *
   * If causalityGuaranteed, this is always empty.
   *
   * Do not modify externally.
   */
  readonly maximalVCKeys = new Set<string>();
  /**
   * The Lamport timestamp.
   *
   * Do not modify externally.
   */
  lamportTimestamp = 0;

  /**
   * Internal buffer for messages that have been received but not
   * yet delivered, either because check() was not called or they
   * are not causally ready.
   *
   * Keyed by encodeDot's output.
   */
  private readonly buffer = new Map<string, ReceivedTransaction>();

  /**
   * @param deliver Callback to deliver messages, where
   * "deliver" means "actually process since it's causally
   * ready now".
   */
  constructor(
    private readonly replicaID: string,
    private readonly causalityGuaranteed: boolean,
    private readonly deliver: (
      messageStacks: (Uint8Array | string)[][],
      meta: UpdateMeta
    ) => void
  ) {
    // this.replicaID is the first map entry.
    this.vc.set(this.replicaID, 0);
  }

  private encodeDot(crdtMeta: CRDTMessageMeta) {
    return `${crdtMeta.senderCounter},${crdtMeta.senderID}`;
  }

  /**
   * Processes the given remote message:
   * - If already delivered, does nothing.
   * - Else if ready for delivery, delivers it.
   * - Else adds it to the buffer.
   *
   * @returns Whether the message was delivered.
   */
  process(messageStacks: (Uint8Array | string)[][], meta: UpdateMeta): boolean {
    const crdtMeta = <ReceiveCRDTMeta>meta.runtimeExtra;
    if (!this.isAlreadyDelivered(crdtMeta)) {
      if (this.isReady(crdtMeta)) {
        // Ready for delivery.
        this.deliver(messageStacks, meta);
        this.processRemoteDelivery(crdtMeta);
        return true;
      } else {
        // Add to this.buffer if it's not already present.
        const dot = this.encodeDot(crdtMeta);
        if (!this.buffer.has(dot)) {
          this.buffer.set(dot, { messageStacks, meta });
        }
      }
    } else if (DEBUG) {
      console.log("CausalMessageBuffer.add: not adding");
      console.log("(already received)");
      console.log([...this.vc]);
      console.log(crdtMeta);
    }
    return false;
  }

  /**
   * Checks the buffer and delivers any causally ready
   * transactions.
   */
  check(): void {
    let recheck = false;

    do {
      recheck = false;
      for (const [dot, tr] of this.buffer) {
        const crdtMeta = <ReceiveCRDTMeta>tr.meta.runtimeExtra;

        if (this.isReady(crdtMeta)) {
          // Ready for delivery.
          this.buffer.delete(dot);
          this.deliver(tr.messageStacks, tr.meta);
          this.processRemoteDelivery(crdtMeta);
          // Delivering messages may make new ones ready, so go
          // through the whole buffer again.
          recheck = true;
        } else {
          if (DEBUG) {
            console.log("CRDTMetaLayer.checkMessageBuffer: not ready");
          }
          if (this.isAlreadyDelivered(crdtMeta)) {
            // Remove from the buffer.
            this.buffer.delete(dot);
            if (DEBUG) console.log("(already received)");
          }
          if (DEBUG) {
            console.log([...this.vc]);
            console.log(crdtMeta);
          }
        }
      }
    } while (recheck);
  }

  /**
   * @return whether a message with the given crdtMeta
   * is ready for delivery, according to the causal order.
   */
  private isReady(crdtMeta: ReceiveCRDTMeta): boolean {
    if (this.causalityGuaranteed) return true;

    // Check that sender's entry is one more than ours.
    if ((this.vc.get(crdtMeta.senderID) ?? 0) !== crdtMeta.senderCounter - 1) {
      return false;
    }

    // Check that other causally maximal entries are <= ours.
    // Note that this excludes sender.
    let i = 0;
    for (const [key, value] of crdtMeta.vcEntries) {
      if (i === crdtMeta.maximalVcKeyCount) break;
      if ((this.vc.get(key) ?? 0) < value) {
        return false;
      }
      i++;
    }

    return true;
  }

  /**
   * @return whether a message with the given sender and
   * senderCounter
   * has already been delivered.
   */
  private isAlreadyDelivered(crdtMeta: ReceiveCRDTMeta): boolean {
    const senderEntry = this.vc.get(crdtMeta.senderID);
    if (senderEntry !== undefined) {
      if (senderEntry >= crdtMeta.senderCounter) return true;
    }
    return false;
  }

  private processRemoteDelivery(crdtMeta: ReceiveCRDTMeta) {
    if (!this.causalityGuaranteed) {
      // Delete any current keys that are causally dominated by
      // crdtMeta.
      let i = 0;
      for (const [key, value] of crdtMeta.vcEntries) {
        if (i === crdtMeta.maximalVcKeyCount) break;
        if (this.vc.get(key) === value) {
          this.maximalVCKeys.delete(key);
        }
        i++;
      }
      // Add a new key for this message.
      this.maximalVCKeys.add(crdtMeta.senderID);
    }
    // Update vc.
    this.vc.set(crdtMeta.senderID, crdtMeta.senderCounter);
    // Update Lamport timestamp if it's present.
    // Skipping this when it's not present technically violates the def
    // of Lamport timestamp, and it is still causally-compatible due to
    // causal order delivery.
    this.lamportTimestamp = Math.max(
      this.lamportTimestamp,
      crdtMeta.lamportTimestamp ?? 0
    );
  }

  /**
   * Update our meta for a new local transaction.
   */
  tick() {
    // Update vc.
    this.vc.set(this.replicaID, this.vc.get(this.replicaID)! + 1);
    if (!this.causalityGuaranteed) {
      // Our own message causally dominates every current key.
      this.maximalVCKeys.clear();
      this.maximalVCKeys.add(this.replicaID);
    }
    // Update Lamport timestamp.
    this.lamportTimestamp++;
  }

  save(): Uint8Array {
    const vcKeys = new Array<string>(this.vc.size);
    const vcValues = new Array<number>(this.vc.size);
    let i = 0;
    for (const [key, value] of this.vc) {
      // Since this.replicaID is the first map entry, it is stored in
      // vcKeys[0].
      vcKeys[i] = key;
      vcValues[i] = value;
      i++;
    }

    // OPT: compress repeated senders in VCs.
    const bufferMessageStacks = new Array<Uint8Array>(this.buffer.size);
    const bufferMetas = new Array<Uint8Array>(this.buffer.size);
    i = 0;
    for (const tr of this.buffer.values()) {
      bufferMessageStacks[i] = MessageStacksSerializer.instance.serialize(
        tr.messageStacks
      );
      bufferMetas[i] = RuntimeMetaSerializer.instance.serialize(tr.meta);
      i++;
    }

    const saveMessage = CausalMessageBufferSave.create({
      vcKeys,
      vcValues,
      maximalVcKeys: [...this.maximalVCKeys],
      lamportTimestamp: this.lamportTimestamp,
      bufferMessageStacks,
      bufferMetas,
    });
    return CausalMessageBufferSave.encode(saveMessage).finish();
  }

  /**
   * @param savedState
   * @param used
   */
  load(savedState: Uint8Array): LoadCRDTMeta {
    const oldLocalVC = new Map(this.vc);
    const oldLocalLamportTimestamp = this.lamportTimestamp;

    const decoded = CausalMessageBufferSave.decode(savedState);

    const remoteVC = new Map<string, number>();
    for (let i = 0; i < decoded.vcKeys.length; i++) {
      remoteVC.set(decoded.vcKeys[i], int64AsNumber(decoded.vcValues[i]));
    }
    const remoteMaximalVCKeys = new Set(decoded.maximalVcKeys);

    // 1. Delete our maximal entris that are not present in the saved
    // state and that are causally dominated by the remote VC.
    // (Strictly speaking, we compare entries not keys: values must match
    // to be present in the intersection.)
    for (const key of this.maximalVCKeys) {
      const localValue = this.vc.get(key)!;
      const remoteValue = remoteVC.get(key) ?? 0;
      if (!(remoteMaximalVCKeys.has(key) && localValue === remoteValue)) {
        if (remoteValue >= localValue) this.maximalVCKeys.delete(key);
      }
    }
    // 2. Add new maximal keys (not already present here) that are not
    // causally dominated by the local VC.
    for (const [key, remoteValue] of remoteVC) {
      if ((this.vc.get(key) ?? 0) < remoteValue) {
        this.maximalVCKeys.add(key);
      }
    }

    for (const [key, value] of remoteVC) {
      this.vc.set(key, Math.max(this.vc.get(key) ?? 0, value));
    }
    const remoteLamportTimestamp = int64AsNumber(decoded.lamportTimestamp);
    this.lamportTimestamp = Math.max(
      this.lamportTimestamp,
      remoteLamportTimestamp
    );
    // Just concatenate buffers for now. CRuntime will call check() later
    // to process any newly-ready messages (local or remote)
    // and delete already-received messages.
    // TODO: avoid duplicating the buffer - if you merge in your own state,
    // the buffer will double in size each time.
    // (Could also do that for early-receives in general.)
    for (let i = 0; i < decoded.bufferMessageStacks.length; i++) {
      const meta = RuntimeMetaSerializer.instance.deserialize(
        decoded.bufferMetas[i]
      );
      const dot = this.encodeDot(<CRDTMessageMeta>meta.runtimeExtra);
      if (this.buffer.has(dot)) {
        this.buffer.set(dot, {
          messageStacks: MessageStacksSerializer.instance.deserialize(
            decoded.bufferMessageStacks[i]
          ),
          meta,
        });
      }
    }

    return new LoadCRDTMeta(
      // First vc entry is the sender's replicaID.
      decoded.vcKeys[0],
      oldLocalVC,
      remoteVC,
      oldLocalLamportTimestamp,
      remoteLamportTimestamp
    );
  }
}
