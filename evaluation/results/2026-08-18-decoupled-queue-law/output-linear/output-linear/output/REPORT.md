# Quality-First Threshold-Queue Experiment Report

## Mechanism result

**SUPPORTED**

The success gate uses non-congestion rate and P95 queue wait only. Gini is reported but is not a required-success criterion.

## S1

| Method | Quality | P95 TTFT ms | P95 queue ms | Gini | Completion | Non-congested |
|---|---:|---:|---:|---:|---:|---:|
| best-single | 0.850000 | 126986.082 | 72845.531 | 0.226620 | 0.657500 | 0.410623 |
| cheapest-eligible | 0.853380 | 15034.564 | 11210.070 | 0.226558 | 1.000000 | 0.389500 |
| irt-router-style | 0.865771 | 124662.703 | 71325.176 | 0.226622 | 1.000000 | 0.450500 |
| least-loaded-eligible | 0.857373 | 38856.545 | 0.000 | 0.226523 | 1.000000 | 0.999667 |
| mixllm-style | 0.856896 | 13570.722 | 9478.231 | 0.226555 | 1.000000 | 0.612917 |
| openrouter-performance-style | 0.857124 | 11792.356 | 5248.203 | 0.226551 | 1.000000 | 0.721417 |
| ours | 0.858241 | 38856.545 | 0.000 | 0.226524 | 1.000000 | 0.999667 |

## S2

| Method | Quality | P95 TTFT ms | P95 queue ms | Gini | Completion | Non-congested |
|---|---:|---:|---:|---:|---:|---:|
| best-single | 0.850000 | 128851.446 | 74937.543 | 0.226649 | 0.655000 | 0.412391 |
| cheapest-eligible | 0.853090 | 15090.407 | 11251.991 | 0.226560 | 1.000000 | 0.389167 |
| irt-router-style | 0.865456 | 125497.371 | 71935.861 | 0.226651 | 1.000000 | 0.457833 |
| least-loaded-eligible | 0.857060 | 38945.149 | 0.000 | 0.226506 | 1.000000 | 0.999750 |
| mixllm-style | 0.856568 | 13521.460 | 9257.901 | 0.226554 | 1.000000 | 0.611917 |
| openrouter-performance-style | 0.856794 | 11662.250 | 4977.357 | 0.226549 | 1.000000 | 0.721917 |
| ours | 0.857939 | 38945.149 | 0.000 | 0.226509 | 1.000000 | 0.999750 |

## S3

| Method | Quality | P95 TTFT ms | P95 queue ms | Gini | Completion | Non-congested |
|---|---:|---:|---:|---:|---:|---:|
| best-single | 0.850000 | 127213.371 | 73231.246 | 0.226617 | 0.635583 | 0.408891 |
| cheapest-eligible | 0.855737 | 15126.173 | 11338.018 | 0.226559 | 1.000000 | 0.384167 |
| irt-router-style | 0.867533 | 124714.733 | 71291.961 | 0.226619 | 1.000000 | 0.446167 |
| least-loaded-eligible | 0.859320 | 39139.393 | 0.000 | 0.226522 | 1.000000 | 0.999750 |
| mixllm-style | 0.859112 | 13738.249 | 9640.164 | 0.226555 | 1.000000 | 0.601083 |
| openrouter-performance-style | 0.859150 | 11906.773 | 5279.596 | 0.226551 | 1.000000 | 0.717583 |
| ours | 0.860151 | 39139.126 | 0.000 | 0.226524 | 1.000000 | 0.999750 |

## Pre-registered checks

- S1 nonCongestedRate vs least-loaded-eligible: PASS (paired mean 0)
- S1 p95QueueWaitMs vs least-loaded-eligible: PASS (paired mean 0)
- S1 completionRate vs cheapest-eligible: PASS (paired mean 0)
- S2 nonCongestedRate vs least-loaded-eligible: PASS (paired mean 0)
- S2 p95QueueWaitMs vs least-loaded-eligible: PASS (paired mean 0)
- S2 completionRate vs cheapest-eligible: PASS (paired mean 0)
- S3 nonCongestedRate vs least-loaded-eligible: PASS (paired mean 0)
- S3 p95QueueWaitMs vs least-loaded-eligible: PASS (paired mean 0)
- S3 completionRate vs cheapest-eligible: PASS (paired mean 0)

No figures were generated.
