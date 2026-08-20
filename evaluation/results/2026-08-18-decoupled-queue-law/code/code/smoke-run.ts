import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeExperiment } from "./run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const result = executeExperiment({
  outputRoot: path.resolve(here, "..", "smoke"),
  seeds: [11],
  lambda0Override: 0.000567523885704577
});
process.stdout.write(
  `Smoke complete: ${result.requestRowCount} rows; ` +
  `mechanism ${result.supported ? "SUPPORTED" : "NOT SUPPORTED"}\n`
);
