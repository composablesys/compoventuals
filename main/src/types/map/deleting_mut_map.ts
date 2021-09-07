import { DefaultElementSerializer, ElementSerializer } from "../../util";
import { Crdt, CrdtInitToken, Pre } from "../../core";
import { Resettable } from "../../abilities";
import { DeletingMutCSet } from "../set";
import { LwwCMap } from "./lww_map";
import { MutCMapFromSet } from "./mut_map_from_set";

export class DeletingMutCMap<K, C extends Crdt, SetArgs extends any[]>
  extends MutCMapFromSet<
    K,
    C,
    SetArgs,
    DeletingMutCSet<C, [K, SetArgs]>,
    LwwCMap<K, C>
  >
  implements Resettable
{
  constructor(
    initToken: CrdtInitToken,
    valueConstructor: (
      valueInitToken: CrdtInitToken,
      key: K,
      ...args: SetArgs
    ) => C,
    keySerializer: ElementSerializer<K> = DefaultElementSerializer.getInstance(),
    argsSerializer: ElementSerializer<SetArgs> = DefaultElementSerializer.getInstance()
  ) {
    super(
      initToken,
      (setValueConstructor, setArgsSerializer) =>
        Pre(DeletingMutCSet)(setValueConstructor, undefined, setArgsSerializer),
      Pre(LwwCMap),
      valueConstructor,
      keySerializer,
      argsSerializer
    );
  }

  owns(value: C): boolean {
    return this.valueSet.owns(value);
  }

  reset() {
    // This should be equivalent to clear, but just in case...
    this.map.reset();
    this.valueSet.reset();
  }

  /**
   * [keyOf description] TODO: copy from CMap
   * @param  value [description]
   * @return       [description]
   * @throws if value is not a current value or conflict
   */
  keyOf(value: C): K {
    if (!this.valueSet.has(value)) {
      throw new Error("value is not a current value or conflict");
    }
    return this.valueSet.getArgs(value)[0];
  }

  getArgs(key: K): SetArgs | undefined {
    const value = this.get(key);
    if (value === undefined) return undefined;
    else return this.valueSet.getArgs(value)[1];
  }

  /**
   * [getArgs description]
   * @param  value [description]
   * @return the SetArgs used to set value
   * @throws if value is not a current value or conflict
   */
  getArgsByValue(value: C): SetArgs {
    if (!this.valueSet.has(value)) {
      throw new Error("value is not a current value or conflict");
    }
    return this.valueSet.getArgs(value)[1];
  }
}
