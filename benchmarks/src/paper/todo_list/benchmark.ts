import * as crdts from "compoventuals";
import {
  JsonElement,
  JsonArray,
  JsonObject,
  TextWrapper,
} from "compoventuals-json";
import { JsonCrdt, JsonCursor } from "compoventuals-json-opt";
import seedrandom from "seedrandom";
import Automerge from "automerge";
import * as Y from "yjs";
import util from "util";
import { result10000 } from "./results";
import { assert } from "chai";
import zlib from "zlib";
import {
  getRecordedTrials,
  getWarmupTrials,
  getMemoryUsed,
  record,
  sleep,
} from "../record";

const DEBUG = false;

// Experiment params
const SEED = "42";
const ROUND_OPS = 1000;
const OPS = 10000;

const GZIP = false;

/**
 * Interface used by the benchmark.
 */
interface ITodoList {
  addItem(index: number, text: string): void;
  deleteItem(index: number): void;
  getItem(index: number): ITodoList;
  readonly itemsSize: number;

  // Note used at top-level; default to false there
  done: boolean;

  // Not used at top-level; default to "" there
  insertText(index: number, text: string): void;
  deleteText(index: number, count: number): void;
  readonly textSize: number;
  getText(): string;
}

interface ITestFactory {
  newTodoList(rng: seedrandom.prng): ITodoList;
  /**
   * Free old state so that it can be GC'd.
   */
  cleanup(): void;
  /**
   * Cause a message summarizing the most recent changes to be "sent"
   * and its size records in getSentBytes().  This is called after each
   * op.
   */
  sendNextMessage(): void;
  /**
   * Reset this on each call to newTodoList()
   */
  getSentBytes(): number;
  /**
   * Save the current state as saveData.  Also return
   * the length of the saveData in bytes.
   *
   * Load will be called soon after save.
   *
   * This will be timed, so don't do excessive extra work
   * that wouldn't be part of normal saving.
   */
  save(): [saveData: any, byteLength: number];
  /**
   * Like newTodoList, but also load the state from
   * saveData.  In particular, use a new replica id
   * (rng is provided for this).
   *
   * This will be timed, so don't do excessive extra work
   * that wouldn't be part of normal loading.
   *
   * Don't worry about resetting getSentBytes since it
   * won't be measured anyway.
   */
  load(saveData: any, rng: seedrandom.prng): ITodoList;
}

class TodoListBenchmark {
  constructor(
    private readonly testName: string,
    private readonly testFactory: ITestFactory
  ) {}

  private rng!: seedrandom.prng;

  async run(
    measurement: "time" | "memory" | "network" | "save",
    frequency: "whole" | "rounds"
  ) {
    console.log("Starting todo_list test: " + this.testName);

    let results = new Array<{ [measurement: string]: number }>(
      getRecordedTrials()
    );
    let roundResults = new Array<{ [measurement: string]: number }[]>(
      getRecordedTrials()
    );
    let roundOps = new Array<number>(Math.ceil(OPS / ROUND_OPS));
    let baseMemories = new Array<number>(getRecordedTrials());
    if (frequency === "rounds") {
      for (let i = 0; i < getRecordedTrials(); i++)
        roundResults[i] = new Array<{ [measurement: string]: number }>(
          Math.ceil(OPS / ROUND_OPS)
        );
    }

    let startingBaseline = 0;
    if (measurement === "memory") startingBaseline = await getMemoryUsed();

    for (let trial = -getWarmupTrials(); trial < getRecordedTrials(); trial++) {
      if (trial !== -getWarmupTrials()) this.testFactory.cleanup();

      // Sleep between trials
      await sleep(1000);
      console.log("Starting trial " + trial);

      this.rng = seedrandom(SEED);
      const replicaIdRng = seedrandom(SEED + SEED);

      let startTime: bigint;
      let startSentBytes = 0;
      let baseMemory = 0;

      if (measurement === "memory") {
        baseMemory = await getMemoryUsed();
        if (trial >= 0) baseMemories[trial] = baseMemory;
      }

      // TODO: should we include setup in the time recording?
      let list = this.testFactory.newTodoList(replicaIdRng);

      switch (measurement) {
        case "time":
          startTime = process.hrtime.bigint();
          break;
        case "network":
          startSentBytes = this.testFactory.getSentBytes();
      }

      let round = 0;
      let op: number;
      for (op = 0; op < OPS; op++) {
        if (frequency === "rounds" && op !== 0 && op % ROUND_OPS === 0) {
          // Record result
          let ans: { [measurement: string]: number } = {};
          switch (measurement) {
            case "time":
              ans[measurement] = new Number(
                process.hrtime.bigint() - startTime!
              ).valueOf();
              break;
            case "memory":
              ans[measurement] = await getMemoryUsed();
              break;
            case "network":
              ans[measurement] =
                this.testFactory.getSentBytes() - startSentBytes;
              break;
            case "save":
              let beforeSave: Object;
              if (DEBUG) beforeSave = this.toObject(list, true);
              const saveStartTime = process.hrtime.bigint();
              const [saveData, saveSize] = this.testFactory.save();
              const saveTime = new Number(
                process.hrtime.bigint() - saveStartTime!
              ).valueOf();
              this.testFactory.cleanup();
              const loadStartTime = process.hrtime.bigint();
              list = this.testFactory.load(saveData, replicaIdRng);
              const loadTime = new Number(
                process.hrtime.bigint() - loadStartTime!
              ).valueOf();
              ans = {
                saveTime,
                saveSize,
                loadTime,
              };
              if (DEBUG) {
                const afterSave = this.toObject(list, true);
                assert.deepStrictEqual(
                  beforeSave!,
                  afterSave,
                  "afterSave did not equal beforeSave"
                );
              }
              break;
          }
          if (trial >= 0) roundResults[trial][round] = ans;
          roundOps[round] = op;
          round++;
        }

        // Process one edit
        this.randomOp(list);
        this.testFactory.sendNextMessage();
        //if (measurement === "memory") await sleep(0);
      }

      // Record result
      // TODO: de-duplicate code (shared with rounds measurements)
      let result: { [measurement: string]: number } = {};
      switch (measurement) {
        case "time":
          result[measurement] = new Number(
            process.hrtime.bigint() - startTime!
          ).valueOf();
          break;
        case "memory":
          result[measurement] = await getMemoryUsed();
          break;
        case "network":
          result[measurement] =
            this.testFactory.getSentBytes() - startSentBytes;
          break;
        case "save":
          const saveStartTime = process.hrtime.bigint();
          const [saveData, saveSize] = this.testFactory.save();
          const saveTime = new Number(
            process.hrtime.bigint() - saveStartTime!
          ).valueOf();
          this.testFactory.cleanup();
          const loadStartTime = process.hrtime.bigint();
          list = this.testFactory.load(saveData, replicaIdRng);
          const loadTime = new Number(
            process.hrtime.bigint() - loadStartTime!
          ).valueOf();
          result = {
            saveTime,
            saveSize,
            loadTime,
          };
          break;
      }
      if (trial >= 0) {
        switch (frequency) {
          case "whole":
            results[trial] = result;
            break;
          case "rounds":
            roundResults[trial][round] = result;
            roundOps[round] = op;
            break;
        }
      }

      if (DEBUG) {
        console.log("Current state:");
        console.log(
          util.inspect(this.toObject(list, true), {
            depth: null,
            maxArrayLength: null,
            maxStringLength: null,
            colors: true,
          })
        );
      }
      console.log("Total items: " + this.totalItems(list));
      console.log("Max depth: " + (this.maxDepth(list) - 1));

      // TODO: record document size over time, to plot memory against?

      // Check equality
      assert.deepStrictEqual(
        this.toObject(list, true),
        result10000,
        "resulting object did not equal result10000"
      );
    }

    let toRecord: string[];
    switch (measurement) {
      case "save":
        toRecord = ["saveTime", "loadTime", "saveSize"];
        break;
      default:
        toRecord = [measurement];
    }
    for (const oneRecord of toRecord) {
      record(
        "todo_list/" + oneRecord,
        this.testName,
        frequency,
        getRecordedTrials(),
        results.map((result) => result[oneRecord]),
        roundResults.map((trialResult) =>
          trialResult.map((result) => result[oneRecord])
        ),
        roundOps,
        oneRecord === "memory"
          ? baseMemories
          : new Array<number>(getRecordedTrials()).fill(0),
        startingBaseline
      );
    }
  }

