import {
  CollabSerializer,
  DefaultSerializer,
  PairSerializer,
  Serializer,
} from "../../util";
import { Collab, InitToken, Pre } from "../../core";
import { CRegisterEntryMeta } from "../register";
import { AbstractCMapCObject, CMap, CSet } from "../../data_types";

export interface ConflictsCMap<K, C> extends CMap<K, C> {
  /**
   * Return the causally maximal concurrent values set
   * for key.
   */
  getConflicts(key: K): C[];

  /**
   * Return the causally maximal concurrent values set
   * for key, with metadata.
   */
  getConflictsMeta(key: K): CRegisterEntryMeta<C>[];
}

/**
 * The set is used as a source of Collabs for values.
 * Its `add` method must always return the new value
 * (not undefined).
 */
export class MutCMapFromSet<
  K,
  C extends Collab,
  SetArgs extends unknown[],
  SetT extends CSet<C, [K, SetArgs]>,
  MapT extends ConflictsCMap<K, C>
> extends AbstractCMapCObject<K, C, SetArgs> {
  protected readonly valueSet: SetT;
  protected readonly map: MapT;

  constructor(
    initToken: InitToken,
    setCallback: (
      setValueConstructor: (
        setValueInitToken: InitToken,
        key: K,
        args: SetArgs
      ) => C,
      setArgsSerializer: Serializer<[K, SetArgs]>
    ) => Pre<SetT>,
    mapCallback: (
      mapKeySerializer: Serializer<K>,
      mapValueSerializer: Serializer<C>
    ) => Pre<MapT>,
    valueConstructor: (
      valueInitToken: InitToken,
      key: K,
      ...args: SetArgs
    ) => C,
    keySerializer: Serializer<K> = DefaultSerializer.getInstance(
      initToken.runtime
    ),
    argsSerializer: Serializer<SetArgs> = DefaultSerializer.getInstance(
      initToken.runtime
    )
  ) {
    super(initToken);

    this.valueSet = this.addChild(
      "",
      setCallback((valueInitToken, key, args) => {
        return valueConstructor(valueInitToken, key, ...args);
      }, new PairSerializer(keySerializer, argsSerializer))
    );
    this.map = this.addChild(
      "0",
      mapCallback(keySerializer, new CollabSerializer(this.valueSet))
    );

    // Events
    // Note that for the state to be reasonable during
    // these event handlers, it is necessary that
    // operations always do the this.map operation last.
    this.map.on("Set", (event) => this.emit("Set", event));
    this.map.on("Delete", (event) => this.emit("Delete", event));
  }

  set(key: K, ...args: SetArgs): C {
    // Delete all existing values, so they don't become tombstones.
    for (const value of this.map.getConflicts(key)) {
      this.valueSet.delete(value);
    }
    // Set the new value
    const value = this.valueSet.add(key, args)!;
    this.map.set(key, value);
    return value;
  }

  delete(key: K): void {
    // Delete all existing values, so they don't become tombstones.
    for (const value of this.map.getConflicts(key)) {
      this.valueSet.delete(value);
    }
    // Delete in map
    this.map.delete(key);
  }

  get(key: K): C | undefined {
    return this.map.get(key);
  }

  getConflicts(key: K): C[] {
    return this.map.getConflicts(key);
  }

  getConflictsMeta(key: K): CRegisterEntryMeta<C>[] {
    return this.map.getConflictsMeta(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  entries(): IterableIterator<[K, C]> {
    return this.map.entries();
  }

  clear() {
    // This may someday be more efficient than deleting
    // every key.
    this.map.clear();
    this.valueSet.clear();
  }

  // Use inherited (O(n)) keyOf implementation.  If you
  // want this to run in O(1), you should use store WeakMap
  // from values to keys, set during valueConstructor.
}
