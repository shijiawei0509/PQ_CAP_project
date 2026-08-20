# Quality-First Threshold-Queue Experiment Report

## Mechanism result

**SUPPORTED**

The success gate uses non-congestion rate and P95 queue wait only. Gini is reported but is not a required-success criterion.

## S1

| Method | Quality | P95 TTFT ms | P95 queue ms | Gini | Completion | Non-congested |
|---|---:|---:|---:|---:|---:|---:|
| best-single | 0.850000 | 190914.432 | 137324.454 | 0.227836 | 0.474250 | 0.332577 |
| cheapest-eligible | 0.853659 | 25716.290 | 11219.081 | 0.226563 | 1.000000 | 0.419417 |
| irt-router-style | 0.864095 | 184151.095 | 132177.584 | 0.227814 | 1.000000 | 0.567917 |
| least-loaded-eligible | 0.857375 | 38970.691 | 0.000 | 0.225362 | 1.000000 | 0.987417 |
| mixllm-style | 0.856817 | 24255.020 | 9485.337 | 0.226438 | 1.000000 | 0.618583 |
| openrouter-performance-style | 0.857280 | 22488.951 | 5241.683 | 0.226303 | 1.000000 | 0.737250 |
| ours | 0.858219 | 38857.024 | 0.000 | 0.225447 | 1.000000 | 0.989417 |

## S2

| Method | Quality | P95 TTFT ms | P95 queue ms | Gini | Completion | Non-congested |
|---|---:|---:|---:|---:|---:|---:|
| best-single | 0.850000 | 213501.045 | 161290.318 | 0.227908 | 0.416833 | 0.301726 |
| cheapest-eligible | 0.853528 | 26394.103 | 11263.559 | 0.226490 | 0.999917 | 0.432614 |
| irt-router-style | 0.863031 | 197458.066 | 147241.227 | 0.227860 | 0.999417 | 0.593624 |
| least-loaded-eligible | 0.857026 | 39620.053 | 1911.884 | 0.224740 | 0.999917 | 0.969664 |
| mixllm-style | 0.856082 | 24902.686 | 9522.420 | 0.226350 | 0.999917 | 0.616952 |
| openrouter-performance-style | 0.857023 | 23053.825 | 5222.005 | 0.226097 | 0.999917 | 0.742580 |
| ours | 0.857850 | 39011.849 | 515.503 | 0.224922 | 0.999917 | 0.973581 |

## S3

| Method | Quality | P95 TTFT ms | P95 queue ms | Gini | Completion | Non-congested |
|---|---:|---:|---:|---:|---:|---:|
| best-single | 0.850000 | 190622.359 | 136863.361 | 0.227713 | 0.461500 | 0.331134 |
| cheapest-eligible | 0.856051 | 25994.076 | 11338.303 | 0.226555 | 1.000000 | 0.419833 |
| irt-router-style | 0.865935 | 182519.558 | 130708.800 | 0.227703 | 1.000000 | 0.556750 |
| least-loaded-eligible | 0.859305 | 39297.406 | 0.000 | 0.225333 | 1.000000 | 0.983583 |
| mixllm-style | 0.859563 | 24594.510 | 9631.617 | 0.226425 | 1.000000 | 0.645333 |
| openrouter-performance-style | 0.859317 | 22749.953 | 5260.833 | 0.226270 | 1.000000 | 0.735250 |
| ours | 0.860114 | 39181.990 | 0.000 | 0.225417 | 1.000000 | 0.985333 |

## Pre-registered checks

- S1 nonCongestedRate vs least-loaded-eligible: PASS (paired mean 0.0020000000000000018)
- S1 p95QueueWaitMs vs least-loaded-eligible: PASS (paired mean 0)
- S1 completionRate vs cheapest-eligible: PASS (paired mean 0)
- S2 nonCongestedRate vs least-loaded-eligible: PASS (paired mean 0.003916666666666661)
- S2 p95QueueWaitMs vs least-loaded-eligible: PASS (paired mean -1396.3808519675597)
- S2 completionRate vs cheapest-eligible: PASS (paired mean 0)
- S3 nonCongestedRate vs least-loaded-eligible: PASS (paired mean 0.0017500000000000109)
- S3 p95QueueWaitMs vs least-loaded-eligible: PASS (paired mean 0)
- S3 completionRate vs cheapest-eligible: PASS (paired mean 0)

No figures were generated.
