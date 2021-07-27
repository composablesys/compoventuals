import {
  byteArrayEquals,
  DefaultElementSerializer,
  ElementSerializer,
} from "../../util";
import { Resettable } from "../helper_crdts";
import {
  CRegisterEntryMeta,
  LwwCRegister,
  OptionalCRegister,
} from "../register";
import { AbstractCMapCompositeCrdt } from "./abstract_map";
import { ImplicitMutCMap } from "./implicit_mut_map";
import { CMapEventsRecord } from "./interfaces";

export class CMapFromRegister<
    K,
    V,
    SetArgs extends any[],
    R extends OptionalCRegister<V, SetArgs> & Resettable
  >
  extends AbstractCMapCompositeCrdt<K, V, SetArgs, CMapEventsRecord<K, V>>
  implements Resettable
{
  protected readonly internalMap: ImplicitMutCMap<K, R>;

  constructor(
    private readonly registerConstructor: (key: K) => R,
    keySerializer: ElementSerializer<K> = DefaultElementSerializer.getInstance()
  ) {
    super();
    this.internalMap = this.addChild(
      "",
      new ImplicitMutCMap(
        this.internalRegisterConstructor.bind(this),
        keySerializer
      )
    );

    // Events emitters are added in internalRegisterConstructor.
  }

  private internalRegisterConstructor(key: K): R {
    const register = this.registerConstructor(key);
    register.on("OptionalSet", (event) => {
      if (register.optionalValue.isPresent) {
        // The value was set, not deleted.
        this.emit("Set", {
          key,
          previousValue: event.previousOptionalValue,
          timestamp: event.timestamp,
        });
      } else {
        // The value was deleted.
        this.emit("Delete", {
          key,
          deletedValue: event.previousValue,
          timestamp: event.timestamp,
        });
      }
    });
    return register;
  }

  set(key: K, ...args: SetArgs): V {
    const register = this.internalMap.get(key);
    register.set(...args);
    return register.value;
  }

  delete(key: K): void {
    const valueCrdt = this.internalMap.getIfPresent(key);
    if (valueCrdt !== undefined) {
      valueCrdt.reset();
    }
  }

  get(key: K): V | undefined {
    const register = this.internalMap.getIfPresent(key);
    return register === undefined ? undefined : register.value;
  }

  has(key: K): boolean {
    return this.internalMap.has(key);
  }

  get size(): number {
    return this.internalMap.size;
  }

  *entries(): IterableIterator<[K, V]> {
    for (let [key, valueCrdt] of this.internalMap) {
      yield [key, valueCrdt.value];
    }
  }

  // Use inherited keyOf with === comparisons.
  // In case SetArgs = [V], you should override keyOf
  // to use serialization equality.

  // Use inherited clear implementation.

  reset(): void {
    // Clear indeed has observed-reset semantics.
    this.clear();
  }
}

export class LwwCMap<K, V> extends CMapFromRegister<
  K,
  V,
  [V],
  LwwCRegister<V>
> {
  constructor(
    keySerializer: ElementSerializer<K> = DefaultElementSerializer.getInstance(),
    private readonly valueSerializer: ElementSerializer<V> = DefaultElementSerializer.getInstance()
  ) {
    super(
      () => new LwwCRegister({ error: true }, valueSerializer),
      keySerializer
    );
  }

  /**
   * Return the current conflicting values at key, i.e., the
   * non-overwritten values.  This may have
   * more than one element due to concurrent writes.
   * If key is not present, returns [].
   *
   * The array is guaranteed to contain
   * values in the same order on all replicas, namely,
   * in lexicographic order by sender.
   */
  getConflicts(key: K): V[] {
    const valueCrdt = this.internalMap.getIfPresent(key);
    return valueCrdt === undefined ? [] : valueCrdt.conflicts();
  }

  /**
   * Return the current conflicting values with metadata.
   * If key is not present, returns [].
   *
   * The array is guaranteed to contain
   * values in the same order on all replicas, namely,
   * in lexicographic order by sender.
   */
  getConflictsMeta(key: K): CRegisterEntryMeta<V>[] {
    const valueCrdt = this.internalMap.getIfPresent(key);
    return valueCrdt === undefined ? [] : valueCrdt.conflictsMeta();
  }

  /**
   * O(n), but uses serialization equality
   * instead of ===.
   */
  keyOf(searchElement: V): K | undefined {
    const searchSerialized = this.valueSerializer.serialize(searchElement);
    for (const [key, value] of this) {
      const valueSerialized = this.valueSerializer.serialize(value);
      if (byteArrayEquals(searchSerialized, valueSerialized)) return key;
    }
    return undefined;
  }
}
