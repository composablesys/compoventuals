import { CausalTimestamp } from "../../net";
import { PrimitiveCrdt } from "../core";
import { MakeAbstractCBoolean } from "./abstract_boolean";
import { CBoolean } from "./interfaces";

// TODO: Resettable version?  Might need CCounter construction.
// TODO: custom Toggle event?

export class ToggleCBoolean
  extends MakeAbstractCBoolean(PrimitiveCrdt)<{
    value: boolean;
  }>
  implements CBoolean
{
  constructor(private readonly initialValue = false) {
    super({ value: initialValue });
  }

  set value(value: boolean) {
    if (value !== this.value) this.toggle();
  }

  get value(): boolean {
    return this.state.value;
  }

  toggle() {
    this.send(new Uint8Array());
  }

  protected receivePrimitive(
    _timestamp: CausalTimestamp,
    message: Uint8Array
  ): void {
    if (message.length !== 0)
      throw new Error("Unexpected nontrivial message for ToggleCBoolean");
    this.state.value = !this.state.value;
  }

  protected savePrimitive(): Uint8Array {
    // Length 0 for false, 1 for true
    if (this.value) return new Uint8Array();
    else return new Uint8Array(1);
  }

  protected loadPrimitive(saveData: Uint8Array): void {
    this.value = saveData.length !== 0;
  }

  canGc(): boolean {
    return this.value === this.initialValue;
  }
}