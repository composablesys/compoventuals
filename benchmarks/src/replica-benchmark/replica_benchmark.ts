// Benchmarks that involve one or more replicas communicating normally.

import { record, getRecordedTrials, getWarmupTrials } from "../record";
import seedrandom from "seedrandom";
import { assert } from "chai";
import { byteLength, Data, getMemoryUsed } from "../util";

const SEED = "42";
const CONCURRENT_NUM_DEVICES = 100;
const ROTATE_NUM_DEVICES = 1000;

export interface Replica {
  /**
   * Execute doOps, which performs ops on this replica, in a single
   * transaction, i.e., sending a single message
   * via onsend (provided to Implementation).
   */
  transact(doOps: () => void): void;

  receive(msg: Data): void;

  save(): Data;

  load(saveData: Data): void;

  skipLoad(): void;
}

/**
 * A Replica constructor with the given constructor args,
 * i.e., a Replica factory.
 */
export type Implementation<I> = new (
  onsend: (msg: Data) => void,
  replicaIdRng: seedrandom.prng
) => Replica & I;

export interface Trace<I> {
  /**
   * Do one op on replica. In practice, replica will be a Replica,
   * but we don't express that constraint by default because we don't
   * expect you to need any Replica methods. In particular, don't call
   * transact (we'll call it for you as needed, possibly transacting
   * more than one op at a time).
   *
   * TODO: opNum guarantees (unique; mostly in-order on
   * same replica)
   */
  doOp(replica: I, rng: seedrandom.prng, opNum: number): void;

  /**
   * Used for checking that all replicas end up in the
   * same state when they should.
   *
   * The return value must be comparable using
   * assert.deepStrictEqual.
   */
  getState(replica: I): unknown;

  /**
   * The intended number of ops.
   */
  readonly numOps: number;

  /**
   * The correct output of getState after performing
   * numOps operations sequentially, or undefined if N/A.
   */
  readonly correctState: unknown;
}

export type Mode = "single" | "rotate" | "concurrent";

export class ReplicaBenchmark<I> {
  // TODO: mention measurement.csv used as file name
  // (e.g. sendTime.csv). Method name convention (lowerCamelCase).
  // Label used for method params (e.g. ops), space-separated.
  // Describe full file/folder name.
  constructor(
    private readonly trace: Trace<I>,
    /**
     * The name of the trace
     * (e.g. text-trace, counter). Used as the results
     * folder name. Folder name convention
     * (lower-hyphen-case).
     */
    private readonly traceName: string,
    private readonly implementation: Implementation<I>,
    /**
     * The name of the implementation
     * (e.g. Yjs, CollabsDeleting). Used in the results
     * "Implementation" column. Class name convention
     * (UpperCamelCase).
     */
    private readonly implementationName: string
  ) {}

  /**
   * Do one trace op in a transaction.
   */
  private transactOp(
    replica: Replica & I,
    rng: seedrandom.prng,
    op: number
  ): void {
    replica.transact(() => this.trace.doOp(replica, rng, op));
  }

