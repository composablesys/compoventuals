import { Collab, CollabEventsRecord, MetaRequest, UpdateMeta } from "../core";

/**
 * Convenience superclass for a primitive [[Collab]] (Collab with no children, i.e., leaf in the Collab tree).
 *
 * This class provides simplified send and receive methods,
 * [[sendPrimitive]] and [[receivePrimitive]]), and
 * implements [[Collab]] methods that are not relevant to primitive Collabs.
 */
export abstract class CPrimitive<
  Events extends CollabEventsRecord = CollabEventsRecord
> extends Collab<Events> {
  /**
   * Broadcast a message to other replicas of this Collab.
   *
   * Use this method instead of [[Collab.send]].
   *
   * @param message
   * @param metaRequest
   */
  protected sendPrimitive(message: Uint8Array, metaRequest?: MetaRequest) {
    this.send([message], metaRequest === undefined ? [] : [metaRequest]);
  }

  /**
   * Do not override this method; instead override
   * [[receivePrimitive]].
   *
   * If you need to override this method instead of
   * [[receivePrimitive]], consider extending [[Collab]]
   * directly instead of this class.
   *
   * @param  messageStack [description]
   * @return             [description]
   */
  receive(messageStack: Uint8Array[], meta: UpdateMeta): void {
    if (messageStack.length !== 1) {
      // We are not the target
      throw new Error("CPrimitive received message for child");
    }
    this.receivePrimitive(messageStack[0], meta);
  }

  /**
   * Receives messages sent by [[send]]
   * on local and replica replicas of this [[CPrimitive]].
   *
   * @param  meta  [description]
   * @param  message    [description]
   */
  protected abstract receivePrimitive(
    message: Uint8Array,
    meta: UpdateMeta
  ): void;

  getDescendant(namePath: Iterator<string>): Collab | undefined {
    const next = namePath.next();
    if (!next.done) {
      throw new Error(
        `CPrimitive has no descendants, but namePath starts with "${next.value}"`
      );
    }
    return this;
  }
}