  private choice(options: number) {
    return Math.floor(this.rng() * options);
  }

  private randomItem(startList: ITodoList, excludeStart: boolean): ITodoList {
    if (excludeStart) {
      if (startList.itemsSize === 0) {
        throw new Error("excludeStart is true but startList has no items");
      }
    } else if (startList.itemsSize === 0 || this.choice(2) === 0) {
      return startList;
    }
    return this.randomItem(
      startList.getItem(this.choice(startList.itemsSize)),
      false
    );
  }

  /**
   * Like randomItem(startList, false), but instead of returning the item,
   * it returns
   * its parent and its index within the parent.
   */
  private randomItemLocation(
    startList: ITodoList
  ): [parent: ITodoList, index: number] {
    if (startList.itemsSize === 0) {
      throw new Error("startList has no items");
    }
    let randomIndex = this.choice(startList.itemsSize);
    let child = startList.getItem(randomIndex);
    if (child.itemsSize === 0 || this.choice(2))
      return [startList, randomIndex];
    else return this.randomItemLocation(child);
  }

  private randomText(): string {
    let length = 10 + this.choice(41); //10 to 50
    let ans = "";
    while (ans.length < length) {
      ans += this.rng().toPrecision(Math.min(21, length - ans.length));
    }
    return ans;
  }

  private randomOp(list: ITodoList) {
    // If the top-level list is empty, only "create item" ops are allowed
    let opChoice = this.rng();
    if (list.itemsSize === 0) opChoice = 0;
    if (opChoice < 0.25) {
      // Create item
      let parent = this.randomItem(list, false);
      let index = this.choice(parent.itemsSize + 1);
      parent.addItem(index, this.randomText());
    } else if (opChoice < 0.45) {
      // Insert text in existing item
      let item = this.randomItem(list, true);
      item.insertText(this.choice(item.textSize + 1), this.randomText());
    } else if (opChoice < 0.65) {
      // Delete text in existing item
      let item = this.randomItem(list, true);
      // TODO: skip if item.textSize is 0.  Not changing
      // for now to avoid re-running benchmarks.
      let index = this.choice(item.textSize);
      let count = Math.min(this.choice(41) + 10, item.textSize - index);
      item.deleteText(index, count);
    } else if (opChoice < 0.85) {
      // Toggle "done" on existing item
      let item = this.randomItem(list, true);
      item.done = !item.done;
    } else {
      // Delete an existing item
      let [parent, index] = this.randomItemLocation(list);
      parent.deleteItem(index);
    }
  }

  private toObject(list: ITodoList, topLevel: boolean): Object {
    let obj: any;
    if (topLevel) {
      obj = { items: [] };
    } else {
      obj = {
        text: list.getText(),
        done: list.done,
        items: [],
      };
    }
    for (let i = 0; i < list.itemsSize; i++) {
      obj.items.push(this.toObject(list.getItem(i), false));
    }
    return obj;
  }

  private totalItems(list: ITodoList): number {
    let total = list.itemsSize;
    for (let i = 0; i < list.itemsSize; i++) {
      total += this.totalItems(list.getItem(i));
    }
    return total;
  }

  private maxDepth(list: ITodoList): number {
    let maxSub = 0;
    for (let i = 0; i < list.itemsSize; i++) {
      maxSub = Math.max(maxSub, this.maxDepth(list.getItem(i)));
    }
    return 1 + maxSub;
  }
}

function plainJs() {
  class PlainJsTodoList implements ITodoList {
    private text: string;
    done: boolean;
    private items: PlainJsTodoList[];

    constructor(text: string) {
      this.text = text;
      this.done = false;
      this.items = [];
    }

    addItem(index: number, text: string): void {
      this.items.splice(index, 0, new PlainJsTodoList(text));
    }
    deleteItem(index: number): void {
      this.items.splice(index, 1);
    }
    getItem(index: number): PlainJsTodoList {
      return this.items[index];
    }
    get itemsSize(): number {
      return this.items.length;
    }

    insertText(index: number, text: string): void {
      this.text = this.text.slice(0, index) + text + this.text.slice(index);
    }
    deleteText(index: number, count: number): void {
      this.text = this.text.slice(0, index) + this.text.slice(index + count);
    }
    get textSize(): number {
      return this.text.length;
    }
    getText(): string {
      return this.text;
    }
  }

  let topList: PlainJsTodoList;
  return new TodoListBenchmark("Plain JS array", {
    newTodoList() {
      topList = new PlainJsTodoList("");
      return topList;
    },
    cleanup() {},
    sendNextMessage() {},
    getSentBytes() {
      return 0;
    },
    save() {
      const saveData = JSON.stringify(topList!);
      return [saveData, saveData.length];
    },
    load(saveData: string) {
      // TODO: it's actually not the class itself, just
      // an identical plain Object.
      topList = JSON.parse(saveData) as PlainJsTodoList;
      return topList;
    },
  });
}