  /**
   * Returns the sent messages for the given mode, which are to be received
   * during "receive" benchmarks.
   *
   * Also returns the intended finalState, for checking against the receiver's
   * final state. Before returning, it is checked that all
   * senders are also in this finalState (if applicable).
   */
  private async getSentMessages(
    mode: Mode
  ): Promise<[msgs: Data[], finalState: unknown]> {
    const senderRng = seedrandom(SEED + "sender");
    const rng = seedrandom(SEED);
    const msgs: Data[] = [];
    if (mode === "single") {
      // Single device: The ops are performed by one device, sequentially.
      const sender = new this.implementation((msg) => {
        msgs.push(msg);
      }, senderRng);
      sender.skipLoad();
      const rng = seedrandom(SEED);
      for (let op = 0; op < this.trace.numOps; op++) {
        this.transactOp(sender, rng, op);
      }
      return [msgs, this.trace.getState(sender)];
    } else if (mode === "rotate") {
      // Device rotation: The ops are performed by ROTATE_NUM_DEVICES
      // devices, sequentially. The ops are divided equally between devices.
      const opsPerSender = Math.floor(this.trace.numOps / ROTATE_NUM_DEVICES);
      let sender = new this.implementation((msg) => {
        msgs.push(msg);
      }, senderRng);
      sender.skipLoad();
      for (let op = 0; op < this.trace.numOps; op++) {
        // Each device performs opsPerSender ops, except the last, who performs
        // the remainder if the ops do not divide evenly.
        if (
          op % opsPerSender === 0 &&
          op !== 0 &&
          op / opsPerSender < ROTATE_NUM_DEVICES
        ) {
          if ((op / opsPerSender) % 100 === 0) {
            console.log(
              "Setup: Rotating device " +
                op / opsPerSender +
                "/" +
                ROTATE_NUM_DEVICES
            );
            // Force GC, to prevent OOM errors (Node doesn't seem to GC
            // very well during sync code).
            await getMemoryUsed();
          }
          const saveData = sender.save();
          sender = new this.implementation((msg) => {
            msgs.push(msg);
          }, senderRng);

          sender.load(saveData);
        }

        this.transactOp(sender, rng, op);
      }
      return [msgs, this.trace.getState(sender)];
    } else if (mode === "concurrent") {
      // Concurrency: Ops are performed by CONCURRENT_NUM_DEVICES devices
      // acting concurrently.
      const concurrers: (Replica & I)[] = [];
      const lastMsgs = new Array<Data>(CONCURRENT_NUM_DEVICES);
      for (let i = 0; i < CONCURRENT_NUM_DEVICES; i++) {
        const concurrerI = new this.implementation((msg) => {
          msgs.push(msg);
          lastMsgs[i] = msg;
        }, senderRng);
        concurrerI.skipLoad();
        concurrers.push(concurrerI);
      }

      // Each device performs a contiguous range of ops. If the ops do not
      // divide evenly, then the last concurrer performs fewer ops.
      const numRounds = Math.ceil(this.trace.numOps / CONCURRENT_NUM_DEVICES);
      const lastConcurrerOps =
        this.trace.numOps - numRounds * (CONCURRENT_NUM_DEVICES - 1);

      const roundsPerPrint = Math.floor(numRounds / 10);

      for (let round = 0; round < numRounds; round++) {
        if (round % roundsPerPrint === 0) {
          console.log("Setup: Concurrency round " + round + "/" + numRounds);
          // Force GC, to prevent OOM errors (Node doesn't seem to GC
          // very well during sync code).
          await getMemoryUsed();
        }
        // For the last round, might not have enough messages for all senders.
        const numSenders =
          round >= lastConcurrerOps
            ? CONCURRENT_NUM_DEVICES - 1
            : CONCURRENT_NUM_DEVICES;
        for (let i = 0; i < numSenders; i++) {
          this.transactOp(concurrers[i], rng, i * numRounds + round);
        }
        // Everyone receives each others' messages.
        for (let sender = 0; sender < numSenders; sender++) {
          for (
            let receiver = 0;
            receiver < CONCURRENT_NUM_DEVICES;
            receiver++
          ) {
            if (sender !== receiver) {
              concurrers[receiver].receive(lastMsgs[sender]);
            }
          }
        }
      }

      // Check all states are equal.
      const finalState = this.trace.getState(concurrers[0]);
      for (let i = 1; i < concurrers.length; i++) {
        assert.deepStrictEqual(
          this.trace.getState(concurrers[i]),
          finalState,
          "unequal concurrer states"
        );
      }

      return [msgs, finalState];
    } else {
      throw new Error("Unrecognized mode: " + mode);
    }
  }

  /**
   * Benchmark time to send all the ops.
   */
  async sendTime(mode: Mode) {
    if (mode !== "single") {
      throw new Error("Not implemented: sendTime " + mode);
    }

    const values = new Array<number>(getRecordedTrials());
    values.fill(0);

    for (let trial = -getWarmupTrials(); trial < getRecordedTrials(); trial++) {
      // Between trials, force GC.
      await getMemoryUsed();

      console.log("Starting trial " + trial);

      const sender = new this.implementation(() => {},
      seedrandom(SEED + "sender"));
      sender.skipLoad();

      const rng = seedrandom(SEED);

      // Prep measurement.
      const startTime = process.hrtime.bigint();

      // Send all edits.
      // We don't use getSentMessages here because it adds overhead that we
      // don't want to measure (e.g., recording the messages).
      for (let op = 0; op < this.trace.numOps; op++) {
        this.transactOp(sender, rng, op);
      }

      // Take measurement.
      if (trial >= 0) {
        values[trial] = new Number(
          process.hrtime.bigint() - startTime!
        ).valueOf();
      }

      // // For profiling memory usage:
      // console.log("Ready to profile");
      // await new Promise((resolve) => setTimeout(resolve, 1000 * 1000));

      // Check final state.
      if (mode === "single" && this.trace.correctState !== undefined) {
        assert.deepStrictEqual(
          this.trace.getState(sender),
          this.trace.correctState,
          "sender state does not equal trace.correctState"
        );
      }
    }

    // Record measurements.
    record(
      "sendTime/" + this.traceName,
      this.implementationName,
      mode,
      this.trace.numOps,
      values
    );
  }

