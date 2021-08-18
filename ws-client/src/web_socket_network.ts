import { BroadcastNetwork } from "compoventuals";
import ReconnectingWebSocket from "reconnecting-websocket";

export class WebSocketNetwork implements BroadcastNetwork {
  onReceive!: (message: Uint8Array) => void;
  /**
   * WebSocket for connection to server.
   */
  ws: ReconnectingWebSocket;
  /**
   * Constructor which takes in a webSocketArgs for
   * generating a new WebSocket connection.
   *
   * @param webSocketArgs the argument that
   * use to create a new WebSocket connection.
   * @param group TODO (perhaps instead let multiple groups
   * use the same WebSocketNetwork?)
   */
  constructor(webSocketArgs: string, readonly group: string) {
    /**
     * Open WebSocket connection with server.
     * Register EventListener with corresponding event handler.
     */
    this.ws = new ReconnectingWebSocket(webSocketArgs);
    this.ws.addEventListener("message", this.receiveAction);

    // Send a new message with type == "register"
    let message = JSON.stringify({
      type: "register",
      group: group,
    });
    this.ws.send(message);
  }
  /**
   * Invoke heartbeat function to keep clients alive.
   *
   * TODO:
   * The message sending to server is 'heartbeat' right now.
   * The timeout interval is set to 5000 millionseconds.
   */
  // heartbeat() : void {
  //     setTimeout(() => {
  //         this.ws.send('heartbeat');
  //         this.heartbeat();
  //     }, 5000);
  // }
  /**
   * Parse JSON format data back into myMessage type.
   * Push the message into received message buffer.
   * Check the casuality of all the messages and deliver to application.
   *
   * @param message the MessageEvent from the WebSocket.
   */
  receiveAction = (message: MessageEvent) => {
    // TODO: use Uint8Array directly instead
    // (requires changing options + server)
    // See https://stackoverflow.com/questions/15040126/receiving-websocket-arraybuffer-data-in-the-browser-receiving-string-instead
    let parsed = JSON.parse(message.data) as { group: string; message: string };
    if (parsed.group === this.group) {
      // It's for us
      this.onReceive(new Uint8Array(Buffer.from(parsed.message, "base64")));
    }
  };
  /**
   * The actual send function using underlying WebSocket protocol.
   * @param group the unique string identifier of Group.
   * @param message the message with Uint8Array type.
   */
  send(message: Uint8Array): void {
    let encoded = Buffer.from(message).toString("base64");
    let toSend = JSON.stringify({ group: this.group, message: encoded });
    // TODO: use Uint8Array directly instead
    // (requires changing options + server)
    // See https://stackoverflow.com/questions/15040126/receiving-websocket-arraybuffer-data-in-the-browser-receiving-string-instead
    this.ws.send(toSend);
  }

  save(): Uint8Array {
    // TODO: save the max contiguous number (according to server order)
    // of a message we've already received/sent.
    // Then instead of requesting all old messages on startup,
    // only request ones greater than that number.
    return new Uint8Array();
  }

  load(saveData: Uint8Array) {
    // TODO: see save()
  }
}