function compoCrdt() {
  class CrdtTodoList
    extends crdts.CObject
    implements ITodoList, crdts.Resettable
  {
    private readonly text: crdts.CText;
    private readonly doneCrdt: crdts.TrueWinsCBoolean;
    private readonly items: crdts.ResettingMutCList<CrdtTodoList>;

    constructor(initToken: crdts.CrdtInitToken) {
      super(initToken);
      this.text = this.addChild("text", crdts.Pre(crdts.CText)());
      this.doneCrdt = this.addChild(
        "done",
        crdts.Pre(crdts.TrueWinsCBoolean)()
      );
      this.items = this.addChild(
        "items",
        crdts.Pre(crdts.ResettingMutCList)(
          crdts.ConstructorAsFunction(CrdtTodoList)
        )
      );
    }

    addItem(index: number, text: string): void {
      let item = this.items.insert(index);
      item.insertText(0, text);
    }
    deleteItem(index: number): void {
      this.items.delete(index);
    }
    getItem(index: number): CrdtTodoList {
      return this.items.get(index);
    }
    get itemsSize(): number {
      return this.items.length;
    }

    set done(done: boolean) {
      this.doneCrdt.value = done;
    }
    get done(): boolean {
      return this.doneCrdt.value;
    }

    insertText(index: number, text: string): void {
      this.text.insert(index, ...text);
    }
    deleteText(index: number, count: number): void {
      this.text.delete(index, count);
    }
    get textSize(): number {
      return this.text.length; // Assumes all text registers are one char
    }
    getText(): string {
      return this.text.join("");
    }

    reset() {
      this.text.reset();
      this.doneCrdt.reset();
      this.items.reset();
    }
  }

  let generator: crdts.TestingNetworkGenerator | null;
  let runtime: crdts.Runtime | null;
  let totalSentBytes: number;

  return new TodoListBenchmark("Compo Crdt", {
    newTodoList(rng) {
      generator = new crdts.TestingNetworkGenerator();
      runtime = generator.newRuntime(new crdts.ManualBatchingStrategy(), rng);
      totalSentBytes = 0;
      let list = runtime.registerCrdt("", crdts.Pre(CrdtTodoList)());
      // TODO: this seems unnecessary
      this.sendNextMessage();
      return list;
    },
    cleanup() {
      generator = null;
      runtime = null;
    },
    sendNextMessage() {
      runtime!.commitBatch();
      totalSentBytes += generator!.lastMessage
        ? GZIP
          ? zlib.gzipSync(generator!.lastMessage).byteLength
          : generator!.lastMessage.byteLength
        : 0;
      generator!.lastMessage = undefined;
    },
    getSentBytes() {
      return totalSentBytes;
    },
    save() {
      const saveData = runtime!.save();
      return [saveData, saveData.byteLength];
    },
    load(saveData: Uint8Array, rng) {
      // Proceed like newTodoList, but without doing any
      // operations.
      generator = new crdts.TestingNetworkGenerator();
      runtime = generator.newRuntime(new crdts.ManualBatchingStrategy(), rng);
      let list = runtime.registerCrdt("", crdts.Pre(CrdtTodoList)());
      runtime.load(saveData);
      return list;
    },
  });
}

class CTextRga
  extends crdts.PrimitiveCListFromDenseLocalList<
    string,
    crdts.RgaLoc,
    crdts.RgaDenseLocalList<string>
  >
  implements crdts.Resettable
{
  constructor(initToken: crdts.CrdtInitToken) {
    super(
      initToken,
      new crdts.RgaDenseLocalList<string>(initToken.runtime),
      crdts.TextSerializer.instance,
      crdts.TextArraySerializer.instance
    );
  }

  reset() {
    // Since RgaDenseLocalList has no tombstones,
    // clear is an observed-reset.
    this.clear();
  }
}

class ResettingMutCListRga<C extends crdts.Crdt & crdts.Resettable>
  extends crdts.CListFromMap<
    C,
    [],
    crdts.RgaLoc,
    crdts.MergingMutCMap<crdts.RgaLoc, C>,
    crdts.RgaDenseLocalList<undefined>
  >
  implements crdts.Resettable
{
  constructor(
    initToken: crdts.CrdtInitToken,
    valueConstructor: (
      valueInitToken: crdts.CrdtInitToken,
      loc: crdts.RgaLoc
    ) => C
  ) {
    const denseLocalList = new crdts.RgaDenseLocalList<undefined>(
      initToken.runtime
    );
    super(
      initToken,
      crdts.Pre(crdts.MergingMutCMap)(valueConstructor, denseLocalList),
      denseLocalList
    );
  }

  reset(): void {
    this.internalMap.reset();
  }
}

