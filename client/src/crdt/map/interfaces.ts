import { Optional } from "../../util/optional";
import { Crdt, CrdtEvent, CrdtEventsRecord } from "../core";

export interface CMapEvent<K, V> extends CrdtEvent {
  key: K;
  /**
   * Present if there was value set previously (e.g.
   * for Delete, or for Set when there was already
   * a value set).
   */
  previousValue: Optional<V>;
}

export interface CMapEventsRecord<K, V> extends CrdtEventsRecord {
  /**
   * TODO: in MutCMap's, this is emitted not just
   * when the value is set (including if already
   * set and maybe changed) but also when
   * a previously-existing value's key is restored,
   * even if the value object remained the same.
   * It is NOT emitted each time the value mutates
   * internally (for that, add your own event listeners
   * in the valueConstructor).
   */
  Set: CMapEvent<K, V>;
  Delete: CMapEvent<K, V>;
}

/**
 * A map from keys K to values V, supporting set and
 * delete with any semantics.
 *
 * Initially, values must be created using the set method.
 * This method inputs SetArgs and sends them to every
 * replica in serialized form; every replica then uses
 * them to contruct the actual set value of type V,
 * e.g., using a user-supplied callback in the constructor.
 * Set keys can later be deleted (and in some implementations,
 * restored), changing
 * their presence in the map, using any semantics to
 * resolve conflicts.
 */
export interface CMap<
  K,
  V,
  SetArgs extends any[] = [V],
  Events extends CMapEventsRecord<K, V> = CMapEventsRecord<K, V>
> extends Crdt<Events> {
  /**
   * Sends args to every replica in serialized form.
   * Every replica then uses
   * them to contruct the actual set value of type V,
   * which is set as the value at key.
   *
   * @return the set value
   */
  set(key: K, ...args: SetArgs): V;

  /**
   * Deletes the given key, making it no longer present
   * in this map.
   */
  delete(key: K): void;

  /**
   * Returns the value associated to key, or undefined if
   * key is not present.
   */
  get(key: K): V | undefined;

  /**
   * Returns whether key is present in the map.
   */
  has(key: K): boolean;

  /**
   * Deletes every key in this map.
   */
  clear(): void;

  readonly size: number;

  forEach(
    callbackfn: (value: V, key: K, map: this) => void,
    thisArg?: any
  ): void;

  /**
   * Returns an iterable of entries in the map.
   *
   * The
   * iteration order is NOT eventually consistent, i.e.,
   * it may differ on replicas with the same state.
   */
  [Symbol.iterator](): IterableIterator<[K, V]>;

  /**
   * Returns an iterable of key, value pairs for every entry in the map.
   *
   * The
   * iteration order is NOT eventually consistent, i.e.,
   * it may differ on replicas with the same state.
   */
  entries(): IterableIterator<[K, V]>;

  /**
   * Returns an iterable of keys in the map.
   *
   * The
   * iteration order is NOT eventually consistent, i.e.,
   * it may differ on replicas with the same state.
   */
  keys(): IterableIterator<K>;

  /**
   * Returns an iterable of values in the map.
   *
   * The iteration order is NOT eventually consistent, i.e.,
   * it may differ on replicas with the same state.
   */
  values(): IterableIterator<V>;

  /**
   * Returns the key of some occurrence of a value in this map, or undefined if the value is not present.
   * The equality semantics for comparing values is
   * implementation-dependent.
   *
   * @param searchElement The value to locate in this map.
   */
  keyOf(searchElement: V): K | undefined;
}
