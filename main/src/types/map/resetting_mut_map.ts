import { DefaultElementSerializer, ElementSerializer } from "../../util";
import { Crdt, CrdtInitToken } from "../../core";
import { Resettable } from "../../abilities";
import { ResettingMutCSet } from "../set";
import { LwwCMap } from "./lww_map";
import { MutCMapFromSet } from "./mut_map_from_set";

export class ResettingMutCMap<
    K,
    C extends Crdt & Resettable,
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
        new ResettingMutCSet(setValueConstructor, setArgsSerializer),
      (mapKeySerializer, mapValueSerializer) =>
        new LwwCMap(mapKeySerializer, mapValueSerializer),
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
}