function compoCrdtRga() {
  class CrdtTodoList
    extends crdts.CObject
    implements ITodoList, crdts.Resettable
  {
    private readonly text: CTextRga;
    private readonly doneCrdt: crdts.TrueWinsCBoolean;
    private readonly items: ResettingMutCListRga<CrdtTodoList>;

    constructor(initToken: crdts.CrdtInitToken) {
      super(initToken);
      this.text = this.addChild("text", crdts.Pre(CTextRga)());
      this.doneCrdt = this.addChild(
        "done",
        crdts.Pre(crdts.TrueWinsCBoolean)()
      );
      this.items = this.addChild(
        "items",
        crdts.Pre(ResettingMutCListRga)(
          crdts.ConstructorAsFunction(CrdtTodoList)
        )
      );
    }

    addItem(index: number, text: string): void {
      let item = this.items.insert(index);
      item.insertText(0, text);
    }
    deleteItem(index: number): void {
      this.items.delete(index);
    }
    getItem(index: number): CrdtTodoList {
      return this.items.get(index);
    }
    get itemsSize(): number {
      return this.items.length;
    }

    set done(done: boolean) {
      this.doneCrdt.value = done;
    }
    get done(): boolean {
      return this.doneCrdt.value;
    }

    insertText(index: number, text: string): void {
      this.text.insert(index, ...text);
    }
    deleteText(index: number, count: number): void {
      this.text.delete(index, count);
    }
    get textSize(): number {
      return this.text.length; // Assumes all text registers are one char
    }
    getText(): string {
      return this.text.join("");
    }

    reset() {
      this.text.reset();
      this.doneCrdt.reset();
      this.items.reset();
    }
  }

  let generator: crdts.TestingNetworkGenerator | null;
  let runtime: crdts.Runtime | null;
  let totalSentBytes: number;

  return new TodoListBenchmark("Compo Crdt RGA", {
    newTodoList(rng) {
      generator = new crdts.TestingNetworkGenerator();
      runtime = generator.newRuntime(new crdts.ManualBatchingStrategy(), rng);
      totalSentBytes = 0;
      let list = runtime.registerCrdt("", crdts.Pre(CrdtTodoList)());
      // TODO: this seems unnecessary
      this.sendNextMessage();
      return list;
    },
    cleanup() {
      generator = null;
      runtime = null;
    },
    sendNextMessage() {
      runtime!.commitBatch();
      totalSentBytes += generator!.lastMessage
        ? GZIP
          ? zlib.gzipSync(generator!.lastMessage).byteLength
          : generator!.lastMessage.byteLength
        : 0;
      generator!.lastMessage = undefined;
    },
    getSentBytes() {
      return totalSentBytes;
    },
    save() {
      const saveData = runtime!.save();
      return [saveData, saveData.byteLength];
    },
    load(saveData: Uint8Array, rng) {
      // Proceed like newTodoList, but without doing any
      // operations.
      generator = new crdts.TestingNetworkGenerator();
      runtime = generator.newRuntime(new crdts.ManualBatchingStrategy(), rng);
      let list = runtime.registerCrdt("", crdts.Pre(CrdtTodoList)());
      runtime.load(saveData);
      return list;
    },
  });
}

function compoMovableCrdt() {
  class CrdtTodoList
    extends crdts.CObject
    implements ITodoList, crdts.Resettable
  {
    private readonly text: crdts.CText;
    private readonly doneCrdt: crdts.TrueWinsCBoolean;
    private readonly items: crdts.DeletingMutCList<CrdtTodoList, []>;

    constructor(initToken: crdts.CrdtInitToken) {
      super(initToken);
      this.text = this.addChild("text", crdts.Pre(crdts.CText)());
      this.doneCrdt = this.addChild(
        "done",
        crdts.Pre(crdts.TrueWinsCBoolean)()
      );
      this.items = this.addChild(
        "items",
        crdts.Pre(crdts.DeletingMutCList)(
          crdts.ConstructorAsFunction(CrdtTodoList)
        )
      );
    }

    addItem(index: number, text: string): void {
      let item = this.items.insert(index);
      item.insertText(0, text);
    }
    deleteItem(index: number): void {
      this.items.delete(index);
    }
    getItem(index: number): CrdtTodoList {
      return this.items.get(index);
    }
    get itemsSize(): number {
      return this.items.length;
    }

    set done(done: boolean) {
      this.doneCrdt.value = done;
    }
    get done(): boolean {
      return this.doneCrdt.value;
    }

    insertText(index: number, text: string): void {
      this.text.insert(index, ...text);
    }
    deleteText(index: number, count: number): void {
      this.text.delete(index, count);
    }
    get textSize(): number {
      return this.text.length; // Assumes all text registers are one char
    }
    getText(): string {
      return this.text.join("");
    }

    reset() {
      this.text.reset();
      this.doneCrdt.reset();
      this.items.reset();
    }
  }

  let generator: crdts.TestingNetworkGenerator | null;
  let runtime: crdts.Runtime | null;
  let totalSentBytes: number;

  return new TodoListBenchmark("Compo Movable Crdt", {
    newTodoList(rng) {
      generator = new crdts.TestingNetworkGenerator();
      runtime = generator.newRuntime(new crdts.ManualBatchingStrategy(), rng);
      totalSentBytes = 0;
      let list = runtime.registerCrdt("", crdts.Pre(CrdtTodoList)());
      // TODO: this seems unnecessary
      this.sendNextMessage();
      return list;
    },
    cleanup() {
      generator = null;
      runtime = null;
    },
    sendNextMessage() {
      runtime!.commitBatch();
      totalSentBytes += generator!.lastMessage
        ? GZIP
          ? zlib.gzipSync(generator!.lastMessage).byteLength
          : generator!.lastMessage.byteLength
        : 0;
      generator!.lastMessage = undefined;
    },
    getSentBytes() {
      return totalSentBytes;
    },
    save() {
      const saveData = runtime!.save();
      return [saveData, saveData.byteLength];
    },
    load(saveData: Uint8Array, rng) {
      // Proceed like newTodoList, but without doing any
      // operations.
      generator = new crdts.TestingNetworkGenerator();
      runtime = generator.newRuntime(new crdts.ManualBatchingStrategy(), rng);
      let list = runtime.registerCrdt("", crdts.Pre(CrdtTodoList)());
      runtime.load(saveData);
      return list;
    },
  });
}

class DeletingMutCListRga<
  C extends crdts.Crdt,
  InsertArgs extends any[]
> extends crdts.MovableMutCListFromSet<
  C,
  InsertArgs,
  crdts.RgaLoc,
  crdts.LwwCRegister<crdts.RgaLoc>,
  crdts.DeletingMutCSet<
    crdts.MovableMutCListEntry<
      C,
      crdts.RgaLoc,
      crdts.LwwCRegister<crdts.RgaLoc>
    >,
    [crdts.RgaLoc, InsertArgs]
  >,
  crdts.RgaDenseLocalList<
    crdts.MovableMutCListEntry<
      C,
      crdts.RgaLoc,
      crdts.LwwCRegister<crdts.RgaLoc>
    >
  >
> {
  constructor(
    initToken: crdts.CrdtInitToken,
    valueConstructor: (
      valueInitToken: crdts.CrdtInitToken,
      ...args: InsertArgs
    ) => C,
    argsSerializer: crdts.ElementSerializer<InsertArgs> = crdts.DefaultElementSerializer.getInstance()
  ) {
    super(
      initToken,
      (setValueConstructor, setArgsSerializer) =>
        crdts.Pre(crdts.DeletingMutCSet)(
          setValueConstructor,
          undefined,
          setArgsSerializer
        ),
      crdts.ConstructorAsFunction(crdts.LwwCRegister),
      new crdts.RgaDenseLocalList(initToken.runtime),
      valueConstructor,
      argsSerializer
    );
  }
}

