import {
  BatchingStrategy,
  BroadcastNetwork,
  Collab,
  CollabEvent,
  CRDTApp,
  CRDTRuntime,
  EventEmitter,
  LoadEvent,
  Optional,
  Pre,
} from "@collabs/collabs";
import { ContainerMessage, HostMessage, LoadMessage } from "./message_types";

class CRDTContainerNetwork implements BroadcastNetwork {
  constructor(private readonly sendFunc: (message: Uint8Array) => void) {}

  onreceive!: (message: Uint8Array) => void;

  send(message: Uint8Array): void {
    this.sendFunc(message);
  }

  save(): Uint8Array {
    return new Uint8Array(0);
  }

  load(_saveData: Optional<Uint8Array>): void {}
}

interface CRDTContainerEventsRecord {
  /**
   * Emitted each time the container's state is changed and
   * is in a reasonable user-facing state
   * (so not in the middle of a transaction).
   *
   * A simple way to keep a GUI in sync with the container is to
   * do `container.on("Change", refreshDisplay)`.
   *
   * Identical to [[CRDTApp]]'s "Change" event.
   */
  Change: CollabEvent;
  /**
   * Emitted at the end of [[CRDTContainer.load]].
   *
   * TODO: note event emitters will be triggered before
   * load returns (including async nextEvent ones, due to
   * Promise queue).
   *
   * TODO: mention a good time to construct views (ref docs).
   *
   * TODO: if skipped is true, it also implies that no
   * messages were delivered by us.
   */
  Load: LoadEvent;
}

// Opt: is replicaID needed?
// Opt: skip expensive CRDTExtraMetadata where possible
// (e.g. causal ordering is guaranteed for us).

/**
 * Replaces CRDTApp for use in a container.
 *
 * TODO: usage: construct (lazily okay but not desirable),
 * registerCollab's, then call [[load]], then start using
 * it as with CRDTApp (draw the state, process user input). Note that unlike
 * in App, you don't need to supply the saveData, and also
 * loading is async. Until it's done, don't send any messages
 * (but you can rely on your host blocking user input,
 * so unless you're sending messages not in response to
 * user input, you don't need to worry).
 *
 * TODO: due to loading possibly delivery messages, may want
 * to wait to add event handlers until after awaiting load.
 * Likewise, can make double-sure to block user input by waiting
 * to connect user input to the state until after then.
 */
export class CRDTContainer extends EventEmitter<CRDTContainerEventsRecord> {
  private readonly network: CRDTContainerNetwork;
  private readonly app: CRDTApp;
  private readonly messagePort: MessagePort;
  /**
   * The ID of the last received message (-1 if none).
   *
   * This counts messages received as a result of loading.
   */
  private lastReceivedID = -1;

  private loadEarlyMessage: LoadMessage | null = null;
  private loadResolve: ((message: LoadMessage) => void) | null = null;

  /**
   * [constructor description]
   * @param hostWindow [description]
   * @param metadata   [description]
   * @param options    [description] Default BatchingStrategy
   * is recommended (let the host decide whether to batch more)
   */
  constructor(
    hostWindow: Window,
    metadata: unknown,
    options?: {
      batchingStrategy?: BatchingStrategy;
      debugReplicaId?: string;
    }
  ) {
    super();

    // Setup a channel with hostWindow.
    const channel = new MessageChannel();
    this.messagePort = channel.port1;
    this.messagePort.onmessage = this.messagePortReceive.bind(this);
    hostWindow.postMessage(null, "*", [channel.port2]);

    this.network = new CRDTContainerNetwork((message) =>
      this.messagePortSend({
        type: "Send",
        message,
        predID: this.lastReceivedID,
      })
    );
    this.app = new CRDTApp(this.network, options);
    this.app.on("Change", (e) => this.emit("Change", e));

    // Send metadata.
    this.messagePortSend({ type: "Metadata", metadata });
  }

  private messagePortSend(message: HostMessage) {
    this.messagePort.postMessage(message);
  }

  private messagePortReceive(e: MessageEvent<ContainerMessage>) {
    switch (e.data.type) {
      case "Receive":
        this.network.onreceive(e.data.message);
        this.lastReceivedID = e.data.id;
        break;
      case "Load":
        // Dispatch the load message where [[load]] can get
        // it. If [[load]] was called already, we pass the message
        // to its Promise resolver, this.loadResolve; else
        // we store it in this.loadMessage.
        if (this.loadResolve !== null) {
          this.loadResolve(e.data);
          this.loadResolve = null;
        } else {
          this.loadEarlyMessage = e.data;
        }
        break;
      case "SaveRequest":
        try {
          const saveData = this.app.save();
          this.messagePortSend({
            type: "Saved",
            saveData,
            lastReceivedID: this.lastReceivedID,
            requestID: e.data.requestID,
          });
        } catch (error) {
          this.messagePortSend({
            type: "SaveRequestFailed",
            requestID: e.data.requestID,
            error,
          });
        }
        break;
      default:
        throw new Error("bad e.data.type: " + e.data);
    }
  }

  registerCollab<C extends Collab>(name: string, preCollab: Pre<C>): C {
    return this.app.registerCollab(name, preCollab);
  }

  /**
   * TODO
   *
   * @return whether loading was skipped, there was no
   * prior save data or further messages.
   */
  async load(): Promise<boolean> {
    // Get the load message from messagePortReceive.
    let loadMessage: LoadMessage;
    if (this.loadEarlyMessage !== null) {
      // loadMessage already arrived.
      loadMessage = this.loadEarlyMessage;
    } else {
      // Not yet arrived; await it.
      loadMessage = await new Promise((resolve) => {
        this.loadResolve = resolve;
      });
    }

    if (loadMessage.skipped) {
      this.app.load(Optional.empty());
    } else {
      // Load latestSaveData, if present.
      // TODO: issue: loading due to saveData won't gen
      // events, but loading due to further messages will.
      // In part., you might see messages before loaded()
      // resolves, but you should (?) ignore them.
      // Need to clarify or working around this.
      if (loadMessage.latestSaveData === null) {
        this.app.load(Optional.empty());
      } else {
        this.app.load(Optional.of(loadMessage.latestSaveData));
      }
      // Deliver further messages (messages in the saved
      // state that didn't make it into latestSaveData).
      loadMessage.furtherMessages.forEach((message) =>
        this.network.onreceive(message)
      );
      // TODO: this could be too late if something weird
      // happens during the above forEach?
      this.lastReceivedID = loadMessage.lastID;
    }
    // Let the host know that loading
    // is complete.
    this.messagePortSend({ type: "Ready" });

    this.emit("Load", {
      skipped: loadMessage.skipped,
    });

    return loadMessage.skipped;
  }

  get runtime(): CRDTRuntime {
    return this.app.runtime;
  }
}