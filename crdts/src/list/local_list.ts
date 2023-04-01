import { Position, Serializer } from "@collabs/core";
import { LocalListSave } from "../../generated/proto_compiled";
import {
  CPositionSource,
  PositionSourceCreateEvent,
  Waypoint,
} from "./c_position_source";

/**
 * Info about a waypoint's values within a LocalList.
 */
interface WaypointInfo<T> {
  /**
   * The total number of present values at this
   * waypoint and its descendants.
   */
  total: number;
  /**
   * The values (or not) at the waypoint's positions,
   * in order from left to right, represented as
   * an array of "items": T[] for present values,
   * positive count for deleted values.
   *
   * The items always alternate types. If the last
   * item would be a number (deleted), it is omitted,
   * so their lengths may sum to less than the waypoint's
   * valueCount.
   */
  items: (T[] | number)[];
}

/**
 * Type used in LocalList.valuesAndChildren.
 */
type ValuesOrChild<T> =
  | {
      /** True if value, false if child. */
      isValues: true;
      /** Use item.slice(start, end) */
      item: T[];
      start: number;
      end: number;
      /** valueIndex of first value */
      valueIndex: number;
    }
  | {
      /** True if value, false if child. */
      isValues: false;
      child: Waypoint;
      /** Always non-zero (zero total children are skipped). */
      total: number;
    };

/**
 * A local (non-collaborative) data structure mapping [[Position]]s to
 * values, in list order.
 *
 * You can use a LocalList to maintain a sorted, indexable view of a
 * [[CValueList]], [[CList]], or [[CText]]'s values.
 * For example, when using a [[CList]],
 * you could store its archived values in a LocalList.
 * That would let you iterate over the archived values in list order.
 * <!-- TODO: example in docs; or, provide convenience function to
 * return the archived LocalList? -->
 *
 * To construct a LocalList that uses an existing list's positions, use
 * that list's `newLocalList` function, e.g., [[CList.newLocalList]].
 *
 * @typeParam T The value type.
 */
export class LocalList<T> {
  /**
   * Only includes nontrivial entries (total > 0).
   */
  private valuesByWaypoint = new Map<Waypoint, WaypointInfo<T>>();
  private _inInitialState = true;

  /**
   * Constructs a LocalList whose allowed [[Position]]s are given by
   * `source`.
   *
   * This is a low-level API intended for internal use by list CRDT implementations.
   * To construct a LocalList that uses an existing list's positions, use
   * that list's `newLocalList` function, e.g., [[CList.newLocalList]].
   *
   * Using positions that were not generated by `source` (or a replica of
   * `source`) will cause undefined behavior.
   *
   * @param source The source for positions that may be used with this
   * LocalList.
   */
  constructor(private readonly source: CPositionSource) {}

  /**
   * Sets the value at position.
   */
  set(position: Position, value: T): void {
    this._inInitialState = false;

    const [waypoint, valueIndex] = this.source.decode(position);
    const info = this.valuesByWaypoint.get(waypoint);
    if (info === undefined) {
      // Waypoint has no values currently; set them to
      // [valueIndex, [value]].
      // Except, omit 0s.
      const newItems = valueIndex === 0 ? [[value]] : [valueIndex, [value]];
      this.valuesByWaypoint.set(waypoint, {
        total: 0,
        items: newItems,
      });
      this.updateTotals(waypoint, 1);
      return;
    }

    const items = info.items;
    let remaining = valueIndex;
    for (let i = 0; i < items.length; i++) {
      const curItem = items[i];
      if (typeof curItem !== "number") {
        if (remaining < curItem.length) {
          // Already present. Replace the current value.
          curItem[remaining] = value;
          return;
        } else remaining -= curItem.length;
      } else {
        if (remaining < curItem) {
          // Replace curItem with
          // [remaining, [value], curItem - 1 - remaining].
          // Except, omit 0s and combine [value] with
          // neighboring arrays if needed.
          let startIndex = i;
          let deleteCount = 1;
          const newItems: (T[] | number)[] = [[value]];

          if (remaining !== 0) {
            newItems.unshift(remaining);
          } else if (i !== 0) {
            // Combine [value] with left neighbor.
            startIndex--;
            deleteCount++;
            (newItems[0] as T[]).unshift(...(items[i - 1] as T[]));
          }
          if (remaining !== curItem - 1) {
            newItems.push(curItem - 1 - remaining);
          } else if (i !== items.length - 1) {
            // Combine [value] with right neighbor.
            deleteCount++;
            (newItems[newItems.length - 1] as T[]).push(
              ...(items[i + 1] as T[])
            );
          }

          items.splice(startIndex, deleteCount, ...newItems);
          this.updateTotals(waypoint, 1);
          return;
        } else remaining -= curItem;
      }
    }

    // If we get here, the position is in the implied last item,
    // which is deleted.
    // Note that the actual last element of items is necessarily present.
    if (remaining !== 0) {
      items.push(remaining, [value]);
    } else {
      if (items.length === 0) items.push([value]);
      else {
        // Merge value with the preceding present item.
        (items[items.length - 1] as T[]).push(value);
      }
    }
    this.updateTotals(waypoint, 1);
  }

