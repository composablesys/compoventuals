import { CasualBroadcastNetwork } from '../src/casual_broadcast_network';
import assert = require('assert');
import WebSocket = require('ws');

console.log('Test Starting... ')

// function wait(ms:number){
//     var start = new Date().getTime();
//     var end = start;
//     while(end < start + ms) {
//       end = new Date().getTime();
//    }
//  }

// class TestRunTime implements CrdtRuntime {
//     constructor() { }
//     send(message: any, crdtId: any): void {;}
//     register(crdtMessageListener: CrdtMessageListener, crdtId: any): void {;}
//     getReplicaId(): any {return null};
//     getNextTimestamp(): CausalTimestamp {
//         return {
//             getSender() { return null; },
//             getSenderCounter() { return 0;},
//             asVectorClock() { return new Map<any, number>(); }}
//     };
// }

// let crdt_1 = new TestRunTime();
// let crdt_2 = new TestRunTime();
// let crdt_3 = new TestRunTime();
// let casual_broadcast_network_1 = new CasualBroadcastNetwork(1, crdt_1);
// let casual_broadcast_network_2 = new CasualBroadcastNetwork(2, crdt_2);
// let casual_broadcast_network_3 = new CasualBroadcastNetwork(3, crdt_3);
// casual_broadcast_network_1.vcMap.set("counter_ID", new VectorClock(1));
// casual_broadcast_network_2.vcMap.set("counter_ID", new VectorClock(2));
// casual_broadcast_network_3.vcMap.set("counter_ID", new VectorClock(3));
// casual_broadcast_network_2.sendMessage("Hi layer 2!", "counter_ID");
// casual_broadcast_network_1.sendMessage("hello layer 1", "counter_ID");
// casual_broadcast_network_3.sendMessage("hello all", "counter_ID");
// casual_broadcast_network_2.sendMessage("Welcome layer 3!", "counter_ID");

console.log('Test Case 1...')
console.log('----------------------------------------------')

function test1(resolve : any, reject : any) {

    let casual_broadcast_network_1 = new CasualBroadcastNetwork(1);
    let casual_broadcast_network_2 = new CasualBroadcastNetwork(2);
    let casual_broadcast_network_3 = new CasualBroadcastNetwork(3);

    casual_broadcast_network_1.registerCrdtId("counter_ID");
    casual_broadcast_network_2.registerCrdtId("counter_ID");
    casual_broadcast_network_3.registerCrdtId("counter_ID");

    casual_broadcast_network_2.sendMessage("Hi layer 2!", "counter_ID");
    casual_broadcast_network_1.sendMessage("hello layer 1", "counter_ID");
    casual_broadcast_network_3.sendMessage("hello all", "counter_ID");
    casual_broadcast_network_2.sendMessage("Welcome layer 3!", "counter_ID");

    setTimeout(function () {
        if (casual_broadcast_network_1.vcMap.get("counter_ID")?.asVectorClock().get(1) == 1 &&
            casual_broadcast_network_1.vcMap.get("counter_ID")?.asVectorClock().get(2) == 2 &&
            casual_broadcast_network_1.vcMap.get("counter_ID")?.asVectorClock().get(3) == 1 &&
            casual_broadcast_network_2.vcMap.get("counter_ID")?.asVectorClock().get(1) == 1 &&
            casual_broadcast_network_2.vcMap.get("counter_ID")?.asVectorClock().get(2) == 2 &&
            casual_broadcast_network_2.vcMap.get("counter_ID")?.asVectorClock().get(3) == 1 &&
            casual_broadcast_network_3.vcMap.get("counter_ID")?.asVectorClock().get(1) == 1 &&
            casual_broadcast_network_3.vcMap.get("counter_ID")?.asVectorClock().get(2) == 2 &&
            casual_broadcast_network_3.vcMap.get("counter_ID")?.asVectorClock().get(3) == 1 ){
            
            console.log("Network1: ", casual_broadcast_network_1.vcMap);
            console.log("Network2: ", casual_broadcast_network_2.vcMap);
            console.log("Network3: ", casual_broadcast_network_3.vcMap);
                
            casual_broadcast_network_1.sendMessage("hello layer 1/1", "counter_ID");
            
            setTimeout(function () {
                if (casual_broadcast_network_2.vcMap.get("counter_ID")?.asVectorClock().get(1) == 2 &&
                    casual_broadcast_network_2.vcMap.get("counter_ID")?.asVectorClock().get(2) == 2 &&
                    casual_broadcast_network_2.vcMap.get("counter_ID")?.asVectorClock().get(3) == 1 ) {
                    resolve();
                } else {
                    reject();
                }   
            }, 1000);
        }
    }, 1000);
}

var p1 = new Promise(test1);

p1.then(function () {
    console.log('----------------------------------------------')
    console.log('Test 1 passed!!!');
    process.exit();
});
p1.catch(function () {
    console.log('----------------------------------------------')
    console.log('Test 1 failed...');
    process.exit();
});



// console.log('Case 2')
// casual_broadcast_network_1.vcMap.set("multi_ID", new VectorClock(1));
// casual_broadcast_network_2.vcMap.set("multi_ID", new VectorClock(2));
// casual_broadcast_network_3.vcMap.set("multi_ID", new VectorClock(3));
// casual_broadcast_network_2.sendMessage("Hi layer 2!", "multi_ID");
// casual_broadcast_network_1.sendMessage("hello layer 1", "multi_ID");
// casual_broadcast_network_3.sendMessage("hello all", "multi_ID");
// casual_broadcast_network_2.sendMessage("Welcome layer 3!", "multi_ID");
// casual_broadcast_network_2.sendMessage("Let's begin chat!", "multi_ID");
// casual_broadcast_network_1.sendMessage("sure!", "multi_ID");
// let vc_mult_1 = casual_broadcast_network_1.vcMap;
// let vc_mult_2 = casual_broadcast_network_2.vcMap;
// let vc_mult_3 = casual_broadcast_network_3.vcMap;
// assert.equal(vc1.get("multi_ID")?.asVectorClock().get(1), 1);
// assert.equal(vc2.get("multi_ID")?.asVectorClock().get(2), 3);
// assert.equal(vc3.get("multi_ID")?.asVectorClock().get(3), 1);
// console.log('OK..! Case 2 pass')
