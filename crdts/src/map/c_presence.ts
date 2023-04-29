import {
  CPrimitive,
  DefaultSerializer,
  InitToken,
  MapEventsRecord,
  Optional,
  Serializer,
  UpdateMeta,
} from "@collabs/core";
import { PresenceMessage } from "../../generated/proto_compiled";

enum MessageType {
  Set = 1,
  Update = 2,
  Delete = 3,
}

interface TimedValue<F> {
  value: F;
  present: boolean;
  timeoutID: ReturnType<typeof setTimeout> | null;
}

/**
 * A map for sharing *presence info* between present (simultaneously online)
 * replicas, e.g., usernames or shared cursors.
 *
 * Each replica controls a fixed key: its [[IRuntime.replicaID]].
 * Its value should be a plain object that contains presence info about
 * itself, such as its user's latest [[Cursor]] location in a collaborative
 * text editor.
 *
 * Values are ephemeral: they expire at a fixed interval after the sender's
 * last update (default 30 seconds), and they are not saved.
 * This helps ensure that you only see values for present replicas.
 *
 * Values must be internally immutable;
 * mutating a value internally will not change it on
 * other replicas. Instead, use [[updateOurs]].
 *
 * See also:
 * - [[CValueMap]]: for an ordinary collaborative map.
 * - [[CMessenger]]: for sending ephemeral (non-saved) messages in general.
 *
 * @typeParam F The value type: a plain object that contains presence info
 * about a single replica.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class CPresence<V extends Record<string, any>> extends CPrimitive<
  MapEventsRecord<string, V>
> {
  /**
   * The default [[ttlMS]]: 30 seconds.
   */
  static readonly TTL_MS_DEFAULT = 30000;

  private readonly value = new Map<string, TimedValue<V>>();
  /** Cached size. */
  private _size = 0;

  private joined = false;

  private readonly updateSerializer: Serializer<Partial<V>>;
  /**
   * The time-to-live for received values in milliseconds,
   * i.e., how long until a value expires locally. The time is measured from
   * when we receive the value, not when it was sent.
   *
   * Configure using the constructor's `options.ttlMS`.
   * Defaults to [[TTL_MS_DEFAULT]].
   */
  readonly ttlMS: number;

  /**
   * Constructs a CPresence.
   *
   * @param options.updatesSerializer Serializer for updates ([[setOurs]] and
   * [[updateOurs]]), which change a subset of F's keys.
   * Defaults to [[DefaultSerializer]].
   * @param options.ttlMS The value of [[ttlMS]]. Defaults to [[TTL_MS_DEFAULT]].
   */
  constructor(
    init: InitToken,
    options: {
      updateSerializer?: Serializer<Partial<V>>;
      ttlMS?: number;
    } = {}
  ) {
    super(init);

    this.updateSerializer =
      options?.updateSerializer ?? DefaultSerializer.getInstance();
    this.ttlMS = options?.ttlMS ?? CPresence.TTL_MS_DEFAULT;

    // Maintain this._size as a view of the externally-visible map's size.
    this.on("Set", (e) => {
      if (!e.previousValue.isPresent) this._size++;
    });
    this.on("Delete", () => this._size--);
  }

  /**
   * Sets our value, i.e., the value at key [[IRuntime.replicaID]].
   *
   * Typically, you call this once at the start of your app with semi-constant
   * data (e.g., the local user's name), then use [[updateOurs]] for
   * future updates (e.g., cursor positions).
   *
   * The first time this is called, it also "joins" the group,
   * requesting that all present replicas send their current presence
   * values.
   */
  setOurs(value: V): void {
    const message = PresenceMessage.create({
      type: MessageType.Set,
      updates: this.updateSerializer.serialize(value),
      requestAll: !this.joined ? true : undefined,
    });
    this.joined = true;
    super.sendPrimitive(PresenceMessage.encode(message).finish());
  }

  /**
   * Updates a property of our value. Other properties are unchanged.
   */
  updateOurs<K extends keyof V & string>(property: K, value: V[K]): void {
    if (!this.joined) {
      throw new Error("Must call setOurs before updateOurs");
    }

    const updates: Partial<V> = {};
    updates[property] = value;
    super.sendPrimitive(
      PresenceMessage.encode({
        type: MessageType.Update,
        updates: this.updateSerializer.serialize(updates),
      }).finish()
    );
  }

  /**
   * Deletes our value, i.e., the value at key [[IRuntime.replicaID]].
   *
   * It is a good idea to call this method if the user is about to disconnect or if
   * they stopped using the relevant app/component.
   * That way, other users immediately see that this user is no longer
   * present, instead of waiting for the current value to expire.
   */
  deleteOurs(): void {
    super.sendPrimitive(
      PresenceMessage.encode({ type: MessageType.Delete }).finish()
    );
  }

  protected receivePrimitive(
    message: Uint8Array | string,
    meta: UpdateMeta
  ): void {
    const replicaID = meta.senderID;
    const decoded = PresenceMessage.decode(<Uint8Array>message);

    switch (decoded.type as MessageType) {
      case MessageType.Set:
      case MessageType.Update: {
        // If the message is forRequestAll and its value is already present,
        // treat it as a heartbeat - keep the value alive without changing
        // it (only emitting Set if it had expired).
        if (decoded.forRequestAll && this.has(replicaID)) {
          const timedValue = this.value.get(replicaID)!;
          this.resetTimeout(replicaID);
          if (!timedValue.present) {
            timedValue.present = true;
            this.emit("Set", {
              key: replicaID,
              value: timedValue.value,
              previousValue: Optional.empty(),
              meta,
            });
          }
          break;
        }

        const previousValue = this.has(replicaID)
          ? Optional.of(this.get(replicaID)!)
          : Optional.empty<V>();

        const updates = this.updateSerializer.deserialize(decoded.updates);
        let value: V;
        if (decoded.type === MessageType.Set) {
          value = updates as V;
        } else {
          const oldTimedState = this.value.get(replicaID);
          if (oldTimedState === undefined) {
            // We don't have a base value to update; skip.
            break;
          }
          value = { ...oldTimedState.value, ...updates };
        }

        const oldTimeoutID = this.value.get(replicaID)?.timeoutID;
        if (oldTimeoutID !== undefined && oldTimeoutID !== null) {
          clearTimeout(oldTimeoutID);
        }

        this.value.set(replicaID, {
          value,
          timeoutID: null,
          present: true,
        });
        this.resetTimeout(replicaID);

        this.emit("Set", {
          key: replicaID,
          // TODO: rename value to value to match this?
          value: value,
          previousValue,
          meta,
        });
        break;
      }
      case MessageType.Delete: {
        const timedValue = this.value.get(replicaID);
        if (timedValue !== undefined) {
          if (timedValue.timeoutID !== null) clearTimeout(timedValue.timeoutID);
          this.value.delete(replicaID);
          if (timedValue.present) {
            this.emit("Delete", {
              key: replicaID,
              value: timedValue.value,
              meta,
            });
          }
        }
        break;
      }
    }

    if (decoded.requestAll) {
      // Send our value to the requester.
      // Do it in a separate task because Collabs does not allow message sends
      // while processing a message.
      // TODO: rate limit? consider case where everyone joins at once.
      setTimeout(() => {
        if (this.has(this.runtime.replicaID)) {
          const message = PresenceMessage.create({
            type: MessageType.Set,
            updates: this.updateSerializer.serialize(this.getOurs()!),
            forRequestAll: true,
          });
          super.sendPrimitive(PresenceMessage.encode(message).finish());
        }
      }, 0);
    }
  }

  private resetTimeout(replicaID: string): void {
    const timedValue = this.value.get(replicaID);
    if (timedValue === undefined) return;

    if (timedValue.timeoutID !== null) clearTimeout(timedValue.timeoutID);
    timedValue.timeoutID = setTimeout(
      () => this.deleteLocally(replicaID),
      this.ttlMS
    );
  }

  /**
   * Deletes the key `replicaID` in our *local* copy of the map, without
   * affecting other replicas. TODO: only until next set/update.
   *
   * You may wish to call this method when you know that a replica has disconnected,
   * instead of waiting for its current value to expire.
   * In particular, you may wish to call this method for every `replicaID` in [[keys]]
   * if you know that the local device has gone offline, to show the local user
   * that they are no longer collaborating live.
   */
  deleteLocally(replicaID: string): void {
    if (!this.has(replicaID)) return;

    const meta: UpdateMeta = {
      updateType: "message",
      senderID: replicaID,
      isLocalOp: false,
      runtimeExtra: undefined,
    };

    const timedValue = this.value.get(replicaID)!;
    if (timedValue.timeoutID !== null) clearTimeout(timedValue.timeoutID);
    timedValue.timeoutID = null;
    timedValue.present = false;

    this.emit("Delete", {
      key: replicaID,
      value: timedValue.value,
      meta,
    });
  }

  /**
   * Returns the value associated to key `replicaID`, or undefined if
   * `replicaID` is not present.
   */
  get(replicaID: string): V | undefined {
    if (this.has(replicaID)) return this.value.get(replicaID)!.value;
    else return undefined;
  }

  /**
   * Returns our value, i.e., the value at key [[IRuntime.replicaID]].
   */
  getOurs(): V | undefined {
    return this.get(this.runtime.replicaID);
  }

  /**
   * Returns whether key `replicaID` is present in the map.
   */
  has(replicaID: string): boolean {
    return this.value.get(replicaID)?.present ?? false;
  }

  /**
   * The number of present keys in the map.
   */
  get size(): number {
    return this._size;
  }

  /**
   * Returns an iterator for entries in the map.
   *
   * The iteration order is NOT eventually consistent:
   * it may differ on replicas with the same value.
   */
  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.entries();
  }

  /**
   * Returns an iterator of key (replicaID), value pairs for every entry in the map.
   *
   * The iteration order is NOT eventually consistent:
   * it may differ on replicas with the same value.
   */
  *entries(): IterableIterator<[string, V]> {
    for (const [key, timedValue] of this.value) {
      if (timedValue.present) yield [key, timedValue.value];
    }
  }

  /**
   * Returns an iterator for keys (replicaIDs) in the map.
   *
   * The iteration order is NOT eventually consistent:
   * it may differ on replicas with the same value.
   */
  *keys(): IterableIterator<string> {
    for (const [key] of this.entries()) yield key;
  }

  /**
   * Returns an iterator for states in the map.
   *
   * The iteration order is NOT eventually consistent:
   * it may differ on replicas with the same value.
   */
  *values(): IterableIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }

  /**
   * Executes a provided function once for each (key, value) pair in
   * the map, in the same order as [[entries]].
   *
   * @param callbackfn Function to execute for each key.
   * Its arguments are the value, key, and this map.
   * @param thisArg Value to use as `this` when executing `callbackfn`.
   */
  forEach(
    callbackfn: (value: V, key: string, map: this) => void,
    thisArg?: any //eslint-disable-line @typescript-eslint/no-explicit-any
  ): void {
    // Not sure if this gives the exact same semantics
    // as Map if callbackfn modifies this during the
    // loop.  (Given that Array.forEach has a rather
    // funky polyfill on MDN, I expect Map.forEach is
    // similarly funky.)  Although users probably shouldn't
    // be doing that anyway.
    for (const [key, value] of this) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  protected savePrimitive(): Uint8Array {
    // No saved value.
    return new Uint8Array();
  }

  protected loadPrimitive(
    _savedState: Uint8Array | null,
    _meta: UpdateMeta
  ): void {
    // No saved value.
  }
}
