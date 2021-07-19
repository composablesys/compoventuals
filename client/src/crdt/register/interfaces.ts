import { Crdt, CrdtEventsRecord } from "../core";

/**
 * An opaque register of type T.  Any semantics can
 * be used to resolve conflicts between concurrent writes.
 *
 * The value is set using the set method.
 * This method inputs SetArgs and sends them to every
 * replica in serialized form; every replica then uses
 * them to contruct the actual added value of type T,
 * e.g., using a user-supplied callback in the constructor.
 *
 * There are no CRegister-specific events; instead, listen
 * on the generic Change event and use this.value to read
 * the changed value, if needed.
 */
export interface CRegister<
  T,
  SetArgs extends any[],
  Events extends CrdtEventsRecord = CrdtEventsRecord
> extends Crdt<Events> {
  /**
   * Sends args to every replica in serialized form.
   * Every replica then uses
   * them to contruct the actual set value of type T.
   */
  set(...args: SetArgs): void;

  /**
   * Returns the current value.
   */
  get(): T;

  /**
   * this.value is an alias for this.get().
   *
   * Implementations in which set takes the actual set
   * value of type T (i.e., SetArgs = [T]) should make
   * value writable, so that this.value = x is an alias
   * for this.set(x).
   */
  readonly value: T;
}
