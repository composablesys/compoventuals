import {
  CrdtSerializer,
  DefaultElementSerializer,
  ElementSerializer,
} from "../../util";
import { Crdt } from "../core";
import { AbstractCSetCompositeCrdt } from "./abstract_set";
import { AddWinsCSet } from "./add_wins_set";
import { DeletingMutCSet } from "./deleting_mut_set";

/**
 * Warning: tombstones, so uses ever-growing memory.  Use
 * with caution (e.g. only if it is itself in a
 * DeletingMut collection and will be deleted later).
 * Discuss alternatives.
 */
export class TombstoneMutCSet<
  C extends Crdt,
  AddArgs extends any[]
> extends AbstractCSetCompositeCrdt<C, AddArgs> {
  private readonly mutSet: DeletingMutCSet<C, AddArgs>;
  private readonly members: AddWinsCSet<C>;

  /**
   * [constructor description]
   * @param valueConstructor [description]
   * @param concurrentOpRestores if true, then when an
   * operation is performed on a value concurrent to its
   * deletion, the value is automatically restored.  This may
   * match user expectations in some scenarios, e.g., if
   * one user is working on something while another deletes it,
   * their concurrent work undoes the deletion.  Defaults to false.
   */
  constructor(
    valueConstructor: (...args: AddArgs) => C,
    concurrentOpRestores = false,
    argsSerializer: ElementSerializer<AddArgs> = DefaultElementSerializer.getInstance()
  ) {
    super();

    let internalValueConstructor: (...args: AddArgs) => C;
    if (concurrentOpRestores) {
      internalValueConstructor = (...args) => {
        const value = valueConstructor(...args);
        value.on("Change", (event) => {
          this.runtime.runLocally(event.timestamp, () => {
            this.members.add(value);
          });
        });
        return value;
      };
    } else {
      internalValueConstructor = valueConstructor;
    }

    this.mutSet = this.addChild(
      "",
      new DeletingMutCSet(internalValueConstructor, undefined, argsSerializer)
    );
    // Use a custom serializer that uses mutSet's ids instead
    // of full pathToRoot's, for network efficiency.
    this.members = this.addChild(
      "0",
      new AddWinsCSet(new CrdtSerializer(this.mutSet))
    );

    // Events
    this.members.on("Add", (event) => this.emit("Add", event));
    this.members.on("Delete", (event) => this.emit("Delete", event));
  }

  add(...args: AddArgs): C {
    const value = this.mutSet.add(...args);
    this.members.add(value);
    return value;
  }

  restore(value: C) {
    if (!this.owns(value)) {
      throw new Error("this.owns(value) is false");
    }
    this.members.add(value);
  }

  delete(value: C) {
    this.members.delete(value);
  }

  owns(value: C) {
    return this.mutSet.owns(value);
  }

  has(value: C) {
    return this.members.has(value);
  }

  values() {
    return this.members.values();
  }

  get size(): number {
    return this.members.size;
  }
}
