import { DefaultSerializer, Serializer } from "../../util";
import { Collab, InitToken, Pre } from "../../core";
import { Resettable } from "../abilities";
import { ResettingMutCSet } from "../set";
import { LwwCMap } from "./lww_map";
import { MutCMapFromSet } from "./mut_map_from_set";

export class ResettingMutCMap<
    K,
    C extends Collab & Resettable,
    SetArgs extends any[]
  >
  extends MutCMapFromSet<
    K,
    C,
    SetArgs,
    ResettingMutCSet<C, [K, SetArgs]>,
    LwwCMap<K, C>
  >
  implements Resettable
{
  constructor(
    initToken: InitToken,
    valueConstructor: (
      valueInitToken: InitToken,
      key: K,
      ...args: SetArgs
    ) => C,
    keySerializer: Serializer<K> = DefaultSerializer.getInstance(
      initToken.runtime
    ),
    argsSerializer: Serializer<SetArgs> = DefaultSerializer.getInstance(
      initToken.runtime
    )
  ) {
    super(
      initToken,
      Pre(ResettingMutCSet),
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
   * @throws if this.owns(value) is false
   */
  keyOf(value: C): K {
    if (!this.owns(value)) {
      throw new Error("this.owns(value) is false");
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
   * @throws if this.owns(value) is false
   */
  getArgsByValue(value: C): SetArgs {
    if (!this.owns(value)) {
      throw new Error("this.owns(value) is false");
    }
    return this.valueSet.getArgs(value)[1];
  }
}
