import { CrdtRuntime } from './crdt_runtime_interface';
import { VectorClock } from './vector_clock';
import WebSocket = require("ws");


// The casual broadcast network designed for a two-way interactive 
// communication session between user and server using WebSocket API.
//
// Also ensure the order of delivery with casuality check. 

/**
 * Customized message event that travel through 
 * casualbroadcast network.
 */
export class myMessage {
    /**
     * Crdt update message.
     */
    message : any;
    /**
     * Unique crdtId for identification.
     */
    crdtId : any;
    /**
     * Timestamp for casuality/concurrency check.
     * 
     * Provide basic functions such as :
     * getSender() / getSenderCounter() / asVectorClock().
     */
    timestamp : VectorClock;

    constructor (message : any, crdtId : any, timestamp : VectorClock) {
        this.message = message;
        this.crdtId = crdtId;
        this.timestamp = timestamp;
    }
    /**
     * customized toJSON function to convert message as JSON format.
     * 
     * @returns package info in JSON format.
     */
    toJSON() : string {
        return JSON.stringify(
            {   "message" : this.message, 
                "crdtId" : this.crdtId, 
                "timestamp" : {
                    "uid" : this.timestamp.uid,
                    "vectorMap" : Array.from(this.timestamp.vectorMap.entries())
                }
            }
        );
    }
}

/**
 * CasualBroadcastNetwork: 
 * 
 * Process initialization when starting a new user node.
 * 
 * Communicate with CRDT's runtime and send/receive message via 
 * central broadcast server with WebSocket protocol.
 * 
 * Perform casuality check to ensure message ordering.
 */
export class CasualBroadcastNetwork {
    /**
     * Unique ID for replica for identification.
     */
    uid : any;
    /**
     * WebSocket for connection to server.
     */
    ws : WebSocket;
    /**
     * Map stores all crdtId with its corresponding vector clock.
     */
    vcMap : Map<any, VectorClock>;
    /**
     * Message buffer to store received message to ensure casual delivery.
     */
    messageBuffer : Array<[any, any, VectorClock]>;
    /**
     * Message waiting to be sent by the WebSocket
     */
    sendBuffer : Array<myMessage>;
    /**
     * Register CrdtRuntime at CasualBroadcastNetwork layer.
     */
    crdtRuntime : CrdtRuntime;

    constructor (replicaId: any, crdtRuntime: CrdtRuntime) {
        this.uid = replicaId;
        this.vcMap = new Map<any, VectorClock>();
        this.messageBuffer = new Array<[any, any, VectorClock]>();
        this.sendBuffer = new Array<myMessage>();
        this.crdtRuntime = crdtRuntime;
        /**
         * Open WebSocket connection with server.
         * Register EventListener with corresponding event handler.
         */
        this.ws = new WebSocket("ws://localhost:8080");
        this.ws.addEventListener('open', this.sendAction);
        this.ws.addEventListener('message', this.receiveAction);
    }
    /**
     * @param ms the time in millionsecond to wait.
     */
    myWait(ms : number){
        var start = new Date().getTime();
        var end = start;
        while(end < start + ms) {
          end = new Date().getTime();
       }
      }
    /**
     * Check if the send message buffer has any message waiting to be sent.
     * If there exist, then send it via WebSocket and remove the item from buffer.
     * If not, then wait a customized time period and check again.
     */
    sendAction = () => {
        while (this.sendBuffer.length != 0) {
            this.ws.send(this.sendBuffer[0].toJSON());
            this.sendBuffer.splice(0, 1);
        }  
    }
    /**
     * Parse JSON format data back into myMessage type. 
     * Push the message into received message buffer.
     * Check the casuality of all the messages and deliver to application.
     * 
     * @param data the JSON format data send via network 
     */
    receiveAction = (data : any) => {
        let myPackage = this.parseJSON(data.data);
        this.messageBuffer.push([myPackage.message, myPackage.crdtId, myPackage.timestamp]);
        this.checkMessageBuffer();        
    };
    /**
     * Send function on casualbroadcast network layer, which called 
     * by crdt's runtime layer.
     * 
     * The message is wrapped with its corresponding timestamp (basic sender node 
     * info and vector clock).
     * 
     * Using WebSocket as network transmission protocol.
     * Using JSON format as message type.
     * 
     * @param message the crdt update message.
     * @param crdtId the unique ID for each crdt.
     */
    sendMessage(message : any, crdtId : any) : void{
        // Check if the crdtId exist in the map.
        if (this.vcMap.has(crdtId)) {
            this.vcMap.get(crdtId)!.increment();
        } else {
            this.vcMap.set(crdtId, new VectorClock(this.uid));
            this.vcMap.get(crdtId)!.increment();
        }

        // Convert the message into JSON 
        let vcCopy = this.vcMap.get(crdtId);
        let myPackage = new myMessage(message, crdtId, vcCopy!);
        this.sendBuffer.push(myPackage);
    }
    /**
     * Parse JSON format data back to customized data type.
     * 
     * @param data the JSON format data travel through network.
     * @returns the customized data type => myMessage
     */
    parseJSON(data : string) : myMessage {
        let dataJSON = JSON.parse(data);
        let vc = new VectorClock(dataJSON.timestamp.uid);
        vc.vectorMap = new Map(dataJSON.timestamp.vectorMap);
        let myPackage = new myMessage(dataJSON.message, dataJSON.crdtId, vc);
        
        return myPackage;
    }
    /**
     * Check the casuality of buffered message and delivery the 
     * messages which are ready.
     * 
     * Update the VectorClock entry and MessageBuffer.
     */
    checkMessageBuffer() : void {
        let index = this.messageBuffer.length - 1;
        
        while(index >= 0) {
            let curCrdtId = this.messageBuffer[index][1];
            let curVectorClock = this.messageBuffer[index][2];

            if (!this.vcMap.has(curCrdtId)) {
                this.messageBuffer.splice(index, 1);
            } else {
                let myVectorClock = this.vcMap.get(curCrdtId);

                if (myVectorClock?.isready(curVectorClock)) {
                    myVectorClock.merge(curVectorClock);

                    // TODO: Return back to Runtime
                    // this.crdtRuntime.receive();
                    this.messageBuffer.splice(index, 1);
                    console.log("Client:", this.uid, "VectorClock: \n", this.vcMap);
                    console.log("================================================")
                }
            }
            index--;
        }
    }
}