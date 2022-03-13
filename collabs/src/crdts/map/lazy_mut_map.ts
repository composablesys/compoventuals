import {
  bytesAsString,
  DefaultSerializer,
  Optional,
  Serializer,
  stringAsBytes,
  WeakValueMap,
} from "../../util";
import {
  Collab,
  CollabEventsRecord,
  ICollabParent,
  InitToken,
  MessageMeta,
  Message,
} from "../../core";
import { LazyMutCMapSave } from "../../../generated/proto_compiled";
import { AbstractCMapCollab } from "../../data_types";

/**
 * A CMap of mutable values where every key is
 * implicitly always present, although only nontrivial
 * values are actually stored in memory.
 *
 * Alternatively, you can think of this like a [[CObject]]
 * with one property/child per key (potentially infinitely
 * many).
 *
 * The "always exists" nature means that, unlike in
 * [[DeletingMutCMap]] and [[ArchivingMutCMap]], there
 * is no conflict when two users concurrently "create"
 * values with the same key. Instead, they are just accessing
 * the same value. If they perform operations on that
 * value concurrently, then those operations will all
 * apply to the value, effectively merging their changes.
 *
 * The name "LazyMap" references the [Apache Commons
 * LazyMap](https://commons.apache.org/proper/commons-collections/apidocs/org/apache/commons/collections4/map/LazyMap.html).
 * That map likewise creates values on demand using a
 * factory method, to give the impression that all
 * keys are always present.
 *
 * For the
 * purpose of the iterators and has, a key is considered
 * to be present in the map if its value is nontrivial,
 * specifically, if value.canGC() returns false.
 * Note that this implies that a just-added key may
 * not be present in the map.  This unusual semantics
 * is necessary because the map does not necessarily
 * maintain all elements internally, only the nontrivial
 * ones, and so the iterators are unable to consistently return
 * all trivial elements.
 *
 * delete and clear throw errors (grow-only semantics).
 * set has no effect, just
 * returning a value by calling get.
 */