function compoMovableCrdtRga() {
  class CrdtTodoList
    extends crdts.CObject
    implements ITodoList, crdts.Resettable
  {
    private readonly text: crdts.CList<string>;
    private readonly doneCrdt: crdts.TrueWinsCBoolean;
    private readonly items: crdts.CList<CrdtTodoList, []>;

    constructor(initToken: crdts.CrdtInitToken) {
      super(initToken);
      this.text = this.addChild(
        "text",
        crdts.Pre(crdts.PrimitiveCListFromDenseLocalList)(
          new crdts.RgaDenseLocalList<string>(initToken.runtime),
          crdts.TextSerializer.instance,
          crdts.TextArraySerializer.instance
        )
      );
      this.doneCrdt = this.addChild(
        "done",
        crdts.Pre(crdts.TrueWinsCBoolean)()
      );
      this.items = this.addChild(
        "items",
        crdts.Pre(DeletingMutCListRga)(
          crdts.ConstructorAsFunction(CrdtTodoList)
        )
      );
    }

    addItem(index: number, text: string): void {
      let item = this.items.insert(index);
      item.insertText(0, text);
    }
    deleteItem(index: number): void {
      this.items.delete(index);
    }
    getItem(index: number): CrdtTodoList {
      return this.items.get(index);
    }
    get itemsSize(): number {
      return this.items.length;
    }

    set done(done: boolean) {
      this.doneCrdt.value = done;
    }
    get done(): boolean {
      return this.doneCrdt.value;
    }

    insertText(index: number, text: string): void {
      // @ts-ignore TODO: remove this once RGA text is typed properly
      this.text.insert(index, ...text);
    }
    deleteText(index: number, count: number): void {
      this.text.delete(index, count);
    }
    get textSize(): number {
      return this.text.length; // Assumes all text registers are one char
    }
    getText(): string {
      return this.text.join("");
    }

    reset() {
      this.text.clear();
      this.doneCrdt.reset();
      this.items.clear();
    }
  }

  let generator: crdts.TestingNetworkGenerator | null;
  let runtime: crdts.Runtime | null;
  let totalSentBytes: number;

  return new TodoListBenchmark("Compo Movable Crdt RGA", {
    newTodoList(rng) {
      generator = new crdts.TestingNetworkGenerator();
      runtime = generator.newRuntime(new crdts.ManualBatchingStrategy(), rng);
      totalSentBytes = 0;
      let list = runtime.registerCrdt("", crdts.Pre(CrdtTodoList)());
      // TODO: this seems unnecessary
      this.sendNextMessage();
      return list;
    },
    cleanup() {
      generator = null;
      runtime = null;
    },
    sendNextMessage() {
      runtime!.commitBatch();
      totalSentBytes += generator!.lastMessage
        ? GZIP
          ? zlib.gzipSync(generator!.lastMessage).byteLength
          : generator!.lastMessage.byteLength
        : 0;
      generator!.lastMessage = undefined;
    },
    getSentBytes() {
      return totalSentBytes;
    },
    save() {
      const saveData = runtime!.save();
      return [saveData, saveData.byteLength];
    },
    load(saveData: Uint8Array, rng) {
      // Proceed like newTodoList, but without doing any
      // operations.
      generator = new crdts.TestingNetworkGenerator();
      runtime = generator.newRuntime(new crdts.ManualBatchingStrategy(), rng);
      let list = runtime.registerCrdt("", crdts.Pre(CrdtTodoList)());
      runtime.load(saveData);
      return list;
    },
  });
}

function compoJson() {
  class JsonTodoList implements ITodoList {
    constructor(private readonly jsonObj: JsonObject) {}
    addItem(index: number, text: string): void {
      let item = (this.jsonObj.get("items")!.value as JsonArray).insert(index);
      item.setOrdinaryJS({
        items: [],
        done: false,
        text: [...text],
      });
    }
    deleteItem(index: number): void {
      (this.jsonObj.get("items")!.value as JsonArray).delete(index);
    }
    getItem(index: number): ITodoList {
      return new JsonTodoList(
        (this.jsonObj.get("items")!.value as JsonArray).get(index)!
          .value as JsonObject
      );
    }
    get itemsSize(): number {
      return (this.jsonObj.get("items")!.value as JsonArray).length;
    }

    get done(): boolean {
      return this.jsonObj.get("done")!.value as boolean;
    }

    set done(done: boolean) {
      this.jsonObj.get("done")!.setPrimitive(done);
    }

    insertText(index: number, text: string): void {
      // TODO: use bulk ops
      let textArray = this.jsonObj.get("text")!.value as JsonArray;
      for (let i = 0; i < text.length; i++) {
        textArray.insert(index + i).setPrimitive(text[i]);
      }
    }
    deleteText(index: number, count: number): void {
      let textArray = this.jsonObj.get("text")!.value as JsonArray;
      for (let i = 0; i < count; i++) {
        textArray.delete(index);
      }
    }
    get textSize(): number {
      return (this.jsonObj.get("text")!.value as JsonArray).length;
    }
    getText(): string {
      return (this.jsonObj.get("text")!.value as JsonArray)
        .asArray()
        .map((element) => element.value)
        .join("");
    }
  }

  let generator: crdts.TestingNetworkGenerator | null;
  let runtime: crdts.Runtime | null;
  let totalSentBytes: number;

  return new TodoListBenchmark("Compo Json", {
    newTodoList(rng) {
      generator = new crdts.TestingNetworkGenerator();
      runtime = generator.newRuntime(new crdts.ManualBatchingStrategy(), rng);
      totalSentBytes = 0;
      let list = runtime.registerCrdt("", JsonElement.NewJson);
      list.setOrdinaryJS({ items: [] });
      this.sendNextMessage();
      return new JsonTodoList(list.value as JsonObject);
    },
    cleanup() {
      generator = null;
      runtime = null;
    },
    sendNextMessage() {
      runtime!.commitBatch();
      totalSentBytes += generator!.lastMessage
        ? GZIP
          ? zlib.gzipSync(generator!.lastMessage).byteLength
          : generator!.lastMessage.byteLength
        : 0;
      generator!.lastMessage = undefined;
    },
    getSentBytes() {
      return totalSentBytes;
    },
    save() {
      const saveData = runtime!.save();
      return [saveData, saveData.byteLength];
    },
    load(saveData: Uint8Array, rng) {
      // Proceed like newTodoList, but without doing any
      // operations.
      generator = new crdts.TestingNetworkGenerator();
      runtime = generator.newRuntime(new crdts.ManualBatchingStrategy(), rng);
      let list = runtime.registerCrdt("", JsonElement.NewJson);
      runtime.load(saveData);
      return new JsonTodoList(list.value as JsonObject);
    },
  });
}

