import {
  AbstractList_CObject,
  CObject,
  Collab,
  CollabEvent,
  DefaultSerializer,
  InitToken,
  isRuntime,
  ListEvent,
  ListEventsRecord,
  nonNull,
  PairSerializer,
  Position,
  Serializer,
  StringSerializer,
} from "@collabs/core";
import { CBoolean } from "../boolean";
import { CSet } from "../set";
import { CVar } from "../var";
import { CPositionSource } from "./c_position_source";
import { LocalList } from "./local_list";

/**
 * Event emitted by a [[CList]]`<C>`
 * when a range of values is moved.
 */
export interface ListMoveEvent<C> extends CollabEvent {
  index: number;
  previousIndex: number;
  values: C[];
  previousPositions: Position[];
  positions: Position[];
}

/**
 * Events record for [[CList]]`<C>`.
 */
export interface ListExtendedEventsRecord<C> extends ListEventsRecord<C> {
  Insert: ListEvent<C> & { method: "insert" | "restore" };
  Delete: ListEvent<C> & { method: "delete" | "archive" };
  /**
   * Emitted when a range of values is moved.
   */
  Move: ListMoveEvent<C>;
}

class CListEntry<C extends Collab> extends CObject {
  readonly value: C;
  readonly position: CVar<Position>;
  // OPT: Store presence together with position in a CValueMap, or in a
  // CValueSet for the whole list, to reduce memory usage.
  /** Used by archive/restore. delete() really deletes elements. */
  readonly present: CBoolean;

  constructor(
    init: InitToken,
    valueCallback: (valueInit: InitToken) => C,
    initialPosition: Position
  ) {
    super(init);
    this.value = super.registerCollab("", valueCallback);
    this.position = super.registerCollab(
      "0",
      (init) => new CVar(init, initialPosition)
    );
    // Restore-wins, with initial value "present".
    this.present = super.registerCollab(
      "1",
      (init) => new CBoolean(init, { initialValue: true, winner: true })
    );
  }
}

/**
 * A collaborative list with *mutable*
 * values of type C.
 *
 * Values are internally mutable.
 * Specifically, each value is its own [[Collab]], and
 * operations on that Collab are collaborative as usual.
 *
 * `CList<C>` has a similar API to `Array<C>`,
 * but it is mutated more like a linked list: instead of mutating
 * existing values, you [[insert]] and [[delete]]
 * list entries. Insertions and deletions
 * shift later entries, changing their indices, like
 * in collaborative text editing or
 * [Array.splice](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/splice).
 *
 * To insert values, you use the pattern described in
 * [dynamically-created Collabs](../../../guide/initialization.html#dynamically-created-collabs):
 * one user calls [[insert]] with `InsertArgs`; each
 * replica passes those `InsertArgs` to its
 * `valueConstructor`;
 * and `valueConstructor` returns the local copy of the new value Collab.
 *
 * When a value is deleted with [[delete]], it is deleted permanently and
 * can no longer be used; future and concurrent operations on that value
 * are ignored. Alternately, use [[archive]] and [[restore]].
 *
 * It is *not* safe to modify a CList while iterating over it. The iterator
 * will attempt to throw an exception if it detects such modification,
 * but this is not guaranteed.
 *
 * See also: [[CValueList]], [[CText]], [[CRichText]].
 *
 * @typeParam C The value type, which is a Collab.
 * @typeParam InsertArgs The type of arguments to [[insert]].
 */
export class CList<
  C extends Collab,
  InsertArgs extends unknown[]
