import {
  InitToken,
  Message,
  MessageMeta,
  FoundLocation,
  int64AsNumber,
  Optional,
  CPrimitive,
  CollabEvent,
  CollabEventsRecord,
} from "@collabs/core";
import { CTextMessage, CTextSave } from "../../generated/proto_compiled";
import { Position, PositionSource, StringItemManager } from "./position_source";

export interface CTextInsertEvent extends CollabEvent {
  startIndex: number;
  count: number;
}

export interface CTextDeleteEvent extends CollabEvent {
  startIndex: number;
  count: number;
  deletedValues: string;
}

export interface CTextEventsRecord extends CollabEventsRecord {
  Insert: CTextInsertEvent;
  Delete: CTextDeleteEvent;
}

export class CText extends CPrimitive<CTextEventsRecord> {
  private readonly positionSource: PositionSource<string>;

  constructor(initToken: InitToken) {
    super(initToken);

    this.positionSource = new PositionSource(
      this.runtime.replicaID,
      StringItemManager.instance
    );
  }

  // TODO: optimize bulk methods.

  insert(index: number, values: string): void {
    if (values.length === 0) return undefined;

    const prevPos =
      index === 0 ? null : this.positionSource.getPosition(index - 1);
    const [counter, startValueIndex, metadata] =
      this.positionSource.createPositions(prevPos);

    const message = CTextMessage.create({
      insert: {
        counter,
        startValueIndex,
        metadata,
        values,
      },
    });
    this.sendPrimitive(CTextMessage.encode(message).finish());
  }

  delete(startIndex: number, count = 1): void {
    if (startIndex < 0) {
      throw new Error(`startIndex out of bounds: ${startIndex}`);
    }
    if (startIndex + count > this.length) {
      throw new Error(
        `(startIndex + count) out of bounds: ${startIndex} + ${count} (length: ${this.length})`
      );
    }

    // TODO: native range deletes? E.g. compress waypoint valueIndex ranges.
    // TODO: optimize range iteration (back to front).
    // Delete from back to front, so indices make sense.
    for (let i = startIndex + count - 1; i >= startIndex; i--) {
      const pos = this.positionSource.getPosition(i);
      const message = CTextMessage.create({
        delete: {
          sender: pos[0] === this.runtime.replicaID ? null : pos[0],
          counter: pos[1],
          valueIndex: pos[2],
        },
      });
      this.sendPrimitive(CTextMessage.encode(message).finish());
    }
  }

  protected receivePrimitive(message: Message, meta: MessageMeta): void {
    const decoded = CTextMessage.decode(<Uint8Array>message);
    switch (decoded.op) {
      case "insert": {
        const counter = int64AsNumber(decoded.insert!.counter);
        const startValueIndex = decoded.insert!.startValueIndex;
        const values = decoded.insert!.values;
        const metadata = Object.prototype.hasOwnProperty.call(
          decoded.insert!,
          "metadata"
        )
          ? decoded.insert!.metadata!
          : null;

        const pos: Position = [meta.sender, counter, startValueIndex];
        this.positionSource.receiveAndAddPositions(pos, values, metadata);

        // Here we exploit the LtR non-interleaving property
        // to assert that the inserted values are contiguous.
        this.emit("Insert", {
          startIndex: this.positionSource.find(pos)[0],
          count: values.length,
          meta,
        });

        break;
      }
      case "delete": {
        const sender = Object.prototype.hasOwnProperty.call(
          decoded.delete!,
          "sender"
        )
          ? decoded.delete!.sender!
          : meta.sender;
        const counter = int64AsNumber(decoded.delete!.counter);
        const valueIndex = decoded.delete!.valueIndex;
        const pos: Position = [sender, counter, valueIndex];
        const deletedValues = this.positionSource.delete(pos);
        if (deletedValues !== null) {
          this.emit("Delete", {
            startIndex: this.positionSource.find(pos)[0],
            count: 1,
            deletedValues: deletedValues.charAt(0),
            meta,
          });
        }
        break;
      }
      default:
        throw new Error(`Unrecognized decoded.op: ${decoded.op}`);
    }
  }

  // TODO: string convenience methods, instead of array methods.
  // TODO: rename for string version (e.g. get -> charAt).

  charAt(index: number): string {
    const [item, offset] = this.positionSource.getItem(index);
    return item[offset];
  }

  *values(): IterableIterator<string> {
    for (const item of this.positionSource.items()) {
      yield* item;
    }
  }

  [Symbol.iterator]() {
    return this.values();
  }

  // TODO: items() version of iterator? Likewise for PrimitiveCList?

  get length(): number {
    return this.positionSource.length;
  }

  toString(): string {
    let ans = "";
    for (const item of this.positionSource.items()) {
      ans += item;
    }
    return ans;
  }

  getLocation(index: number): string {
    const pos = this.positionSource.getPosition(index);
    // TODO: shorter encoding? Also in locationEntries().
    return JSON.stringify(pos);
  }

  findLocation(location: string): FoundLocation {
    const pos = <Position>JSON.parse(location);
    return new FoundLocation(...this.positionSource.find(pos));
  }

  *locationEntries(): IterableIterator<[string, string]> {
    for (const [pos, length, item] of this.positionSource.itemPositions()) {
      for (let i = 0; i < length; i++) {
        yield [JSON.stringify(pos), item[i]];
        pos[2]++;
      }
    }
  }

  save(): Uint8Array {
    const message = CTextSave.create({
      positionSourceSave: this.positionSource.save(),
      valuesSave: this.toString(),
    });
    return CTextSave.encode(message).finish();
  }

  load(saveData: Optional<Uint8Array>): void {
    if (saveData.isPresent) {
      const decoded = CTextSave.decode(saveData.get());
      const values = decoded.valuesSave;
      let index = 0;
      this.positionSource.load(decoded.positionSourceSave, (count) => {
        const ans = values.slice(index, index + count);
        index += count;
        return ans;
      });
    }
  }

  canGC(): boolean {
    // TODO: return true if not yet mutated
    return false;
  }

  // TODO: remove
  printTreeWalk() {
    this.positionSource.printTreeWalk();
  }
}
