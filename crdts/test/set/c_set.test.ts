import { Collab, InitToken } from "@collabs/core";
import { assert } from "chai";
import seedrandom from "seedrandom";
import { CSet, CVar } from "../../src";
import { Source, Traces } from "../traces";

function firstValue<D extends Collab>(set: CSet<D, any>): D | undefined {
  const iter = set.values().next();
  if (iter.done) return undefined;
  return iter.value;
}

/**
 * V: array of value CVar's; for each CVar,
 * [current value, CVar.conflicts()].
 */
class SetSource
  implements Source<CSet<CVar<string>, [string]>, [string, string[]][]>
{
  constructor(
    readonly rng: seedrandom.prng,
    readonly mode: "add/delete" | "op/op"
  ) {}

  pre(init: InitToken) {
    return new CSet<CVar<string>, [string]>(
      init,
      (valueInit, initialValue) => new CVar(valueInit, initialValue)
    );
  }
  check(
    actual: CSet<CVar<string>, [string]>,
    expected: [string, string[]][]
  ): void {
    assert.strictEqual(actual.size, expected.length);
    assert.deepStrictEqual(
      new Set([...actual].map((value) => [value.value, value.conflicts()])),
      new Set(expected)
    );
  }
  op(c: CSet<CVar<string>, [string]>, n: number): void {
    switch (this.mode) {
      case "add/delete":
        // Test add/delete conflicts, with some value ops
        // for good measure.
        switch (n) {
          case 0:
            c.add("init_op0");
            break;
          case 1: {
            const value = firstValue(c);
            if (value !== undefined) {
              value.value = "op1";
            } else c.add("init_op1");
            break;
          }
          case 2:
            if (c.size !== 0) c.delete(firstValue(c)!);
            else c.add("init_op2").value = "op2";
            break;
          case 3:
            const value = c.add("init_op3");
            // Convert to CollabID and back (same replica).
            const id = c.idOf(value);
            const value2 = c.fromID(id);
            assert.isDefined(value2, "valid CollabID gave undefined");
            value2!.value = "op3";
            break;
          default: {
            const value = firstValue(c);
            if (value !== undefined) {
              value.value = `op${n}`;
            } else c.add(`init_op${n}`);
          }
        }
        break;
      case "op/op":
        // Test that concurrent operations on a value work as usual
        // (in particular, the CMap doesn't mess up its merging).
        // These ops are the same as for CVar, just performed on the first value.
        if (c.size === 0) c.add("initial");
        const value = firstValue(c)!;
        assert.isDefined(value);
        value.value = `op${n}`;
        break;
    }
  }
  setupOp(c: CSet<CVar<string>, [string]>) {
    if (this.mode === "op/op") {
      // Create a value.
      // Do it here instead of in op 0 to avoid add/add conflicts,
      // which would otherwise give us different behavior from CVar's tests.
      c.add("initial");
    }
  }
}

describe("CSet", () => {
  let rng!: seedrandom.prng;
  let source!: SetSource;

  beforeEach(() => {
    rng = seedrandom("42");
  });

  describe("add/delete", () => {
    beforeEach(() => {
      source = new SetSource(rng, "add/delete");
    });

    it("initial", () => {
      Traces.initial(source, []);
    });

    it("singleOp", () => {
      Traces.singleOp(source, [["init_op0", []]]);
    });

    it("sequential", () => {
      Traces.sequential(
        source,
        [["init_op0", []]],
        [["op1", ["op1"]]],
        [],
        [["op3", ["op3"]]]
      );
    });

    it("concurrent", () => {
      Traces.concurrent(
        source,
        [["init_op0", []]],
        [["init_op1", []]],
        // Both added.
        [
          ["init_op0", []],
          ["init_op1", []],
        ]
      );
    });

    it("diamond", () => {
      Traces.diamond(
        source,
        [["init_op0", []]],
        [["op1", ["op1"]]],
        [],
        // Delete wins over CVar operation.
        [],
        [["op3", ["op3"]]]
      );
    });

    it("partition", () => {
      Traces.partition(
        source,
        [["op3", ["op3"]]],
        [["op7", ["op7"]]],
        // The adds in ops 3 and 4 both occur.
        [
          ["op3", ["op3"]],
          ["op7", ["op7"]],
        ]
      );
    });
  });

  describe("op/op", () => {
    beforeEach(() => {
      source = new SetSource(rng, "op/op");
    });

    it("initial", () => {
      Traces.initial(source, [["initial", []]]);
    });

    it("singleOp", () => {
      Traces.singleOp(source, [["op0", ["op0"]]]);
    });

    it("sequential", () => {
      Traces.sequential(
        source,
        [["op0", ["op0"]]],
        [["op1", ["op1"]]],
        [["op2", ["op2"]]],
        [["op3", ["op3"]]]
      );
    });

    it("concurrent", () => {
      Traces.concurrent(
        source,
        [["op0", ["op0"]]],
        [["op1", ["op1"]]],
        // op 0 is done by the lower replicaID, which wins the conflict.
        [["op0", ["op0", "op1"]]]
      );
    });

    it("diamond", () => {
      Traces.diamond(
        source,
        [["op0", ["op0"]]],
        [["op1", ["op1"]]],
        [["op2", ["op2"]]],
        // op 1 is done by the lower replicaID, which wins the conflict.
        [["op1", ["op1", "op2"]]],
        [["op3", ["op3"]]]
      );
    });

    it("partition", () => {
      Traces.partition(
        source,
        [["op3", ["op3"]]],
        [["op7", ["op7"]]],
        // op 3 is done by the lower replicaID, which wins the conflict.
        [["op3", ["op3", "op7"]]]
      );
    });
  });
});

// TODO: cross-replica CollabID tests
