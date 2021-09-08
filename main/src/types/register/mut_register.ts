import { Resettable } from "../../abilities";
import { CObject } from "../../constructions";
import { Crdt, CrdtInitToken, Pre } from "../../core";
import {
  ElementSerializer,
  DefaultElementSerializer,
  Optional,
  CrdtSerializer,
} from "../../util";
import { DeletingMutCSet } from "../set";
import { CRegisterEntryMeta } from "./aggregate_register";
import { CRegister, CRegisterEventsRecord } from "./interfaces";
import { OptionalLwwCRegister } from "./wins_registers";

export class MutCRegisterFromRegister<
    C extends Crdt,
    SetArgs extends any[],
    Value,
    RegT extends CRegister<Value, [C]>,
    Events extends CRegisterEventsRecord<Value> = CRegisterEventsRecord<Value>
  >
  extends CObject<Events>
  implements CRegister<Value, SetArgs>
{
  protected readonly crdtFactory: DeletingMutCSet<C, SetArgs>;
  protected readonly register: RegT;

  /**
   * Note initial value behavior
   * depends on that of the register returned by
   * registerCallback.
   *
   * @param registerCallback [description]
   */
  constructor(
    initToken: CrdtInitToken,
    registerCallback: (valueSerializer: ElementSerializer<C>) => Pre<RegT>,
    valueConstructor: (valueInitToken: CrdtInitToken, ...args: SetArgs) => C,
    argsSerializer: ElementSerializer<SetArgs> = DefaultElementSerializer.getInstance()
  ) {
    super(initToken);
    this.crdtFactory = this.addChild(
      "",
      Pre(DeletingMutCSet)(valueConstructor, [], argsSerializer)
    );
    this.register = this.addChild(
      "0",
      registerCallback(new CrdtSerializer(this.crdtFactory))
    );

    // Events
    this.register.on("Set", (event) => this.emit("Set", event));
  }

  set(...args: SetArgs): Value {
    this.crdtFactory.clear();
    return this.register.set(this.crdtFactory.add(...args));
  }

  get value(): Value {
    return this.register.value;
  }

  owns(value: C): boolean {
    return this.crdtFactory.owns(value);
  }

  /**
   * [getArgs description]
   * @param  value [description]
   * @return the SetArgs used to set value
   * @throws if value has been superseded by a causally
   * greater set value
   */
  getArgsByValue(value: C): SetArgs {
    return this.crdtFactory.getArgs(value);
  }

  /**
   * @return this.value + ""
   */
  toString(): string {
    return this.value + "";
  }
}

export class LwwMutCRegister<C extends Crdt, SetArgs extends any[]>
  extends MutCRegisterFromRegister<
    C,
    SetArgs,
    Optional<C>,
    OptionalLwwCRegister<C>
  >
  implements Resettable
{
  constructor(
    initToken: CrdtInitToken,
    valueConstructor: (valueInitToken: CrdtInitToken, ...args: SetArgs) => C,
    argsSerializer: ElementSerializer<SetArgs> = DefaultElementSerializer.getInstance()
  ) {
    super(
      initToken,
      Pre(OptionalLwwCRegister),
      valueConstructor,
      argsSerializer
    );
  }

  conflicts(): C[] {
    return this.register.conflicts();
  }

  conflictsMeta(): CRegisterEntryMeta<C>[] {
    return this.register.conflictsMeta();
  }

  reset() {
    this.crdtFactory.reset();
    this.register.reset();
  }

  /**
   * [getArgs description]
   * @return an Optional of the SetArgs used to set this.value
   * (empty if this.value is an empty Optional)
   */
  getArgs(): Optional<SetArgs> {
    const value = this.value;
    if (value.isPresent) return Optional.of(super.getArgsByValue(value.get()));
    else return Optional.empty();
  }
}