  /**
   * Optimized variant of [[set]] for newly-created
   * positions, typically called in a [[PositionSourceCreateEvent]]
   * handler. This method sets the positions
   * referenced by `e` to `values`.
   *
   * @throws If `values.length !== e.count`
   */
  setCreated(e: PositionSourceCreateEvent, values: T[]): void {
    if (values.length !== e.count) {
      throw new Error("values do not match count");
    }
    this._inInitialState = false;

    const waypoint = e.waypoint;
    const info = this.valuesByWaypoint.get(waypoint);
    if (info === undefined) {
      // Waypoint has no values currently; set them to
      // [valueIndex, values].
      // Except, omit 0s.
      const newItems = e.valueIndex === 0 ? [values] : [e.valueIndex, values];
      this.valuesByWaypoint.set(waypoint, {
        total: 0,
        items: newItems,
      });
    } else {
      // Get number of existing positions in info (which omits the
      // final deleted items).
      let existing = 0;
      for (const item of info.items) {
        existing += typeof item === "number" ? item : item.length;
      }
      if (existing < e.valueIndex) {
        // Fill in deleted positions before values.
        info.items.push(e.valueIndex - existing, values);
      } else if (existing === e.valueIndex) {
        if (info.items.length === 0) {
          info.items.push(values);
        } else {
          // Merge with previous (present) item.
          (info.items[info.items.length - 1] as T[]).push(...values);
        }
      } else {
        throw new Error("setCreated called on already-used positions");
      }
    }
    this.updateTotals(waypoint, values.length);
  }

  /**
   * Deletes the given position, making it no longer
   * present in this list.
   *
   * @returns Whether the position was actually deleted, i.e.,
   * it was initially present.
   */
  delete(position: Position): boolean {
    this._inInitialState = false;

    const [waypoint, valueIndex] = this.source.decode(position);
    const info = this.valuesByWaypoint.get(waypoint);
    if (info === undefined) {
      // Already not present.
      return false;
    }
    const items = info.items;
    let remaining = valueIndex;
    for (let i = 0; i < items.length; i++) {
      const curItem = items[i];
      if (typeof curItem === "number") {
        if (remaining < curItem) {
          // Already not present.
          return false;
        } else remaining -= curItem;
      } else {
        if (remaining < curItem.length) {
          // Replace curItem[remaining] with
          // [curItem[:remaining], 1, curItem[remaining+1:]].
          // Except, omit empty slices and combine the 1 with
          // neighboring numbers if needed.
          let startIndex = i;
          let deleteCount = 1;
          const newItems: (T[] | number)[] = [1];

          if (remaining !== 0) {
            newItems.unshift(curItem.slice(0, remaining));
          } else if (i !== 0) {
            // Combine 1 with left neighbor.
            startIndex--;
            deleteCount++;
            (newItems[0] as number) += items[i - 1] as number;
          }
          if (remaining !== curItem.length - 1) {
            newItems.push(curItem.slice(remaining + 1));
          } else if (i !== items.length - 1) {
            // Combine 1 with right neighbor.
            deleteCount++;
            (newItems[newItems.length - 1] as number) += items[i + 1] as number;
          }

          items.splice(startIndex, deleteCount, ...newItems);

          // If the last item is a number (deleted), omit it.
          if (typeof items[items.length - 1] === "number") items.pop();

          this.updateTotals(waypoint, -1);
          return true;
        } else remaining -= curItem.length;
      }
    }
    // If we get here, the position is in the implied last item,
    // hence is already deleted.
    return false;
  }