/**
 * Like Compo JSON but uses our dedicated text-editing
 * data structure.
 */
function compoJsonText() {
  class JsonTextTodoList implements ITodoList {
    constructor(private readonly jsonObj: JsonObject) {}
    addItem(index: number, text: string): void {
      let item = (this.jsonObj.get("items")!.value as JsonArray).insert(index);
      item.setOrdinaryJS({
        items: [],
        done: false,
        text: new TextWrapper(text),
      });
    }
    deleteItem(index: number): void {
      (this.jsonObj.get("items")!.value as JsonArray).delete(index);
    }
    getItem(index: number): ITodoList {
      return new JsonTextTodoList(
        (this.jsonObj.get("items")!.value as JsonArray).get(index)!
          .value as JsonObject
      );
    }
    get itemsSize(): number {
      return (this.jsonObj.get("items")!.value as JsonArray).length;
    }

    get done(): boolean {
      return this.jsonObj.get("done")!.value as boolean;
    }

    set done(done: boolean) {
      this.jsonObj.get("done")!.setPrimitive(done);
    }

    insertText(index: number, text: string): void {
      let textArray = this.jsonObj.get("text")!.value as crdts.CText;
      textArray.insert(index, ...text);
    }
    deleteText(index: number, count: number): void {
      let textList = this.jsonObj.get("text")!.value as crdts.CText;
      textList.delete(index, count);
    }
    get textSize(): number {
      return (this.jsonObj.get("text")!.value as crdts.CText).length;
    }
    getText(): string {
      return (this.jsonObj.get("text")!.value as crdts.CText).join("");
    }
  }

  let generator: crdts.TestingNetworkGenerator | null;
  let runtime: crdts.Runtime | null;
  let totalSentBytes: number;

  return new TodoListBenchmark("Compo Json Text", {
    newTodoList(rng) {
      generator = new crdts.TestingNetworkGenerator();
      runtime = generator.newRuntime(new crdts.ManualBatchingStrategy(), rng);
      totalSentBytes = 0;
      let list = runtime.registerCrdt("", JsonElement.NewJson);
      list.setOrdinaryJS({ items: [] });
      this.sendNextMessage();
      return new JsonTextTodoList(list.value as JsonObject);
    },
    cleanup() {
      generator = null;
      runtime = null;
    },
    sendNextMessage() {
      runtime!.commitBatch();
      totalSentBytes += generator!.lastMessage
        ? GZIP
          ? zlib.gzipSync(generator!.lastMessage).byteLength
          : generator!.lastMessage.byteLength
        : 0;
      generator!.lastMessage = undefined;
    },
    getSentBytes() {
      return totalSentBytes;
    },
    save() {
      const saveData = runtime!.save();
      return [saveData, saveData.byteLength];
    },
    load(saveData: Uint8Array, rng) {
      // Proceed like newTodoList, but without doing any
      // operations.
      generator = new crdts.TestingNetworkGenerator();
      runtime = generator.newRuntime(new crdts.ManualBatchingStrategy(), rng);
      let list = runtime.registerCrdt("", JsonElement.NewJson);
      runtime.load(saveData);
      return new JsonTextTodoList(list.value as JsonObject);
    },
  });
}

function automerge() {
  let lastDoc: Automerge.FreezeObject<any> | null;
  let theDoc: Automerge.FreezeObject<any> | null;
  let totalSentBytes = 0;

  class AutomergeTodoList implements ITodoList {
    /**
     * @param cursor series of indices to use in theDoc to access this item
     */
    constructor(private readonly cursor: readonly number[]) {}

    private getThis(doc: any): any {
      let thisObj = doc;
      for (let index of this.cursor) {
        thisObj = thisObj.items[index];
      }
      return thisObj;
    }

    addItem(index: number, text: string): void {
      theDoc = Automerge.change(theDoc, (doc) => {
        let thisDoc = this.getThis(doc);
        let textCrdt = new Automerge.Text();
        thisDoc.items.insertAt(index, {
          text: textCrdt,
          done: false,
          items: [],
        });
        textCrdt.insertAt!(0, ...text);
      });
    }
    deleteItem(index: number): void {
      theDoc = Automerge.change(theDoc, (doc) => {
        let thisDoc = this.getThis(doc);
        thisDoc.items.deleteAt(index);
      });
    }
    getItem(index: number): AutomergeTodoList {
      return new AutomergeTodoList([...this.cursor, index]);
    }
    get itemsSize(): number {
      return this.getThis(theDoc).items.length;
    }

    get done(): boolean {
      return this.getThis(theDoc).done;
    }
    set done(done: boolean) {
      theDoc = Automerge.change(theDoc, (doc) => {
        let thisDoc = this.getThis(doc);
        thisDoc.done = done;
      });
    }

    insertText(index: number, text: string): void {
      theDoc = Automerge.change(theDoc, (doc) => {
        let thisDoc = this.getThis(doc);
        (thisDoc.text as Automerge.Text).insertAt!(index, ...text);
      });
    }
    deleteText(index: number, count: number): void {
      theDoc = Automerge.change(theDoc, (doc) => {
        let thisDoc = this.getThis(doc);
        (thisDoc.text as Automerge.Text).deleteAt!(index, count);
      });
    }
    get textSize(): number {
      return (this.getThis(theDoc).text as Automerge.Text).length;
    }
    getText(): string {
      return (this.getThis(theDoc).text as Automerge.Text).toString();
    }
  }

  return new TodoListBenchmark("Automerge", {
    newTodoList() {
      // TODO: use rng'd actorId (input as second argument
      // to from and load), in same format as Automerge
      // uses internally.
      theDoc = Automerge.from({
        items: [],
      });
      lastDoc = theDoc;
      totalSentBytes = 0;
      return new AutomergeTodoList([]);
    },
    cleanup() {
      theDoc = null;
      lastDoc = null;
    },
    sendNextMessage() {
      let message = JSON.stringify(Automerge.getChanges(lastDoc!, theDoc!));
      if (GZIP) totalSentBytes += zlib.gzipSync(message).byteLength;
      // TODO: really should use byte length.  Probably
      // okay though as it sticks to ascii.
      else totalSentBytes += message.length;
      lastDoc = theDoc;
    },
    getSentBytes() {
      return totalSentBytes;
    },
    save() {
      // TODO: Readme says this is a Uint8Array, but
      // TypeScript says it is a string.  Not a problem,
      // but we should make sure length accurately gives
      // the byte length, not the uint16 length.
      const saveData = Automerge.save(theDoc!);
      return [saveData, saveData.length];
    },
    load(saveData: string) {
      theDoc = Automerge.load(saveData);
      lastDoc = theDoc;
      return new AutomergeTodoList([]);
    },
  });
}

