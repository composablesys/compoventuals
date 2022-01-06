import { Resettable } from "../abilities";
import { CObject } from "../../constructions";
import { CollabEvent, CollabEventsRecord, InitToken, Pre } from "../../core";
import { Optional, OptionalSerializer, Serializer } from "../../util";
import { LwwCRegister } from "../register";
import { CList, CListEventsRecord } from "../../data_types";

export interface LocatableCList<
  L,
  T,
  InsertArgs extends unknown[] = [T],
  Events extends CListEventsRecord<T> = CListEventsRecord<T>
> extends CList<T, InsertArgs, Events> {
  /**
   * Returns a "location" L that uniquely identifies the
   * position of this.get(index).  So if the value changes
   * index due to insertions/deletions at earlier indices,
   * the location will also change index.
   */
  getLocation(index: number): L;

  /**
   * If loc is currently present, returns [its current index,
   * true].  Else returns [the index where it would be if
   * it were restored, false].
   *
   * Equivalently, returns [index of the least location that
   * is >= the given location (possibly this.length), whether
   * the location is present].
   *
   * A location becomes not present when its current index is
   * deleted.
   *
   * @param  loc [description]
   * @return     [description]
   */
  locate(location: L): [index: number, isPresent: boolean];

  readonly locationSerializer: Serializer<L>;
}

class CursorCommon<L> {
  constructor(
    readonly list: LocatableCList<L, unknown, unknown[]>,
    readonly binding: "left" | "right" = "left"
  ) {}

  indexToLoc(index: number): Optional<L> {
    if (this.binding === "left") {
      if (index === 0) return Optional.empty();
      else {
        return Optional.of(this.list.getLocation(index - 1));
      }
    } else {
      if (index === this.list.length) return Optional.empty();
      else return Optional.of(this.list.getLocation(index));
    }
  }

  locToIndex(loc: Optional<L>): number {
    if (this.binding === "left") {
      if (!loc.isPresent) return 0;
      else {
        const [index, isPresent] = this.list.locate(loc.get());
        return isPresent ? index + 1 : index;
      }
    } else {
      if (!loc.isPresent) return this.list.length;
      else {
        return this.list.locate(loc.get())[0];
      }
    }
  }
}

export class LocalCursor {
  private readonly common: CursorCommon<unknown>;
  private loc!: Optional<unknown>;

  constructor(
    list: LocatableCList<unknown, unknown, unknown[]>,
    startIndex: number,
    binding: "left" | "right" = "left"
  ) {
    this.common = new CursorCommon(list, binding);
    this.index = startIndex;
  }

  set index(index: number) {
    this.loc = this.common.indexToLoc(index);
  }

  get index(): number {
    return this.common.locToIndex(this.loc);
  }
}

export interface CCursorEventsRecord extends CollabEventsRecord {
  Set: CollabEvent;
}

export class CCursor
  extends CObject<CCursorEventsRecord>
  implements Resettable
{
  private readonly common: CursorCommon<unknown>;
  // LWW is probably overkill since usually only one replica
  // will use this cursor, but it's easiest.
  private readonly loc: LwwCRegister<Optional<unknown>>;

  constructor(
    initToken: InitToken,
    list: LocatableCList<unknown, unknown, unknown[]>,
    startIndex: number,
    binding: "left" | "right" = "left"
  ) {
    super(initToken);

    this.common = new CursorCommon(list, binding);
    this.loc = this.addChild(
      "",
      Pre(LwwCRegister)(
        Optional.of(list.getLocation(startIndex)),
        OptionalSerializer.getInstance(list.locationSerializer)
      )
    );
    this.loc.on("Set", (e) => this.emit("Set", e));
    // TODO: only emit if index actually changed (need to cache,
    // or only listen on the Insert/Delete events and compare
    // their indices).
    list.on("Any", (e) => this.emit("Set", e));
  }

  set index(index: number) {
    // Only set if changed.  This will help optimize in case
    // the user is setting index each time the user types,
    // even if this cursor's loc doesn't change.
    const newLoc = this.common.indexToLoc(index);
    if (
      newLoc.isPresent === this.loc.value.isPresent &&
      (!newLoc.isPresent || newLoc.get() === this.loc.value.get())
    ) {
      return;
    }
    this.loc.set(newLoc);
  }

  get index(): number {
    return this.common.locToIndex(this.loc.value);
  }

  /**
   * Resets this CCursor to its starting location (not
   * necessarily starting index).
   */
  reset() {
    this.loc.reset();
  }
}