  /**
   * Benchmark memory of a sender after sending all the ops.
   */
  async sendMemory(mode: Mode) {
    if (mode !== "single") {
      throw new Error("Not implemented: sendTime " + mode);
    }

    const values = new Array<number>(getRecordedTrials());
    values.fill(0);
    let bases = new Array<number>(getRecordedTrials());
    bases.fill(0);

    for (let trial = -getWarmupTrials(); trial < getRecordedTrials(); trial++) {
      // Between trials, force GC.
      // We do this even for warmup trials because empirically, after the first
      // few GCs (usually 3), the memory usage suddenly gets smaller.
      // Presumably this is due to some Node internal optimization.
      // If that happens during a recorded trial, it gives a spuriously
      // low (often negative) memory measurement. By forcing GC's during warmup,
      // with sufficiently many warmup trials, we avoid that happening.
      await getMemoryUsed();

      console.log("Starting trial " + trial);

      const sender = new this.implementation(() => {},
      seedrandom(SEED + "sender"));
      sender.skipLoad();

      const rng = seedrandom(SEED);

      // Prep measurement.
      bases[trial] = await getMemoryUsed();

      // Send all edits.
      // We don't use getSentMessages here because it adds overhead that we
      // don't want to measure (e.g., recording the messages).
      for (let op = 0; op < this.trace.numOps; op++) {
        this.transactOp(sender, rng, op);
      }

      // Take measurement.
      if (trial >= 0) {
        values[trial] = await getMemoryUsed();
      }

      // Check final state.
      if (mode === "single" && this.trace.correctState !== undefined) {
        assert.deepStrictEqual(
          this.trace.getState(sender),
          this.trace.correctState,
          "sender state does not equal trace.correctState"
        );
      }
    }

    // Record measurements.
    record(
      "sendMemory/" + this.traceName,
      this.implementationName,
      mode,
      this.trace.numOps,
      values,
      bases
    );
  }

  /**
   * Benchmark network bytes of sending all the ops.
   */
  async sendNetwork(mode: Mode) {
    const [msgs] = await this.getSentMessages(mode);
    let bytesSent = 0;
    for (const msg of msgs) bytesSent += byteLength(msg);

    // Record measurements.
    record(
      "sendNetwork/" + this.traceName,
      this.implementationName,
      mode,
      this.trace.numOps,
      [bytesSent]
    );
  }

  /**
   * Benchmark time of a user's receiving all
   * the ops, which were generated (off the clock)
   * by other user(s) according to the mode.
   */
  async receiveTime(mode: Mode) {
    const values = new Array<number>(getRecordedTrials());
    values.fill(0);

    // Get messages to receive.
    const [msgs, senderState] = await this.getSentMessages(mode);

    for (let trial = -getWarmupTrials(); trial < getRecordedTrials(); trial++) {
      // Between trials, force GC.
      // See comment in sendMemorySingle().
      await getMemoryUsed();

      console.log("Starting trial " + trial);

      const receiver = new this.implementation(() => {},
      seedrandom(SEED + "receiver"));
      receiver.skipLoad();

      // Prep measurement.
      const startTime = process.hrtime.bigint();

      // Receive all edits.
      for (let i = 0; i < msgs.length; i++) {
        receiver.receive(msgs[i]);
      }

      // Take measurement.
      if (trial >= 0) {
        values[trial] = new Number(
          process.hrtime.bigint() - startTime!
        ).valueOf();
      }

      // Check final state.
      assert.deepStrictEqual(
        this.trace.getState(receiver),
        senderState,
        "receiver state does not equal sender state"
      );
    }

    // Record measurements.
    record(
      "receiveTime/" + this.traceName,
      this.implementationName,
      mode,
      this.trace.numOps,
      values
    );
  }