export class LazyMutCMap<K, C extends Collab>
  extends AbstractCMapCollab<K, C, []>
  implements ICollabParent
{
  private readonly nontrivialMap: Map<string, C> = new Map();
  private readonly trivialMap: WeakValueMap<string, C> = new WeakValueMap();
  /**
   * @param valueConstructor A function used to initialize
   * values when initKey() or getForce() is called on
   * their key.  The Collab must have given the parent and id.
   * In the simplest usage, this function just calls C's
   * constructor with the given parent and id, and default
   * values otherwise (independent of key).
   * If desired,
   * the result can instead depend on key (e.g., using
   * varying subclasses of C, or performing local operations
   * to drive the Collab to a desired state depending on K).
   * However, the result must be identical on all replicas,
   * even if they are in different global states.  The
   * easiest way to ensure this is to have the result be
   * a function of the given arguments only.
   */
  constructor(
    initToken: InitToken,
    private readonly valueConstructor: (valueInitToken: InitToken, key: K) => C,
    private readonly keySerializer: Serializer<K> = DefaultSerializer.getInstance()
  ) {
    super(initToken);
  }

  private keyAsString(key: K) {
    return bytesAsString(this.keySerializer.serialize(key));
  }
  private stringAsKey(str: string) {
    return this.keySerializer.deserialize(stringAsBytes(str));
  }

  private getInternal(
    key: K,
    keyString: string,
    inLoad: boolean
  ): [value: C, nontrivial: boolean] {
    let value = this.nontrivialMap.get(keyString);
    if (value === undefined) {
      // Check the backup map
      value = this.trivialMap.get(keyString);
      if (value === undefined) {
        // Create it, but only in the backup map,
        // since it is currently GC-able
        value = this.valueConstructor(new InitToken(keyString, this), key);

        if (inLoad) {
          // We are in this.load.
          // So, value.load will be called by this.load
          // right after the value is returned;
          // we don't need to do it here.
          // Also, we can assume value will be nontrivial once
          // it is recursively loaded, since save only
          // returns the nontrivial children.
          this.nontrivialMap.set(keyString, value);
        } else {
          // We assume that [[load]] has already finished, since this
          // isn't supposed to be used (e.g. calling [[get]]) until then.
          // Thus this value will never be loaded directly (by [[load]]), so
          // we need to indicate that loading was skipped.
          value.load(Optional.empty());
          // The value starts trivial; if it becomes nontrivial
          // due to a message, receive will move
          // it to nontrivialMap.
          this.trivialMap.set(keyString, value);
        }

        return [value, false];
      }
      return [value, false];
    } else return [value, true];
  }

  childSend(child: Collab<CollabEventsRecord>, messagePath: Message[]): void {
    if (child.parent !== this) {
      throw new Error(`childSend called by non-child: ${child}`);
    }

    messagePath.push(child.name);
    this.send(messagePath);
  }

  /**
   * No added context.
   *
   * @return undefined
   */
  getAddedContext(_key: symbol): unknown {
    return undefined;
  }

  private inReceiveKeyStr?: string = undefined;
  private inReceiveValue?: C = undefined;

  receive(messagePath: Message[], meta: MessageMeta): void {
    const keyString = <string>messagePath[messagePath.length - 1];
    this.inReceiveKeyStr = keyString;
    try {
      // Message for a child
      const key = this.stringAsKey(keyString);
      const [value, nontrivialStart] = this.getInternal(key, keyString, false);
      this.inReceiveValue = value;

      messagePath.length--;
      value.receive(messagePath, meta);

      // If the value became GC-able, move it to the
      // backup map
      if (nontrivialStart && value.canGC()) {
        this.nontrivialMap.delete(keyString);
        this.trivialMap.set(keyString, value);
        this.emit("Delete", {
          key,
          deletedValue: value,
          meta,
        });
      }
      // If the value became nontrivial, move it to the
      // main map
      else if (!nontrivialStart && !value.canGC()) {
        this.trivialMap.delete(keyString);
        this.nontrivialMap.set(keyString, value);
        this.emit("Set", {
          key,
          // Empty to emphasize that the previous value was
          // not present.
          previousValue: Optional.empty<C>(),
          meta,
        });
        // We won't dispatch Set events when the value
        // is not new because there can only ever be one
        // value at a given key, due to Merging semantics.
        // An exception is replacement due to GC-ing, but
        // we consider such values "the same"; if users care
        // about the distinction (e.g. because they need
        // to register event handlers), they should do so
        // in valueConstructor, not on Set events.
      }
    } finally {
      this.inReceiveKeyStr = undefined;
      this.inReceiveValue = undefined;
    }
  }

  set(key: K): C {
    // No-op, just return the value
    return this.get(key);
  }

  /**
   * Unsupported (throws error).
   */
  delete(_key: K): void {
    throw new Error("Unsupported operation: delete");
  }

  /**
   * Unsupported (throws error).
   */
  clear(): void {
    throw new Error("Unsupported operation: delete");
  }

  /**
   * Note: returns the value even if has = false, so
   * that it's possible to get it, and so that common
   * get! idioms work.  getIfPresent does the usual
   * get semantics.
   * @param  key [description]
   * @return     [description]
   */
  get(key: K): C {
    return this.getInternal(key, this.keyAsString(key), false)[0];
  }

  getIfPresent(key: K): C | undefined {
    const str = this.keyAsString(key);
    if (this.inReceiveKeyStr === str) {
      // The state of nontrivialMap cannot be relied
      // upon, since it hasn't been recalculated yet.
      // Instead, use canGC directly.
      if (!this.inReceiveValue!.canGC()) {
        return this.inReceiveValue!;
      } else return undefined;
    }
    return this.nontrivialMap.get(this.keyAsString(key));
  }

  has(key: K): boolean {
    const str = this.keyAsString(key);
    if (this.inReceiveKeyStr === str) {
      // The state of nontrivialMap cannot be relied
      // upon, since it hasn't been recalculated yet.
      // Instead, use canGC directly.
      return !this.inReceiveValue!.canGC();
    } else return this.nontrivialMap.has(str);
  }

  hasValue(value: C): boolean {
    return this.owns(value) && !value.canGC();
  }

  /**
   * Returns true if value is owned by this
   * map, i.e., it is an output of this.get.
   */
  owns(value: C): boolean {
    return value.parent === this;
  }

  get size(): number {
    return this.nontrivialMap.size;
  }

  *entries(): IterableIterator<[K, C]> {
    for (const [keyStr, value] of this.nontrivialMap) {
      yield [this.stringAsKey(keyStr), value];
    }
  }

  values(): IterableIterator<C> {
    // Override for efficiency
    return this.nontrivialMap.values();
  }

  /**
   * Returns the unique key associated to a value owned
   * by this map. If
   * the value is not owned by this map, returns undefined.
   *
   * @param searchElement The value to locate in this map.
   */
  keyOf(searchElement: C): K | undefined {
    if (!this.owns(searchElement)) return undefined;
    return this.stringAsKey(searchElement.name);
  }

  save(): Uint8Array {
    const childSaves: { [name: string]: Uint8Array } = {};
    // Only need to save nontrivial children, since trivial
    // children are in their initial states.
    for (const [name, child] of this.nontrivialMap) {
      childSaves[name] = child.save();
    }
    const saveMessage = LazyMutCMapSave.create({
      childSaves,
    });
    return LazyMutCMapSave.encode(saveMessage).finish();
  }

  load(saveData: Optional<Uint8Array>): void {
    if (!saveData.isPresent) {
      // No children to notify.
      return;
    }

    const saveMessage = LazyMutCMapSave.decode(saveData.get());
    for (const [name, childSave] of Object.entries(saveMessage.childSaves)) {
      const child = this.getInternal(this.stringAsKey(name), name, true)[0];
      child.load(Optional.of(childSave));
    }
  }

  getDescendant(namePath: string[]): Collab | undefined {
    if (namePath.length === 0) return this;

    const name = namePath[namePath.length - 1];
    const child = this.getInternal(this.stringAsKey(name), name, false)[0];
    namePath.length--;
    return child.getDescendant(namePath);
  }

  canGC() {
    /*
     * We don't need to check here that the backup
     * map is nonempty (which would be expensive):
     * each value points to us (due to Collab.parent),
     * so we will only be forgotten by a containing
     * implicit map if all of our children have no
     * references to them, which is equivalent to the
     * backup map being empty(able).
     */
    return this.nontrivialMap.size === 0;
  }
}