function automergeNoText() {
  let lastDoc: Automerge.FreezeObject<any> | null;
  let theDoc: Automerge.FreezeObject<any> | null;
  let totalSentBytes = 0;

  class AutomergeTodoList implements ITodoList {
    /**
     * @param cursor series of indices to use in theDoc to access this item
     */
    constructor(private readonly cursor: readonly number[]) {}

    private getThis(doc: any): any {
      let thisObj = doc;
      for (let index of this.cursor) {
        thisObj = thisObj.items[index];
      }
      return thisObj;
    }

    addItem(index: number, text: string): void {
      theDoc = Automerge.change(theDoc, (doc) => {
        let thisDoc = this.getThis(doc);
        thisDoc.items.insertAt(index, {
          text: [...text],
          done: false,
          items: [],
        });
      });
    }
    deleteItem(index: number): void {
      theDoc = Automerge.change(theDoc, (doc) => {
        let thisDoc = this.getThis(doc);
        thisDoc.items.deleteAt(index);
      });
    }
    getItem(index: number): AutomergeTodoList {
      return new AutomergeTodoList([...this.cursor, index]);
    }
    get itemsSize(): number {
      return this.getThis(theDoc).items.length;
    }

    get done(): boolean {
      return this.getThis(theDoc).done;
    }
    set done(done: boolean) {
      theDoc = Automerge.change(theDoc, (doc) => {
        let thisDoc = this.getThis(doc);
        thisDoc.done = done;
      });
    }

    insertText(index: number, text: string): void {
      theDoc = Automerge.change(theDoc, (doc) => {
        let thisDoc = this.getThis(doc);
        (thisDoc.text as string[]).splice(index, 0, ...text);
      });
    }
    deleteText(index: number, count: number): void {
      theDoc = Automerge.change(theDoc, (doc) => {
        let thisDoc = this.getThis(doc);
        (thisDoc.text as string[]).splice(index, count);
      });
    }
    get textSize(): number {
      return (this.getThis(theDoc).text as string[]).length;
    }
    getText(): string {
      return (this.getThis(theDoc).text as string[]).join("");
    }
  }

  return new TodoListBenchmark("AutomergeNoText", {
    newTodoList() {
      theDoc = Automerge.from({
        items: [],
      });
      lastDoc = theDoc;
      totalSentBytes = 0;
      return new AutomergeTodoList([]);
    },
    cleanup() {
      theDoc = null;
      lastDoc = null;
    },
    sendNextMessage() {
      let message = JSON.stringify(Automerge.getChanges(lastDoc!, theDoc!));
      if (GZIP) totalSentBytes += zlib.gzipSync(message).byteLength;
      // TODO: really should use byte length.  Probably
      // okay though as it sticks to ascii.
      else totalSentBytes += message.length;
      lastDoc = theDoc;
    },
    getSentBytes() {
      return totalSentBytes;
    },
    save() {
      // TODO: Readme says this is a Uint8Array, but
      // TypeScript says it is a string.  Not a problem,
      // but we should make sure length accurately gives
      // the byte length, not the uint16 length.
      const saveData = Automerge.save(theDoc!);
      return [saveData, saveData.length];
    },
    load(saveData: string) {
      theDoc = Automerge.load(saveData);
      lastDoc = theDoc;
      return new AutomergeTodoList([]);
    },
  });
}

function yjs() {
  let topDoc: Y.Doc | null;
  let totalSentBytes: number;

  class YjsTodoList implements ITodoList {
    private readonly textCrdt: Y.Text;
    private readonly items: Y.Array<Y.Map<any>>;
    constructor(private readonly map: Y.Map<any>) {
      this.textCrdt = map.get("text");
      this.items = map.get("items");
    }

    addItem(index: number, text: string): void {
      topDoc!.transact(() => {
        let item = new Y.Map<any>();
        item.set("text", new Y.Text(text));
        item.set("items", new Y.Array<Y.Map<any>>());
        item.set("done", false);
        this.items.insert(index, [item]);
      });
    }
    deleteItem(index: number): void {
      topDoc!.transact(() => {
        this.items.delete(index);
      });
    }
    getItem(index: number): ITodoList {
      return new YjsTodoList(this.items.get(index));
    }
    get itemsSize(): number {
      return this.items.length;
    }

    get done(): boolean {
      return this.map.get("done");
    }
    set done(done: boolean) {
      topDoc!.transact(() => {
        this.map.set("done", done);
      });
    }

    insertText(index: number, text: string): void {
      topDoc!.transact(() => {
        this.textCrdt.insert(index, text);
      });
    }
    deleteText(index: number, count: number): void {
      topDoc!.transact(() => {
        this.textCrdt.delete(index, count);
      });
    }
    get textSize(): number {
      return this.textCrdt.length;
    }
    getText(): string {
      return this.textCrdt.toString();
    }
  }

  return new TodoListBenchmark("Yjs", {
    newTodoList() {
      topDoc = new Y.Doc();
      totalSentBytes = 0;
      topDoc.on("update", (update: any) => {
        totalSentBytes += update.byteLength;
      });
      topDoc.getMap().set("items", new Y.Array<Y.Map<any>>());
      return new YjsTodoList(topDoc.getMap());
    },
    cleanup() {
      topDoc = null;
    },
    sendNextMessage() {},
    getSentBytes() {
      return totalSentBytes;
    },
    save() {
      // TODO: also try encodeStateAsUpdateV2 and applyUpdateV2,
      // use whichever is better.
      const saveData = Y.encodeStateAsUpdate(topDoc!);
      return [saveData, saveData.byteLength];
    },
    load(saveData: Uint8Array) {
      // Proceed like newTodoList, but without doing any
      // operations or recording sent bytes.
      topDoc = new Y.Doc();
      Y.applyUpdate(topDoc, saveData);
      return new YjsTodoList(topDoc.getMap());
    },
  });
}

