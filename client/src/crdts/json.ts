import {
    Crdt,
    CompositeCrdt,
    CrdtEvent,
    CrdtEventsRecord,
  } from "./crdt_core";
import { MultiValueRegister } from "./basic_crdts";
import { MapCrdt } from "./standard";

export interface JsonEvent extends CrdtEvent {
    readonly key: string;
    readonly value: Crdt;
  }

export interface JsonEventsRecord extends CrdtEventsRecord {
    Add: JsonEvent;
    Change: JsonEvent;
    Delete: JsonEvent;
  }

export class JsonCrdt extends CompositeCrdt<JsonEventsRecord> {
    private readonly internalNumberMap: MapCrdt<string, MultiValueRegister<Number>>;
    private readonly internalStringMap: MapCrdt<string, MultiValueRegister<string>>;
    private cursor;

    constructor() {
        super();
        this.internalNumberMap = new MapCrdt(() => new MultiValueRegister());
        this.internalStringMap = new MapCrdt(() => new MultiValueRegister());
        this.cursor = "";
    }

    set(key : string, val : any) {
        switch (typeof val) {
            case "string":
                let mvr_str = this.internalStringMap.getForce(this.cursor + key);
                if (mvr_str) mvr_str.value = val;
                break;

            case "number":
                let mvr_num = this.internalNumberMap.getForce(this.cursor + key);
                if (mvr_num) mvr_num.value = val;
                break;
        }
    }

    get(key : string) : any[] {
        this.cursor += (":" + key);

        let vals : any[] = [];
        let val;

        val = this.internalStringMap.get(this.cursor + key)
        if (val) vals.push(val);
        
        val = this.internalNumberMap.get(this.cursor + key)
        if (val) vals.push(val);

        return vals;
    }

    delete(key : string) {
        this.internalStringMap.delete(key);
        this.internalNumberMap.delete(key);
    }

    keys() : string[] {
        return [...this.internalStringMap.keys()].concat([...this.internalNumberMap.keys()]);
    }

    resetCursor() {
        this.cursor = "";
    }
}