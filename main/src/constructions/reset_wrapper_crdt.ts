import { Resettable } from "../abilities";
import { CausalTimestamp, CrdtEventsRecord } from "../core";
import { PrimitiveCrdt } from "./primitive_crdt";
import { SemidirectProduct, StatefulCrdt } from "./semidirect_product";

// TODO: revise whole file (probably just remove)

// TODO: ResettableCompositeCrdt (implement reset for you)

/**
 * A state for a StatefulCrdt that can be "reset", restoring its
 * state to some fixed reset value (e.g., the initial state).  The reset
 * is a local, sequential operation, not a Crdt operation; it is not
 * replicated and does not need to worry about concurrent operations.
 */
export interface LocallyResettableState {
  /**
   * Reset the state to a fixed value depending only on the enclosing
   * Crdt's constructor arguments, not on the history of Crdt operations
   * or calls to this method.  Typically this will restore the state
   * to its initial value set in the Crdt constructor.
   * This method should also dispatch events describing
   * the changes leading to the new state, using the
   * given timestamp.
   *
   * This method is used by the resetting Crdt constructions to perform local,
   * sequential (non-Crdt) reset operations.
   */
  resetLocalState(timestamp: CausalTimestamp): void;
}

class ResetComponentMessage extends Uint8Array {
  readonly isResetComponentMessage = true;
  // TODO: named params?
  replay: [string[], CausalTimestamp | null, Uint8Array][] = [];
  outOfOrderMessage: Uint8Array | null = null;
}

class ResetComponent<S extends LocallyResettableState>
  extends PrimitiveCrdt
  implements StatefulCrdt<S>
{
  // This state will get overwritten by original's state
  readonly state!: S;

  constructor(readonly resetWrapperCrdt: ResetWrapperCrdt<S, StatefulCrdt<S>>) {
    super();
  }

  resetTarget() {
    super.send(new Uint8Array());
  }

  protected receivePrimitive(
    timestamp: CausalTimestamp,
    message: Uint8Array | ResetComponentMessage
  ) {
    if (message.length !== 0)
      throw new Error("Unexcepted nontrivial message for ResetComponent");
    this.resetWrapperCrdt.original.state.resetLocalState(timestamp);
    if ("isResetComponentMessage" in message) {
      // Replay message.replay
      for (let toReplay of message.replay) {
        // toReplay[1] is only null if keepTimestamps
        // was set to false, in which case original
        // promises not to look at it anyway, hence this
        // is okay.  TODO: type-safe way to do this?
        this.resetWrapperCrdt.original.receive(
          toReplay[0],
          toReplay[1]!,
          toReplay[2]
        );
      }
    }
  }

  canGc() {
    return true;
  }

  savePrimitive(): Uint8Array {
    return new Uint8Array();
  }

  loadPrimitive(_saveData: Uint8Array) {}
}

// TODO: rename ResetWrapper; same for StrongResetWrapper
export class ResetWrapperCrdt<
    S extends LocallyResettableState,
    C extends StatefulCrdt<S>,
    Events extends CrdtEventsRecord = CrdtEventsRecord
  >
  extends SemidirectProduct<S, Events>
  implements Resettable
{
  private resetComponent!: ResetComponent<S>;
  // TODO: make original protected?  Must then also pass to
  // resetComponent.
  /**
   * @param keepOnlyMaximal=false Store only causally maximal
   * messages in the history, to save space (although possibly
   * at some CPU cost).  This is only allowed if the state
   * only ever depends on the causally maximal messages.
   * @param keepTimestamps=true If false, when replaying messages after
   * a reset, replace their timestamps with null.  That is only
   * allowed if original and its descendants never use timestamps
   * in their receive methods.  Setting this to false saves storage space
   * by not storing timestamps in the history.
   * TODO: issue: timestamps are always used in events,
   * now they'll be null.  Although they're kind of weird
   * in resets anyway.
   */
  constructor(
    readonly original: C,
    keepOnlyMaximal = false,
    keepTimestamps = true
  ) {
    super(keepTimestamps, true, keepOnlyMaximal);
    this.resetComponent = new ResetComponent(this);
    super.setup(this.resetComponent, original, original.state);
  }

  protected action(
    m2TargetPath: string[],
    m2Timestamp: CausalTimestamp | null,
    m2Message: Uint8Array,
    m1TargetPath: string[],
    _m1Timestamp: CausalTimestamp,
    m1Message: Uint8Array
  ) {
    if (!("isResetComponentMessage" in m1Message)) {
      m1Message = new ResetComponentMessage();
    }
    (m1Message as ResetComponentMessage).replay.push([
      m2TargetPath.slice(),
      m2Timestamp,
      m2Message,
    ]);
    return { m1TargetPath, m1Message };
  }

  reset() {
    this.resetComponent.resetTarget();
  }
}

/**
 * TODO.  Input Base is a class (technically, constructor);
 * output is a class with type param <Events extends ResettableEventsRecord>, same constructor args,
 * class extending ResetWrapperCrdt<S, C, Events>.
 */
export function ResetWrapClass<
  S extends LocallyResettableState,
  C extends StatefulCrdt<S>,
  Args extends any[]
>(
  Base: new (...args: Args) => C,
  keepOnlyMaximal = false,
  keepTimestamps = true
): new <Events extends CrdtEventsRecord>(...args: Args) => ResetWrapperCrdt<
  S,
  C,
  Events
> {
  return class ResetWrapped<
    Events extends CrdtEventsRecord
  > extends ResetWrapperCrdt<S, C, Events> {
    constructor(...args: Args) {
      let original = new Base(...args);
      super(original, keepOnlyMaximal, keepTimestamps);
    }
  };
}