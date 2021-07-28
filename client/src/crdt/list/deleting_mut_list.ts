import { DefaultElementSerializer, ElementSerializer } from "../../util";
import { Crdt } from "../core";
import { Resettable } from "../helper_crdts";
import { LwwCRegister } from "../register";
import { DeletingMutCSet } from "../set";
import {
  MovableMutCListEntry,
  MovableMutCListFromSet,
} from "./movable_mut_list_from_set";
import {
  TreedocDenseLocalList,
  TreedocLocWrapper,
} from "./treedoc_dense_local_list";

export class DeletingMutCList<C extends Crdt, InsertArgs extends any[]>
  extends MovableMutCListFromSet<
    C,
    InsertArgs,
    TreedocLocWrapper,
    LwwCRegister<TreedocLocWrapper>,
    DeletingMutCSet<
      MovableMutCListEntry<
        C,
        TreedocLocWrapper,
        LwwCRegister<TreedocLocWrapper>
      >,
      [TreedocLocWrapper, InsertArgs]
    >,
    TreedocDenseLocalList<
      MovableMutCListEntry<
        C,
        TreedocLocWrapper,
        LwwCRegister<TreedocLocWrapper>
      >
    >
  >
  implements Resettable 
{
  constructor(
    valueConstructor: (...args: InsertArgs) => C,
    argsSerializer: ElementSerializer<InsertArgs> = DefaultElementSerializer.getInstance()
  ) {
    super(
      (setValueConstructor, setArgsSerializer) =>
        new DeletingMutCSet(setValueConstructor, undefined, setArgsSerializer),
      (initialValue, registerSerializer) =>
        new LwwCRegister({ value: initialValue }, registerSerializer),
      new TreedocDenseLocalList(),
      valueConstructor,
      argsSerializer
    );
  }

  owns(value: C): boolean {
    // TODO: might throw error due to double-parent.
    // Should change both owns methods to guard against this
    // (return false on rootCrdt).
    return this.set.owns(
      value.parent as MovableMutCListEntry<
        C,
        TreedocLocWrapper,
        LwwCRegister<TreedocLocWrapper>
      >
    );
  }

  reset() {
    // This is a proper observed-reset since TreedocDenseLocalList
    // has no tombstones.
    super.set.reset();
  }

  // TODO: conflicts methods for move locations?
  // Likewise for TombstoneMutCList.
}