  /**
   * Changes total by delta for waypoint and all of its ancestors.
   * Creates/deletes WaypointValues as needed to maintain
   * (present iff total = 0) invariant.
   *
   * delta must not be 0.
   */
  private updateTotals(waypoint: Waypoint, delta: number): void {
    for (
      let current: Waypoint | null = waypoint;
      current !== null;
      current = current.parentWaypoint
    ) {
      const info = this.valuesByWaypoint.get(current);
      if (info === undefined) {
        // Create WaypointValues.
        this.valuesByWaypoint.set(current, {
          // Nonzero by assumption.
          total: delta,
          // Omit last deleted item (= only item).
          items: [],
        });
      } else {
        info.total += delta;
        if (info.total === 0) {
          // Delete WaypointValues.
          this.valuesByWaypoint.delete(current);
        }
      }
    }
  }

  // Omitting clear() for now because it is usually a mistake to use it.
  // /**
  //  * Deletes every value in the list.
  //  */
  // clear() {
  //   this.valuesByWaypoint.clear();
  // }

  /**
   * Returns the value at position, or undefined if it is not currently present
   * ([[hasPosition]] returns false).
   */
  getByPosition(position: Position): T | undefined {
    return this.locate(...this.source.decode(position))[0];
  }

  /**
   * Returns whether position is currently present in the list,
   * i.e., its value is present.
   */
  hasPosition(position: Position): boolean {
    return this.locate(...this.source.decode(position))[1];
  }

  /**
   * Okay if valueIndex is waypoint.valueCount - will return
   * [undefined, false, number of values within waypoint].
   *
   * @returns [value at position, whether position is present,
   * number of present values within waypoint
   * (not descendants) strictly prior to position]
   */
  private locate(
    waypoint: Waypoint,
    valueIndex: number
  ): [value: T | undefined, isPresent: boolean, waypointValuesBefore: number] {
    const info = this.valuesByWaypoint.get(waypoint);
    if (info === undefined) {
      // No values within waypoint.
      return [undefined, false, 0];
    }
    let remaining = valueIndex;
    let waypointValuesBefore = 0;
    for (const item of info.items) {
      if (typeof item === "number") {
        if (remaining < item) {
          return [undefined, false, waypointValuesBefore];
        } else remaining -= item;
      } else {
        if (remaining < item.length) {
          return [item[remaining], true, waypointValuesBefore + remaining];
        } else {
          remaining -= item.length;
          waypointValuesBefore += item.length;
        }
      }
    }
    // If we get here, then the valueIndex is after all present values
    // (either within the omitted final number, or the special case
    // valueIndex === waypoint.valueCount).
    return [undefined, false, waypointValuesBefore];
  }

  /**
   * Returns the current index of position.
   *
   * If position is not currently present in the list
   * ([[hasPosition]] returns false), then the result depends on searchDir:
   * - "none" (default): Returns -1.
   * - "left": Returns the next index to the left of position.
   * If there are no values to the left of position,
   * returns -1.
   * - "right": Returns the next index to the right of position.
   * If there are no values to the right of position,
   * returns [[length]].
   *
   * To find the index where a position would be if
   * present, use `searchDir = "right"`.
   */
  indexOfPosition(
    position: Position,
    searchDir: "none" | "left" | "right" = "none"
  ): number {
    const [waypoint, valueIndex] = this.source.decode(position);
    const [, isPresent, waypointValuesBefore] = this.locate(
      waypoint,
      valueIndex
    );
    // Will be the total number of values prior to position.
    let valuesBefore = waypointValuesBefore;

    // Add totals for child waypoints that come before valueIndex.
    // These are precisely the left children with
    // parentValueIndex <= valueIndex.
    for (const child of waypoint.children) {
      if (child.isRight || child.parentValueIndex > valueIndex) break;
      valuesBefore += this.total(child);
    }

    // Walk up the tree and add totals for sibling values & waypoints
    // that come before our ancestor.
    for (
      let current = waypoint;
      current.parentWaypoint !== null;
      current = current.parentWaypoint
    ) {
      // Sibling values that come before current.
      valuesBefore += this.locate(
        current.parentWaypoint,
        current.isRight
          ? current.parentWaypoint.valueCount
          : current.parentValueIndex
      )[2];
      // Sibling waypoints that come before current.
      for (const child of current.parentWaypoint.children) {
        if (child === current) break;
        valuesBefore += this.total(child);
      }
    }

    if (isPresent) return valuesBefore;
    else {
      switch (searchDir) {
        case "none":
          return -1;
        case "left":
          return valuesBefore - 1;
        case "right":
          return valuesBefore;
      }
    }
  }

