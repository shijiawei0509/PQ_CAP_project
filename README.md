# Steering LLM Demand with Congestion-Aware Pricing and Preference-Aware Routing

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)

Official implementation and evaluation artifacts for **PQ-CAP**, a congestion-aware pricing and preference-aware routing mechanism for heterogeneous large language model (LLM) aggregation platforms.

Repository: [shijiawei0509/PQ_CAP_project](https://github.com/shijiawei0509/PQ_CAP_project)

## Overview

LLM aggregation platforms expose models with different capabilities, quality levels, prices, and serving conditions. Static or congestion-unaware routing can concentrate requests on a small set of popular model pools even when qualified alternatives retain spare capacity. This concentration increases queueing delay and can lead to throttling or rejected requests.

PQ-CAP coordinates **price, quality, and capacity** at request level. It constructs a feasible model set using task-specific quality requirements, capability constraints, and hard-capacity admission; computes congestion-aware quotes from post-admission workloads; and selects a model according to the user's routing preference. The mechanism supports price-sensitive, quality-first, and fixed-model policies without relaxing the request's required quality level.

This repository contains:

- the PQ-CAP routing and pricing implementation;
- a React-based router prototype with a Node.js/Express backend;
- simulation and evaluation code for heterogeneous model pools;
- frozen experiment inputs, aggregate outputs, validation artifacts, and plotting code;
- tests for routing, pricing, capacity admission, queue models, trace pairing, and result export.

## Highlights

- **Quality- and capability-constrained routing.** Candidate models must satisfy task-conditioned quality thresholds, required capabilities, and hard-capacity constraints.
- **Post-admission congestion pricing.** Quotes reflect the workload added by the arriving request rather than only the pool's pre-arrival state.
- **Preference-aware selection.** Price-sensitive and quality-first users receive different rankings over the same feasible candidate set; fixed-model users retain explicit control.
- **Atomic reservation and price locking.** The selected pool is revalidated before execution, capacity is reserved atomically, and the accepted quote is locked for consistent settlement.
- **Reproducible evaluation.** The latest experiment suite includes quality-first and price-sensitive evaluations, component ablations, parameter sensitivity, queue-law robustness, and publication-figure generation.

## Main Results

The current paper evaluates PQ-CAP over **35 heterogeneous models** using OpenRouter pricing, capability, and endpoint-telemetry snapshots together with OpenEvals quality data and benchmark-derived workloads.

- For quality-first users, PQ-CAP routes **99.97%** of requests to non-congested pools and completes **100%** of requests. Its average quality is **0.8582**, only **0.0076** below the highest-quality comparison method in the reported experiment.
- For price-sensitive users, PQ-CAP reduces mean P95 queue wait from **6.641 s** to **1.297 s** relative to static Cheapest Eligible routing, an **80.5% reduction**, while both methods maintain **100% completion** and satisfy the required quality level.
- PQ-CAP is a multi-objective mechanism rather than a universal winner on every individual metric: congestion avoidance and service reliability can require a price premium relative to the cheapest static route, while latency-only routing can achieve lower delay at a different price-quality operating point.

## How PQ-CAP Works

```text
Request
  -> task, difficulty, and capability characterization
  -> workload reservation estimate
  -> capability and task-specific quality filtering
  -> hard-capacity admission using post-admission load
  -> congestion-aware request-level quotes
  -> price-sensitive, quality-first, or fixed-model selection
  -> versioned revalidation, atomic reservation, and price lock
  -> model execution, settlement, and capacity release
```

The router uses two capacity boundaries for each model pool:

- `normalCapacity` marks the boundary below which the pool is treated as non-congested;
- `hardCapacity` is the admission limit that an arriving request may not reach or exceed.

These values are simulation and routing parameters. The capacity estimates used in the paper are derived from endpoint telemetry and workload feasibility checks; they are **not provider-published rate limits**.

## Repository Structure

```text
.
|-- src/                         # React user interface
|-- server/                      # Express API, routing, providers, and configuration
|-- scripts/                     # Data preparation and provider verification utilities
|-- tests/                       # Prototype and shared router tests
|-- evaluation/
|   |-- code/                    # Shared simulation and evaluation implementation
|   `-- results/
|       `-- 2026-08-18-decoupled-queue-law/
|           |-- code/            # Latest quality-first experiment implementation
|           |-- input/           # Frozen model, task, threshold, and scenario inputs
|           |-- output*/         # Stored results for queue-law variants
|           |-- tests/           # Experiment-specific tests
|           `-- code/
|               |-- quality_first_user/
|               |-- price_first_user/
|               |-- ablation/
|               `-- parameter_sensitive/
|-- models.example.json         # Safe model-configuration template
|-- .env.example                # Safe environment-variable template
`-- package.json                # Development and evaluation commands
```

The main reproducibility target is [`evaluation/results/2026-08-18-decoupled-queue-law`](evaluation/results/2026-08-18-decoupled-queue-law). Older dated result directories are retained as provenance and development history; new reproductions should start from the 2026-08-18 suite.

## Requirements

- Node.js 20 or later
- npm
- Python 3.10 or later for analysis and figure generation
- Python packages: Matplotlib, NumPy, pandas, and SciPy

Install the JavaScript dependencies from the repository root:

```bash
npm install
```

Install the plotting dependencies in a Python virtual environment of your choice:

```bash
python -m pip install matplotlib numpy pandas scipy
```

On Windows systems where PowerShell blocks `npm.ps1`, use `npm.cmd` and `npx.cmd` in place of `npm` and `npx`.

## Reproducing the Latest Evaluation

All commands in this section are run from the repository root. The simulations use frozen local inputs and do not require provider API keys.

Define the experiment path for convenience:

```bash
EXP="evaluation/results/2026-08-18-decoupled-queue-law"
```

PowerShell equivalent:

```powershell
$PQCAP_EXP = "evaluation/results/2026-08-18-decoupled-queue-law"
```

### Quality-first evaluation

Run the single-seed smoke driver:

```bash
npx tsx "$EXP/code/smoke-run.ts"
```

Run the full default evaluation:

```bash
npx tsx "$EXP/code/run.ts"
```

Validate the stored experiment artifacts:

```bash
npx tsx "$EXP/code/validate.ts"
```

PowerShell users can run the same entry points as follows:

```powershell
npx.cmd tsx "$PQCAP_EXP/code/smoke-run.ts"
npx.cmd tsx "$PQCAP_EXP/code/run.ts"
npx.cmd tsx "$PQCAP_EXP/code/validate.ts"
```

### Queue-law robustness

The default environment queue law is linear:

```text
T_queue = 4 * T_base * x
```

where `x` is normalized soft congestion between the normal-load and hard-capacity boundaries. A quadratic law provides a robustness check, while the legacy odds law reproduces the earlier queue model.

The full variant driver reads the following environment variables:

| Variable | Values | Purpose |
|---|---|---|
| `QUEUE_LAW` | `linear`, `quadratic`, or `odds` | Selects the environment queue law |
| `OUTPUT_SUBDIR` | directory name | Selects the output directory below the experiment root |
| `LAMBDA0` | positive number, optional | Freezes the arrival rate for a controlled cross-law comparison |

Example for the quadratic variant on macOS or Linux:

```bash
QUEUE_LAW=quadratic OUTPUT_SUBDIR=output-quadratic \
  npx tsx "$EXP/code/full-run-variant.ts"
```

PowerShell equivalent:

```powershell
$env:QUEUE_LAW = "quadratic"
$env:OUTPUT_SUBDIR = "output-quadratic"
npx.cmd tsx "$PQCAP_EXP/code/full-run-variant.ts"
```

Set the optional `LAMBDA0` to use the same frozen arrival rate across laws. Leave it unset to recalibrate the arrival rate under the selected law.

### Price-sensitive evaluation

Run the candidate-space preflight before the full experiment:

```bash
npx tsx "$EXP/figures+code/price_first_user/code/run.ts" --preflight
```

Run and validate the price-sensitive experiment:

```bash
npx tsx "$EXP/figures+code/price_first_user/code/run.ts"
npx tsx "$EXP/figures+code/price_first_user/code/validate.ts"
```

### Ablation study

The ablation pipeline separates input freezing, soft-congestion calibration, formal execution, and validation:

```bash
npx tsx "$EXP/figures+code/ablation/code/run.ts" --freeze-inputs
npx tsx "$EXP/figures+code/ablation/code/run.ts" --calibrate-soft-congestion
npx tsx "$EXP/figures+code/ablation/code/run.ts" --formal
npx tsx "$EXP/figures+code/ablation/code/validate.ts"
```

The paired ablations remove quality filtering, dynamic CAP, hard-cap admission, or the complete capacity-awareness bundle. Outputs include per-seed effects, confidence intervals, cohort interactions, success gates, and hashed manifests.

### Parameter sensitivity

The sensitivity suite varies the difficulty-dependent quality tolerance and the relative-congestion coefficient. Its formal implementation and Python analysis utilities are located at:

```text
evaluation/results/2026-08-18-decoupled-queue-law/figures+code/parameter_sensitive/
```

The checked-in `output-linear/` and `output-quadratic/` directories contain aggregate results, paired effects, interaction tables, validation metadata, and reports for the corresponding queue laws.

## Regenerating Figures

Generate the quality-first scenario panels:

```bash
python "$EXP/figures+code/quality_first_user/plot_s1_individual_panels.py"
```

Generate the price-sensitive figures and queue-wait distribution:

```bash
python "$EXP/figures+code/price_first_user/plot_price_first_figures.py"
python "$EXP/figures+code/price_first_user/plot_price_first_raincloud.py"
```

Generate the ablation figures:

```bash
python "$EXP/figures+code/ablation/plot/plot_figure4.py"
python "$EXP/figures+code/ablation/plot/plot_figure4.py" --heatmap
```

Generate the parameter-sensitivity figures:

```bash
python "$EXP/figures+code/parameter_sensitive/code/plot_figures.py"
```

The scripts resolve their inputs relative to their own experiment directories and export publication-oriented PDF and raster artifacts alongside the corresponding figure code.

## Running the Router Prototype

The prototype provides a browser interface backed by an Express server. It can classify a request, construct the eligible model set, apply the selected user preference, reserve capacity, lock a quote, and stream the selected provider response.

Create local configuration files from the safe templates:

```bash
cp .env.example .env
cp models.example.json models.json
```

PowerShell equivalent:

```powershell
Copy-Item .env.example .env
Copy-Item models.example.json models.json
```

Add only the provider credentials and model identifiers you intend to use, then start the development server:

```bash
npm run dev
```

Open <http://localhost:8787>.

The automatic request classifier is configured through `routerModelId`. It is called directly rather than routed through PQ-CAP, avoiding a circular routing dependency. Model entries in `models.json` define provider endpoints, API-key environment variables, token prices, capacity parameters, capabilities, and task-conditioned quality scores.

### API and cost safety

- Unit tests, local simulations, stored-result analysis, and figure generation do not require API keys.
- Interactive model calls, real trace collection, and provider verification commands can consume paid API tokens.
- API keys are read server-side from `.env`; do not place credentials in `models.json`, source files, logs, issues, or committed experiment artifacts.
- Provider model IDs, prices, and availability change over time. Recheck them before collecting new live measurements.

## Tests and Static Checks

Run the repository test suite:

```bash
npm test
```

Run only the latest quality-first experiment tests:

```bash
npx vitest run "$EXP/tests"
```

Run the application type check and production build:

```bash
npm run build
```

Experiment-specific test suites are colocated with their implementations under `figures+code/*/tests`.

## Data Provenance and Interpretation

- **Model catalog:** 35-model snapshot derived from OpenRouter model metadata, prices, capabilities, and endpoint telemetry.
- **Quality data:** task-conditioned scores derived from an OpenEvals leaderboard snapshot; explicitly marked proxy scores are used where a compatible task-specific measurement is unavailable.
- **Workload:** 18 task templates covering coding, mathematics, reasoning, writing, translation, and general question answering across three difficulty levels. Sources include LiveCodeBench, LiveBench, IFEval, FLORES-200, and MMLU-Pro.
- **Capacity parameters:** normal-load and hard-capacity boundaries estimated for simulation from endpoint telemetry and workload-derived feasibility floors. They should not be interpreted as provider guarantees or published quotas.
- **Live execution:** the router prototype can call external providers, but the paper's main comparative results are produced by the reproducible simulation pipeline over frozen inputs.

Prices, model availability, benchmark values, and provider behavior are time-dependent. Preserve the supplied snapshots when reproducing the paper, and create a new dated result directory when updating external data.

## Citation

If you use PQ-CAP or its evaluation artifacts, please cite the project as a preprint until formal publication metadata becomes available:

```bibtex
@misc{shi2026pqcap,
  title        = {PQ-CAP: Congestion-Aware Pricing and Routing for LLM Aggregators},
  author       = {Jiawei Shi and Yebo Feng and Konglin Zhu and Lin Zhang and Jiahua Xu},
  year         = {2026},
  howpublished = {GitHub repository},
  url          = {https://github.com/shijiawei0509/PQ_CAP_project}
}
```

## License

No open-source license file is currently included in this repository. Public visibility alone does not grant permission to copy, modify, or redistribute the code. Please contact the authors before reuse until a license is added.

## Contact

For questions about the project or paper, contact:

- Jiawei Shi — `shijiawei@bupt.edu.cn`
- Yebo Feng — `yebo.feng@ntu.edu.sg`
- Konglin Zhu — `klzhu@bupt.edu.cn`