> extends AbstractList_CObject<C, InsertArgs, ListExtendedEventsRecord<C>> {
  private readonly set: CSet<CListEntry<C>, [Position, InsertArgs]>;
  private readonly positionSource: CPositionSource;

  private readonly list: LocalList<C>;

  /**
   * Constructs a CList with the given `valueConstructor`.
   *
   * @param valueConstructor Callback used to construct a
   * value Collab with the given [[InitToken]] and arguments to [[insert]]. See [dynamically-created Collabs](../../../guide/initialization.html#dynamically-created-collabs)
   * for example usage.
   * @param options.argsSerializer A serializer for `InsertArgs` as an array.
   * Defaults to [[DefaultSerializer]].
   */
  constructor(
    init: InitToken,
    private readonly valueConstructor: (
      valueInit: InitToken,
      ...args: InsertArgs
    ) => C,
    options: { argsSerializer?: Serializer<InsertArgs> } = {}
  ) {
    super(init);

    const argsSerializer =
      options.argsSerializer ?? DefaultSerializer.getInstance();

    // Register positionSource first so that it is loaded first.
    // (We could also ensure that by overriding CObject.load.)
    // Otherwise, set's events during load will reference positions that
    // haven't been loaded yet.
    this.positionSource = this.registerCollab(
      "0",
      (init) => new CPositionSource(init)
    );
    this.set = this.registerCollab(
      "",
      (init) =>
        new CSet(init, this.entryConstructor.bind(this), {
          argsSerializer: new PairSerializer(
            StringSerializer.instance,
            argsSerializer
          ),
        })
    );

    this.list = new LocalList(this.positionSource);

    // Maintain positionSource's values as a cache of
    // of the currently set locations, mapping to
    // the corresponding entry.
    // Also dispatch our own events.
    this.set.on("Add", (event) => {
      const position = event.value.position.value;
      this.list.set(position, event.value.value);
      this.emit("Insert", {
        index: this.list.indexOfPosition(position),
        values: [event.value.value],
        positions: [position],
        method: "insert",
        meta: event.meta,
      });
    });
    this.set.on("Delete", (event) => {
      if (event.value.present.value) {
        const position = event.value.position.value;
        const index = this.list.indexOfPosition(position);
        this.list.delete(position);
        this.emit("Delete", {
          index,
          values: [event.value.value],
          positions: [position],
          method: "delete",
          meta: event.meta,
        });
      }
      // else archived -> deleted; no new event.
      // A value that needs to know when this happens can override Collab.finalize.
    });
  }

  private entryConstructor(
    entryInit: InitToken,
    initialPosition: Position,
    args: InsertArgs
  ) {
    const entry = new CListEntry<C>(
      entryInit,
      (valueInit) => this.valueConstructor(valueInit, ...args),
      initialPosition
    );
    // Maintain positionSource's values as a cache of
    // of the currently set locations, mapping to
    // the corresponding entry.
    // Also dispatch our own events.
    // Note that for the initial position, this is done
    // in set's Add event listener, not here.
    // Also note that entry is always non-deleted, since
    // restore() skips deleted values.
    // OPT: avoid creating closures for each entry here?
    entry.position.on("Set", (event) => {
      // Handle move ops.
      // Note that we only do this when the value is present (not archived).
      if (entry.present.value) {
        const previousIndex = this.list.indexOfPosition(event.previousValue);
        this.list.delete(event.previousValue);
        this.list.set(event.value, entry.value);
        this.emit("Move", {
          index: this.list.indexOfPosition(event.value),
          previousIndex,
          values: [entry.value],
          previousPositions: [event.previousValue],
          positions: [event.value],
          meta: event.meta,
        });
      }
    });
    entry.present.on("Set", (event) => {
      const position = entry.position.value;
      // Here we rely on the fact that CBoolean only emits events when
      // the value actually changes.
      if (event.value) {
        // entry was un-archived.
        this.list.set(position, entry.value);
        this.emit("Insert", {
          index: this.list.indexOfPosition(position),
          values: [entry.value],
          positions: [position],
          method: "restore",
          meta: event.meta,
        });
      } else {
        // entry was archived.
        const index = this.list.indexOfPosition(position);
        this.list.delete(position);
        this.emit("Delete", {
          index,
          values: [entry.value],
          positions: [position],
          method: "archive",
          meta: event.meta,
        });
      }
    });
    return entry;
  }

  private entryFromValue(value: C): CListEntry<C> | null {
    // Avoid errors from searchElement.parent in case it
    // is the root.
    if (isRuntime(value.parent)) return null;
    return value.parent as CListEntry<C>;
  }

  /**
   * Inserts a value at the given index using args.
   *
   * All values currently at or after `index` shift
   * to the right, incrementing their indices.
   *
   * The args are broadcast to all replicas in serialized form.
   * Every replica then passes them to `valueConstructor` to construct the actual
   * value of type C, a new Collab that is collaborative as usual.
   *
   * @param index The insertion index in the range
   * `[0, this.length]`. If `this.length`, the value
   * is appended to the end of the list.
   * @return The inserted value, or undefined if it is not
   * constructed immediately.
   * @throws If index is not in `[0, this.length]`.
   */
  insert(index: number, ...args: InsertArgs): C {
    const prevPos = index === 0 ? null : this.list.getPosition(index - 1);
    const position = this.positionSource.createPositions(prevPos, 1)[0];
    return this.set.add(position, args).value;
  }

  /**
   * Delete `count` values starting at `index`, i.e., values
   * `[index, index + count - 1)`.
   *
   * All later values shift to the left,
   * decreasing their indices by `count`.
   *
   * The values are deleted permanently and
   * can no longer be used; future and concurrent operations on those values
   * are ignored. Local operations will succeed but will not affect
   * remote replicas. The values can perform cleanup in their
   * [[Collab.finalize]] methods.
   *
   * See also: [[archive]], [[CSet.delete]].
   */
  delete(index: number, count = 1): void {
    if (count < 0 || !Number.isInteger(count)) {
      throw new Error(`invalid count: ${count}`);
    }
    // Get the values to delete.
    const toDelete = this.list.slice(index, index + count);
    toDelete.reverse();
    // Delete them.
    for (const value of toDelete) {
      this.set.delete(nonNull(this.entryFromValue(value)));
    }
  }

  /**
   * Archives `count` values starting at `index`, i.e., values
   * `[index, index + count - 1)`.
   *
   * All later values shift to the left,
   * decreasing their indices by `count`.
   *
   * Unlike [[delete]], archived merely marks values as not present.
   * Archived values can still perform collaborative operations,
   * and they can be made present again with [[restore]].
   *
   * @param count The number of values to archive.
   * Defaults to 1 (archive the value at `index` only).
   *
   * @throws if `index < 0` or
   * `index + count >= this.length`.
   */
  archive(index: number, count = 1): void {
    if (count < 0 || !Number.isInteger(count)) {
      throw new Error(`invalid count: ${count}`);
    }
    // Get the values to archive.
    const toArchive = this.list.slice(index, index + count);
    toArchive.reverse();
    // Archive them. Note the entry.position will "remember" the current
    // position (and concurrent moves) for when we are restored.
    for (const value of toArchive) {
      const entry = nonNull(this.entryFromValue(value));
      entry.present.value = false;
    }
  }

  /**
   * Restores the given value, marking it as present in the list.
   *
   * The value re-appears at its previous position, unless
   * moved by [[move]].
   * All values after that position shift to the right,
   * incrementing their indices.
   *
   * In case of concurrent restore and [[archive]] operations, the restore
   * wins. If the value is deleted (not just archived), this
   * method has no effect.
   *
   * One usage pattern is to call restore on a value each time you
   * mutate that value. That way, if one user archives a value while
   * it is still in use by another user, the archive will be canceled.
   */
  restore(value: C): void {
    const entry = this.entryFromValue(value);
    if (entry === null || !this.set.has(entry)) {
      // Already deleted, or invalid.
      return;
    }
    // For "keepalive" behavior (restore on every op), here we rely
    // on the fact that CBoolean performs this set op even if it's redundant
    // (already present).
    entry.present.value = true;
  }

  /**
   * Moves `count` values from `index` to `insertionIndex`.
   *
   * That is, the range of values at `[index, index + count - 1)` is moved to the position
   * *currently* at `insertionIndex`.
   *
   * Other values shift to accommodate the move.
   *
   * Collaborative operations on the values continue to work
   * normally, even if concurrent to the move.
   *
   * @param count The number of values to move.
   * Defaults to 1 (move the value at `index` only).
   * @returns The new index of the first moved value.
   * This will be less then `insertionIndex` if `index < insertionIndex`.
   * @throws if `index < 0` or
   * `index + count >= this.length`.
   */
  move(index: number, insertionIndex: number, count = 1): number {
    if (count < 0 || !Number.isInteger(count)) {
      throw new Error(`invalid count: ${count}`);
    }
    if (count === 0) return insertionIndex;

    // Positions to insert at.
    const prevPos =
      insertionIndex === 0 ? null : this.list.getPosition(insertionIndex - 1);
    const positions = this.positionSource.createPositions(prevPos, count);
    // Values to move.
    const toMove = this.list.slice(index, index + count);
    // Move them.
    for (let i = 0; i < count; i++) {
      const entry = nonNull(this.entryFromValue(toMove[i]));
      entry.position.value = positions[i];
    }
    // Return the new index of toMove[0].
    return this.list.indexOfPosition(positions[0]);
  }

  get(index: number): C {
    return this.list.get(index);
  }

  values(): IterableIterator<C> {
    return this.list.values();
  }

  get length(): number {
    return this.list.length;
  }

  /**
   * Inserts a value at the end of the list using args.  Equivalent to
   * `this.insert(this.length, ...args)`.
   *
   * @return The inserted value.
   */
  push(...args: InsertArgs): C {
    return this.insert(this.length, ...args);
  }

  /**
   * Inserts a value at the start of the list using args.  Equivalent to
   * `this.insert(0, ...args)`.
   *
   * @return The inserted value.
   */
  unshift(...args: InsertArgs): C {
    return this.insert(0, ...args);
  }

  slice(start?: number, end?: number): C[] {
    return this.list.slice(start, end);
  }

  getPosition(index: number): Position {
    return this.list.getPosition(index);
  }

  indexOfPosition(
    position: Position,
    searchDir: "none" | "left" | "right" = "none"
  ): number {
    return this.list.indexOfPosition(position, searchDir);
  }

  hasPosition(position: Position): boolean {
    return this.list.hasPosition(position);
  }

  getByPosition(position: Position): C | undefined {
    return this.list.getByPosition(position);
  }

  /**
   * Returns an iterator of [index, position, value] tuples for every
   * value in the list, in list order.
   *
   * Note: If you [[move]] list elements, you should not use `position`
   * as a React key, since a value's position changes when it moves.
   * Instead, [use the object itself as the key](https://stackoverflow.com/questions/31394774/reactjs-using-object-ref-as-key).
   */
  entries(): IterableIterator<[index: number, position: Position, value: C]> {
    return this.list.entries();
  }

  /**
   * Returns a new instance of [[LocalList]] that uses this
   * CList's [[Position]]s, initially empty.
   *
   * Changes to the returned LocalList's values
   * do not affect this CList's values, and vice-versa.
   * However, the set of allowed positions does increase to
   * match this CList: you may use a CList position in
   * the returned LocalList even if that position was created
   * after the call to `newLocalList`.
   *
   * @typeParam U The value type of the returned list.
   * Defaults to C.
   */
  newLocalList<U = C>(): LocalList<U> {
    return new LocalList(this.positionSource);
  }

  indexOf(searchElement: C, fromIndex = 0): number {
    // Override AbstractList's implementation to use entryFromValue (O(1) time)
    // instead of a linear search.
    const entry = this.entryFromValue(searchElement);
    if (entry !== null && this.set.has(entry) && entry.present.value) {
      const index = this.list.indexOfPosition(entry.position.value);
      if (fromIndex < 0) fromIndex += this.length;
      if (index >= fromIndex) return index;
    }
    return -1;
  }

  positionOf(searchElement: C): Position | undefined {
    const entry = this.entryFromValue(searchElement);
    if (entry !== null && this.set.has(entry) && entry.present.value) {
      return entry.position.value;
    }
    return undefined;
  }
}