function jsonCrdt() {
  class JsonCrdtTodoList implements ITodoList {
    private readonly items: JsonCursor;
    private readonly ids: crdts.PrimitiveCList<string>;
    private readonly text: crdts.PrimitiveCList<string>;
    constructor(
      private readonly crdt: JsonCursor,
      private readonly idGen: crdts.TreedocDenseLocalList<undefined>,
      private readonly runtime: crdts.Runtime
    ) {
      this.items = this.crdt.get("items")[0] as JsonCursor;
      this.ids = this.crdt.get("itemsIds")[0] as crdts.PrimitiveCList<string>;
      this.text = this.crdt.get("text")[0] as crdts.PrimitiveCList<string>;
    }
    addItem(index: number, text: string): void {
      // Generate new id for this index
      // let startId: null | crdts.TreedocLoc = null;
      // let endId: null | crdts.TreedocLoc = null;
      let startId: any = null;
      let endId: any = null;
      if (index < this.ids.length) {
        endId = this.idGen.deserializeInternal(
          crdts.stringAsArray(this.ids.get(index)),
          this.runtime
        );
      }
      if (index > 0) {
        startId = this.idGen.deserializeInternal(
          crdts.stringAsArray(this.ids.get(index - 1)),
          this.runtime
        );
      }
      let id = this.idGen.createBetween(startId, endId, 1)[0];
      let key: string = crdts.arrayAsString(this.idGen.serializeInternal(id));
      this.ids.insert(index, key);

      // Update Json Crdt with new item
      this.items.setIsMap(key);
      let newItem = this.items.get(key)[0] as JsonCursor;
      newItem.setIsMap("items");
      newItem.setIsList("itemsIds");
      newItem.set("done", false);
      newItem.setIsList("text");

      // Update text item
      let textItem = newItem.get("text")[0] as crdts.PrimitiveCList<string>;
      textItem.insert(0, ...text);
    }
    deleteItem(index: number): void {
      let id: string = this.ids.get(index);
      this.ids.delete(index);
      this.items.delete(id);
    }
    getItem(index: number): ITodoList {
      let id: string = this.ids.get(index);
      return new JsonCrdtTodoList(
        this.items.get(id)[0] as JsonCursor,
        this.idGen,
        this.runtime
      );
    }
    get itemsSize(): number {
      return this.ids.length;
    }

    get done(): boolean {
      return this.crdt.get("done")[0] as boolean;
    }

    set done(done: boolean) {
      this.crdt.set("done", done);
    }

    insertText(index: number, text: string): void {
      this.text.insert(index, ...text);
    }
    deleteText(index: number, count: number): void {
      this.text.delete(index, count);
    }
    get textSize(): number {
      return this.text.length;
    }
    getText(): string {
      return this.text.join("");
    }
  }

  let generator: crdts.TestingNetworkGenerator | null;
  let runtime: crdts.Runtime | null;
  let totalSentBytes: number;

  return new TodoListBenchmark("Compo Json Crdt", {
    newTodoList(rng) {
      generator = new crdts.TestingNetworkGenerator();
      runtime = generator.newRuntime(new crdts.ManualBatchingStrategy(), rng);
      totalSentBytes = 0;

      let crdt = runtime.registerCrdt("", crdts.Pre(JsonCrdt)());
      let cursor = new JsonCursor(crdt);
      this.sendNextMessage();
      cursor.setIsMap("items");
      cursor.setIsList("itemsIds");
      cursor.set("done", false);
      cursor.setIsList("text");

      let idGen = new crdts.TreedocDenseLocalList<undefined>(runtime);
      return new JsonCrdtTodoList(cursor, idGen, crdt.runtime);
    },
    cleanup() {
      generator = null;
      runtime = null;
    },
    sendNextMessage() {
      runtime!.commitBatch();
      totalSentBytes += generator!.lastMessage
        ? GZIP
          ? zlib.gzipSync(generator!.lastMessage).byteLength
          : generator!.lastMessage.byteLength
        : 0;
      generator!.lastMessage = undefined;
    },
    getSentBytes() {
      return totalSentBytes;
    },
    save() {
      const saveData = runtime!.save();
      return [saveData, saveData.byteLength];
    },
    load(saveData: Uint8Array, rng) {
      // Proceed like newTodoList, but without doing any
      // operations.
      generator = new crdts.TestingNetworkGenerator();
      runtime = generator.newRuntime(new crdts.ManualBatchingStrategy(), rng);

      let crdt = runtime.registerCrdt("", crdts.Pre(JsonCrdt)());
      let cursor = new JsonCursor(crdt);

      let idGen = new crdts.TreedocDenseLocalList<undefined>(runtime);

      runtime.load(saveData);

      return new JsonCrdtTodoList(cursor, idGen, crdt.runtime);
    },
  });
}

// TODO: use two crdts, like in dmonad benchmarks?

export default async function todoList(args: string[]) {
  let benchmark: TodoListBenchmark;
  switch (args[0]) {
    case "plainJs":
      benchmark = plainJs();
      break;
    case "compoCrdt":
      benchmark = compoCrdt();
      break;
    case "compoCrdtRga":
      benchmark = compoCrdtRga();
      break;
    case "compoMovableCrdt":
      benchmark = compoMovableCrdt();
      break;
    case "compoMovableCrdtRga":
      benchmark = compoMovableCrdtRga();
      break;
    case "compoJson":
      benchmark = compoJson();
      break;
    case "compoJsonText":
      benchmark = compoJsonText();
      break;
    case "yjs":
      benchmark = yjs();
      break;
    case "automerge":
      benchmark = automerge();
      break;
    case "automergeNoText":
      benchmark = automergeNoText();
      break;
    case "compoJsonCrdt":
      benchmark = jsonCrdt();
      break;
    default:
      throw new Error("Unrecognized benchmark arg: " + args[0]);
  }
  if (
    !(
      args[1] === "time" ||
      args[1] === "memory" ||
      args[1] === "network" ||
      args[1] === "save"
    )
  ) {
    throw new Error("Unrecognized metric arg: " + args[1]);
  }
  if (!(args[2] === "whole" || args[2] === "rounds")) {
    throw new Error("Unrecognized frequency: " + args[2]);
  }
  await benchmark.run(args[1], args[2]);
}
