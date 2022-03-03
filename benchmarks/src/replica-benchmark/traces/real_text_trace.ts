import { prng } from "seedrandom";
import { IText } from "../interfaces/text";
import { Trace } from "../replica_benchmark";
import { edits, finalText } from "./real_text_trace_edits";

/**
 * Uses a real text editing trace by Martin Kleppmann
 * (via https://github.com/automerge/automerge-perf).
 */
export class RealTextTrace implements Trace<IText> {
  doOp(replica: IText, _rng: prng, opNum: number): void {
    const edit = edits[opNum];
    if (edit[2] !== undefined) {
      // Insert edit[2] at edit[0]
      replica.insert(edit[0], edit[2]);
    } else {
      // Delete character at edit[0]
      replica.delete(edit[0]);
    }
  }

  getState(replica: IText) {
    return replica.getText();
  }

  readonly numOps = edits.length;

  readonly correctState = finalText;
}