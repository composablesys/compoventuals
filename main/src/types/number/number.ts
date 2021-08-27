import { CNumberComponentMessage } from "../../../generated/proto_compiled";
import { CausalTimestamp, CrdtEvent, CrdtEventsRecord } from "../../core";
import {
  PrimitiveCrdt,
  SemidirectProduct,
  StatefulCrdt,
} from "../../constructions";

export interface CNumberEvent extends CrdtEvent {
  readonly arg: number;
  readonly previousValue: number;
}

export interface CNumberEventsRecord extends CrdtEventsRecord {
  Add: CNumberEvent;
  Mult: CNumberEvent;
}

// Exporting just for tests, it's not exported at top-level
export class CNumberState {
  value: number;
  constructor(readonly initialValue: number) {
    this.value = initialValue;
  }
}

// Exporting just for tests, it's not exported at top-level
export class AddComponent
  extends PrimitiveCrdt<CNumberEventsRecord>
  implements StatefulCrdt<CNumberState>
{
  readonly state: CNumberState;
  constructor(initialState: CNumberState) {
    super();
    this.state = initialState;
  }

  add(toAdd: number) {
    if (toAdd !== 0) {
      let message = CNumberComponentMessage.create({ arg: toAdd });
      let buffer = CNumberComponentMessage.encode(message).finish();
      super.send(buffer);
    }
  }

  protected receivePrimitive(timestamp: CausalTimestamp, message: Uint8Array) {
    let decoded = CNumberComponentMessage.decode(message);
    const previousValue = this.state.value;
    this.state.value += decoded.arg;
    this.emit("Add", {
      timestamp,
      arg: decoded.arg,
      previousValue,
    });
  }

  canGc() {
    return this.state.value === this.state.initialValue;
  }

  savePrimitive(): Uint8Array {
    let message = CNumberComponentMessage.create({
      arg: this.state.value,
    });
    return CNumberComponentMessage.encode(message).finish();
  }

  loadPrimitive(saveData: Uint8Array) {
    this.state.value = CNumberComponentMessage.decode(saveData).arg;
  }
}

// Exporting just for tests, it's not exported at top-level
export class MultComponent
  extends PrimitiveCrdt<CNumberEventsRecord>
  implements StatefulCrdt<CNumberState>
{
  readonly state: CNumberState;
  constructor(initialState: CNumberState) {
    super();
    this.state = initialState;
  }

  mult(toMult: number) {
    if (toMult !== 1) {
      let message = CNumberComponentMessage.create({ arg: toMult });
      let buffer = CNumberComponentMessage.encode(message).finish();
      super.send(buffer);
    }
  }

  protected receivePrimitive(timestamp: CausalTimestamp, message: Uint8Array) {
    let decoded = CNumberComponentMessage.decode(message);
    const previousValue = this.state.value;
    this.state.value *= decoded.arg;
    this.emit("Mult", {
      timestamp,
      arg: decoded.arg,
      previousValue,
    });
  }

  canGc() {
    return this.state.value === this.state.initialValue;
  }

  // It is okay to do nothing because in CNumber,
  // AddComponent will deserialize the state for you.
  savePrimitive(): Uint8Array {
    return new Uint8Array();
  }

  loadPrimitive(_saveData: Uint8Array) {}
}

/**
 * Warning: eventual consistency is not guaranteed due
 * to floating-point rounding errors, which can violate
 * associativity, commutativity, or distributivity.
 */
export class CNumber extends SemidirectProduct<
  CNumberState,
  CNumberEventsRecord
> {
  private addCrdt: AddComponent;
  private multCrdt: MultComponent;
  constructor(initialValue: number = 0) {
    super(false);
    const state = new CNumberState(initialValue);
    this.addCrdt = new AddComponent(state);
    this.multCrdt = new MultComponent(state);
    super.setup(this.addCrdt, this.multCrdt, state);

    // Events
    this.addCrdt.on("Add", (event) => super.emit("Add", event));
    this.multCrdt.on("Mult", (event) => super.emit("Mult", event));
  }

  protected action(
    _m2TargetPath: string[],
    _m2Timestamp: CausalTimestamp | null,
    m2Message: Uint8Array,
    _m1TargetPath: string[],
    _m1Timestamp: CausalTimestamp,
    m1Message: Uint8Array
  ): { m1TargetPath: string[]; m1Message: Uint8Array } | null {
    let m2Decoded = CNumberComponentMessage.decode(m2Message);
    let m1Decoded = CNumberComponentMessage.decode(m1Message);
    let acted = CNumberComponentMessage.create({
      arg: m2Decoded.arg * m1Decoded.arg,
    });
    return {
      m1TargetPath: [],
      m1Message: CNumberComponentMessage.encode(acted).finish(),
    };
  }

  add(toAdd: number) {
    this.addCrdt.add(toAdd);
  }

  mult(toMult: number) {
    this.multCrdt.mult(toMult);
  }

  get value(): number {
    // Although -0 === 0, some notions of equality
    // (in particular chai's assert.deepStrictEqual)
    // treat them differently.  This is a hack to prevent
    // -0 vs 0 from violating EC under this equality def.
    // It might be related to general floating point
    // noncommutativity and may go away once we fix that.
    return this.state.internalState.value === -0
      ? 0
      : this.state.internalState.value;
  }
}