  /**
   * Benchmark memory of a user after receiving all
   * the ops, which were generated (off the clock)
   * by other user(s) according to the mode.
   */
  async receiveMemory(mode: Mode) {
    const values = new Array<number>(getRecordedTrials());
    values.fill(0);
    let bases = new Array<number>(getRecordedTrials());
    bases.fill(0);

    // Get messages to receive.
    const [msgs, senderState] = await this.getSentMessages(mode);

    for (let trial = -getWarmupTrials(); trial < getRecordedTrials(); trial++) {
      // Between trials, force GC.
      // See comment in sendMemorySingle().
      await getMemoryUsed();

      console.log("Starting trial " + trial);

      const receiver = new this.implementation(() => {},
      seedrandom(SEED + "receiver"));
      receiver.skipLoad();

      // Prep measurement.
      bases[trial] = await getMemoryUsed();

      // Receive all edits.
      for (let i = 0; i < msgs.length; i++) {
        receiver.receive(msgs[i]);
      }

      // Take measurement.
      if (trial >= 0) {
        values[trial] = await getMemoryUsed();
      }

      // Check final state.
      assert.deepStrictEqual(
        this.trace.getState(receiver),
        senderState,
        "receiver state does not equal sender state"
      );
    }

    // Record measurements.
    record(
      "receiveMemory/" + this.traceName,
      this.implementationName,
      mode,
      this.trace.numOps,
      values,
      bases
    );
  }

  async receiveSave(mode: Mode) {
    // Get messages to receive.
    const [msgs, senderState] = await this.getSentMessages(mode);

    // Receive all messages.
    const receiver = new this.implementation(() => {},
    seedrandom(SEED + "receiver"));
    receiver.skipLoad();
    for (let i = 0; i < msgs.length; i++) {
      receiver.receive(msgs[i]);
    }

    // Measure save time, save size, and load time for receiver.
    await this.saveTime(receiver, "receiveSaveTime", mode);

    const saveData = receiver.save();
    record(
      "receiveSaveSize/" + this.traceName,
      this.implementationName,
      mode,
      this.trace.numOps,
      [byteLength(saveData)]
    );

    await this.loadTime(saveData, senderState, "receiveLoadTime", mode);
  }

  private async saveTime(saver: Replica, metric: string, label: string) {
    const values = new Array<number>(getRecordedTrials());
    values.fill(0);

    for (let trial = -getWarmupTrials(); trial < getRecordedTrials(); trial++) {
      // Between trials, force GC.
      await getMemoryUsed();

      console.log("Starting saveTime trial " + trial);

      // Prep measurement.
      const startTime = process.hrtime.bigint();

      // Save.
      saver.save();

      // Take measurements.
      if (trial >= 0) {
        values[trial] = new Number(
          process.hrtime.bigint() - startTime!
        ).valueOf();
      }
    }

    // Record measurements.
    record(
      metric + "/" + this.traceName,
      this.implementationName,
      label,
      this.trace.numOps,
      values
    );
  }

  private async loadTime(
    saveData: Data,
    saverState: unknown,
    metric: string,
    label: string
  ) {
    const values = new Array<number>(getRecordedTrials());
    values.fill(0);

    for (let trial = -getWarmupTrials(); trial < getRecordedTrials(); trial++) {
      // Between trials, force GC.
      await getMemoryUsed();

      console.log("Starting loadTime trial " + trial);

      // Prepare loader.
      const loader = new this.implementation(() => {},
      seedrandom(SEED + "loader"));

      // Prep measurement.
      const startTime = process.hrtime.bigint();

      // Load.
      loader.load(saveData);

      // Take measurements.
      if (trial >= 0) {
        values[trial] = new Number(
          process.hrtime.bigint() - startTime!
        ).valueOf();
      }

      // Check loaded state.
      assert.deepStrictEqual(
        this.trace.getState(loader),
        saverState,
        "loader state does not equal saver state"
      );
    }

    // Record measurements.
    record(
      metric + "/" + this.traceName,
      this.implementationName,
      label,
      this.trace.numOps,
      values
    );
  }
}