  /**
   * Returns the position currently at index.
   */
  getPosition(index: number): Position {
    if (index < 0 || index >= this.length) {
      throw new Error(`Index out of bounds: ${index} (length: ${this.length})`);
    }
    let remaining = index;
    let waypoint = this.source.rootWaypoint;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      waypointLoop: {
        for (const next of this.valuesAndChildren(waypoint)) {
          if (next.isValues) {
            const length = next.end - next.start;
            if (remaining < length) {
              // Answer is values[remaining].
              return this.source.encode(waypoint, next.valueIndex + remaining);
            } else remaining -= length;
          } else {
            if (remaining < next.total) {
              // Recurse into child.
              waypoint = next.child;
              break waypointLoop;
            } else remaining -= next.total;
          }
        }
        // We should always end by the break statement (recursion), not by
        // the for loop's finishing.
        throw new Error("Internal error: failed to find index among children");
      }
    }
  }

  // /**
  //  * For debugging: print entries() walk through the tree to console.log.
  //  */
  // printTreeWalk(): void {
  //   if (this.length === 0) return;

  //   let index = 0;
  //   let waypoint: Waypoint | null = this.source.rootWaypoint;
  //   console.log(
  //     `"${waypoint.senderID}",${waypoint.counter}: ${this.total(
  //       waypoint
  //     )} [${index}, ${index + this.total(waypoint)})`
  //   );
  //   // Manage our own stack instead of recursing, to avoid stack overflow
  //   // in deep trees.
  //   const stack: IterableIterator<ValuesOrChild<T>>[] = [
  //     // root will indeed have total != 0 since we checked length != 0.
  //     this.valuesAndChildren(this.source.rootWaypoint),
  //   ];
  //   while (waypoint !== null) {
  //     const iter = stack[stack.length - 1];
  //     const next = iter.next();
  //     if (next.done) {
  //       stack.pop();
  //       waypoint = waypoint.parentWaypoint;
  //     } else {
  //       const prefix = new Array(stack.length).fill(" ").join(" ");
  //       const valuesOrChild = next.value;
  //       if (valuesOrChild.isValues) {
  //         console.log(
  //           prefix,
  //           `${valuesOrChild.valueIndex}:`,
  //           JSON.stringify(
  //             valuesOrChild.item.slice(valuesOrChild.start, valuesOrChild.end)
  //           ),
  //           `@ [${index}, ${index + valuesOrChild.end - valuesOrChild.start})`
  //         );
  //         index += valuesOrChild.end - valuesOrChild.start;
  //       } else {
  //         // Recurse into child.
  //         waypoint = valuesOrChild.child;
  //         console.log(
  //           prefix,
  //           `"${waypoint.senderID},${waypoint.counter} (${
  //             waypoint.parentValueIndex
  //           }, ${waypoint.isRight ? "R" : "L"}): ${this.total(
  //             waypoint
  //           )} @ [${index}, ${index + this.total(waypoint)})`
  //         );
  //         stack.push(this.valuesAndChildren(waypoint));
  //       }
  //     }
  //   }
  // }

  /**
   * Returns the value currently at index.
   *
   * @throws If index is not in `[0, this.length)`.
   * Note that this differs from an ordinary Array,
   * which would instead return undefined.
   */
  get(index: number): T {
    // OPT: combine these operations
    return this.getByPosition(this.getPosition(index))!;
  }

  /**
   * The length of the list.
   */
  get length() {
    return this.total(this.source.rootWaypoint);
  }

  /** Returns an iterator for values in the list, in list order. */
  [Symbol.iterator](): IterableIterator<T> {
    return this.values();
  }

  /**
   * Returns an iterator of [index, position, value] tuples for every
   * value in the list, in list order.
   */
  *entries(): IterableIterator<[index: number, position: Position, value: T]> {
    if (this.length === 0) return;

    let index = 0;
    let waypoint: Waypoint | null = this.source.rootWaypoint;
    // Manage our own stack instead of recursing, to avoid stack overflow
    // in deep trees.
    const stack: IterableIterator<ValuesOrChild<T>>[] = [
      // root will indeed have total != 0 since we checked length != 0.
      this.valuesAndChildren(this.source.rootWaypoint),
    ];
    while (waypoint !== null) {
      const iter = stack[stack.length - 1];
      const next = iter.next();
      if (next.done) {
        stack.pop();
        waypoint = waypoint.parentWaypoint;
      } else {
        const valuesOrChild = next.value;
        if (valuesOrChild.isValues) {
          for (let i = 0; i < valuesOrChild.end - valuesOrChild.start; i++) {
            yield [
              index,
              this.source.encode(waypoint, valuesOrChild.valueIndex + i),
              valuesOrChild.item[valuesOrChild.start + i],
            ];
            index++;
          }
        } else {
          // Recurse into child.
          waypoint = valuesOrChild.child;
          stack.push(this.valuesAndChildren(waypoint));
        }
      }
    }
  }

  /**
   * Yields non-trivial values and Waypoint children
   * for waypoint, in list order. This is used when
   * iterating over the list.
   *
   * Specifically, it yields:
   * - "Sub-items" consisting of a slice of a present item.
   * - Waypoint children with non-zero total.
   *
   * together with enough info to infer their starting valueIndex's.
   *
   * @throws If `this.total(waypoint) === 0`
   */
  private *valuesAndChildren(
    waypoint: Waypoint
  ): IterableIterator<ValuesOrChild<T>> {
    const items = this.valuesByWaypoint.get(waypoint)!.items;
    const children = waypoint.children;
    let childIndex = 0;
    let startValueIndex = 0;
    for (const item of items) {
      const itemSize = typeof item === "number" ? item : item.length;
      // After (next startValueIndex)
      const endValueIndex = startValueIndex + itemSize;
      // Next value to yield
      let valueIndex = startValueIndex;
      for (; childIndex < children.length; childIndex++) {
        const child = children[childIndex];
        if (child.isRight || child.parentValueIndex >= endValueIndex) {
          // child comes after item. End the loop and visit child
          // during the next item.
          break;
        }
        const total = this.total(child);
        if (total !== 0) {
          // Emit child. If needed, first emit values that come before it.
          if (valueIndex < child.parentValueIndex) {
            if (typeof item !== "number") {
              yield {
                isValues: true,
                item,
                start: valueIndex - startValueIndex,
                end: child.parentValueIndex - startValueIndex,
                valueIndex,
              };
            }
            valueIndex = child.parentValueIndex;
          }
          yield { isValues: false, child, total };
        }
      }

      // Emit remaining values in item.
      if (typeof item !== "number" && valueIndex < endValueIndex) {
        yield {
          isValues: true,
          item,
          start: valueIndex - startValueIndex,
          end: itemSize,
          valueIndex,
        };
      }
      startValueIndex = endValueIndex;
    }
    // Visit remaining children (left children among a possible deleted
    // final item (which items omits) and right children).
    for (; childIndex < children.length; childIndex++) {
      const child = children[childIndex];
      const total = this.total(child);
      if (this.total(child) !== 0) {
        yield { isValues: false, child, total };
      }
    }
  }

  /**
   * Returns the total number of present values at this
   * waypoint and its descendants.
   */
  private total(waypoint: Waypoint): number {
    return this.valuesByWaypoint.get(waypoint)?.total ?? 0;
  }

  /** Returns an iterator for values in the list, in list order. */
  *values(): IterableIterator<T> {
    // OPT: do own walk and yield* value items, w/o encoding positions.
    for (const [, , value] of this.entries()) yield value;
  }

  /** Returns an iterator for present positions, in list order. */
  *positions(): IterableIterator<Position> {
    for (const [, position] of this.entries()) yield position;
  }

  /**
   * Returns a copy of a section of this list, as an array.
   * For both start and end, a negative index can be used to indicate an offset from the end of the list.
   * For example, -2 refers to the second to last element of the list.
   * @param start The beginning index of the specified portion of the list.
   * If start is undefined, then the slice begins at index 0.
   * @param end The end index of the specified portion of the list. This is exclusive of the element at the index 'end'.
   * If end is undefined, then the slice extends to the end of the list.
   */
  slice(start?: number, end?: number): T[] {
    const len = this.length;
    if (start === undefined || start < -len) {
      start = 0;
    } else if (start < 0) {
      start += len;
    } else if (start >= len) {
      return [];
    }
    if (end === undefined || end >= len) {
      end = len;
    } else if (end < -len) {
      end = 0;
    } else if (end < 0) {
      end += len;
    }
    if (end <= start) return [];

    // Optimize common case (slice())
    if (start === 0 && end === len) {
      return [...this.values()];
    } else {
      // OPT: optimize.
      const ans = new Array<T>(end - start);
      for (let i = 0; i < end - start; i++) {
        ans[i] = this.get(start + i);
      }
      return ans;
    }
  }

  /**
   * Whether this list is in its initial state, i.e.,
   * it has never been mutated.
   */
  get inInitialState(): boolean {
    return this._inInitialState;
  }

  // OPT: other IList methods: utility accessors, positionOf?
  // If so, call those from CRDT versions.

  /**
   * Returns saved state describing the current state of this LocalList,
   * including its values.
   *
   * The saved state may later be passed to [[load]]
   * on a new instance of LocalList, to reconstruct the
   * same list state.
   *
   * @param valueArraySerializer Used to serialize values.
   * Note that this may be called multiple times on distinct
   * value arrays, and value arrays may contain non-contiguous values.
   */
  save(valueArraySerializer: Serializer<T[]>): Uint8Array {
    const replicaIDs: string[] = [];
    const replicaIDsInv = new Map<string, number>();
    replicaIDsInv.set("", 0);
    const replicaIDIndices: number[] = [];
    const counters: number[] = [];
    const totals: number[] = [];
    const itemsLengths: number[] = [];
    const itemSizes: number[] = [];
    const values: T[] = [];

    for (const [waypoint, info] of this.valuesByWaypoint) {
      let replicaIDIndex = replicaIDsInv.get(waypoint.senderID);
      if (replicaIDIndex === undefined) {
        replicaIDs.push(waypoint.senderID);
        // 1-indexed
        replicaIDIndex = replicaIDs.length;
        replicaIDsInv.set(waypoint.senderID, replicaIDIndex);
      }
      replicaIDIndices.push(replicaIDIndex);

      counters.push(waypoint.counter);
      totals.push(info.total);
      itemsLengths.push(info.items.length);
      for (const item of info.items) {
        if (typeof item === "number") {
          itemSizes.push(-item);
        } else {
          itemSizes.push(item.length);
          values.push(...item);
        }
      }
    }

    const message = LocalListSave.create({
      replicaIDs,
      replicaIDIndices,
      counters,
      totals,
      itemsLengths,
      itemSizes,
      values: valueArraySerializer.serialize(values),
    });
    return LocalListSave.encode(message).finish();
  }

  /**
   * Loads saved state. The saved state must be from
   * a call to [[save]] on a LocalList whose `source`
   * constructor argument was a replica of this's
   * `source`, so that we can understand the
   * saved state's Positions.
   *
   * This method may only be called on a LocalList in
   * its initial state (see [[inInitialState]]); it
   * does not support "merging" in the sense of [[CRuntime.load]].
   *
   * @param savedState Saved state from another LocalList's
   * [[save]] call.
   * @param valueArraySerializer Used to deserialize values.
   * Must be equivalent to [[save]]'s valueArraySerializer.
   */
  load(savedState: Uint8Array, valueArraySerializer: Serializer<T[]>): void {
    if (!this._inInitialState) {
      throw new Error("Can only call load in the initial state");
    }
    this._inInitialState = false;

    const decoded = LocalListSave.decode(savedState);
    const values = valueArraySerializer.deserialize(decoded.values);

    let sizesIndex = 0;
    let valuesIndex = 0;
    for (let i = 0; i < decoded.replicaIDIndices.length; i++) {
      const replicaIDIndex = decoded.replicaIDIndices[i];
      const replicaID =
        replicaIDIndex === 0 ? "" : decoded.replicaIDs[replicaIDIndex - 1];
      const waypoint = this.source.getWaypoint(replicaID, decoded.counters[i]);
      const info: WaypointInfo<T> = {
        total: decoded.totals[i],
        items: new Array<T[] | number>(decoded.itemsLengths[i]),
      };
      for (let j = 0; j < decoded.itemsLengths[i]; j++) {
        const itemSize = decoded.itemSizes[sizesIndex];
        sizesIndex++;
        if (itemSize < 0) info.items[j] = -itemSize;
        else {
          info.items[j] = values.slice(valuesIndex, valuesIndex + itemSize);
          valuesIndex += itemSize;
        }
      }
      this.valuesByWaypoint.set(waypoint, info);
    }
  }
}
