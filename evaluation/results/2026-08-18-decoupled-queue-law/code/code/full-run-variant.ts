import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeExperiment } from "./run.js";

// Full 6-seed run for a queue-law variant.
//   QUEUE_LAW     selects the environment queue law (odds | linear | quadratic)
//   OUTPUT_SUBDIR destination under the experiment root (default output-variant)
//   LAMBDA0       optional frozen arrival rate. When set, calibration is
//                 skipped and the given rate is used verbatim — this is the
//                 controlled-comparison mode: all laws share the 2026-07-24
//                 frozen trace, so the queue law is the only varying factor.
//                 When unset, the rate is recalibrated under the active law
//                 (recorded for reference, not used for cross-law comparison).
const here = path.dirname(fileURLToPath(import.meta.url));
const subdir = process.env.OUTPUT_SUBDIR ?? "output-variant";
const lambda0Env = process.env.LAMBDA0;
const options: Parameters<typeof executeExperiment>[0] = {
  outputRoot: path.resolve(here, "..", subdir)
};
if (lambda0Env !== undefined && lambda0Env !== "") {
  const lambda0 = Number(lambda0Env);
  if (!Number.isFinite(lambda0) || lambda0 <= 0) {
    throw new Error(`Invalid LAMBDA0: ${lambda0Env}`);
  }
  options.lambda0Override = lambda0;
}
const result = executeExperiment(options);
process.stdout.write(
  `Full run complete (${subdir}${lambda0Env ? ", frozen lambda0=" + lambda0Env : ", recalibrated"})` +
  `: ${result.requestRowCount} rows; ` +
  `mechanism ${result.supported ? "SUPPORTED" : "NOT SUPPORTED"}\n`
);
