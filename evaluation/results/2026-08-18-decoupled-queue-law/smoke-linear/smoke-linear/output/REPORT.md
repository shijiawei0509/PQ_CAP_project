# Quality-First Threshold-Queue Experiment Report

## Mechanism result

**SUPPORTED**

The success gate uses non-congestion rate and P95 queue wait only. Gini is reported but is not a required-success criterion.

## S1

| Method | Quality | P95 TTFT ms | P95 queue ms | Gini | Completion | Non-congested |
|---|---:|---:|---:|---:|---:|---:|
| best-single | 0.850000 | 54111.487 | 0.000 | 0.228028 | 0.662000 | 1.000000 |
| cheapest-eligible | 0.857873 | 16533.923 | 12703.142 | 0.228099 | 1.000000 | 0.169500 |
| irt-router-style | 0.866098 | 53650.068 | 0.000 | 0.228027 | 1.000000 | 1.000000 |
| least-loaded-eligible | 0.864586 | 53650.068 | 0.000 | 0.228024 | 1.000000 | 1.000000 |
| mixllm-style | 0.857886 | 16533.923 | 12703.142 | 0.228099 | 1.000000 | 0.170500 |
| openrouter-performance-style | 0.860063 | 16533.923 | 12703.142 | 0.228099 | 1.000000 | 0.338000 |
| ours | 0.866098 | 53650.068 | 0.000 | 0.228027 | 1.000000 | 1.000000 |

## S2

| Method | Quality | P95 TTFT ms | P95 queue ms | Gini | Completion | Non-congested |
|---|---:|---:|---:|---:|---:|---:|
| best-single | 0.850000 | 54464.803 | 0.000 | 0.227995 | 0.666500 | 1.000000 |
| cheapest-eligible | 0.858103 | 16526.253 | 12677.521 | 0.228102 | 1.000000 | 0.181000 |
| irt-router-style | 0.866262 | 53876.777 | 0.000 | 0.227992 | 1.000000 | 1.000000 |
| least-loaded-eligible | 0.864871 | 53876.777 | 0.000 | 0.227989 | 1.000000 | 1.000000 |
| mixllm-style | 0.858116 | 16526.253 | 12677.521 | 0.228102 | 1.000000 | 0.182000 |
| openrouter-performance-style | 0.860124 | 16526.253 | 12677.521 | 0.228101 | 1.000000 | 0.336500 |
| ours | 0.866262 | 53876.777 | 0.000 | 0.227992 | 1.000000 | 1.000000 |

## S3

| Method | Quality | P95 TTFT ms | P95 queue ms | Gini | Completion | Non-congested |
|---|---:|---:|---:|---:|---:|---:|
| best-single | 0.850000 | 54165.053 | 0.000 | 0.228029 | 0.648000 | 1.000000 |
| cheapest-eligible | 0.859831 | 16552.171 | 12691.788 | 0.228099 | 1.000000 | 0.206000 |
| irt-router-style | 0.867643 | 53686.123 | 0.000 | 0.228027 | 1.000000 | 1.000000 |
| least-loaded-eligible | 0.866288 | 53686.123 | 0.000 | 0.228025 | 1.000000 | 1.000000 |
| mixllm-style | 0.859844 | 16552.171 | 12691.788 | 0.228099 | 1.000000 | 0.207000 |
| openrouter-performance-style | 0.861788 | 16552.171 | 12691.788 | 0.228098 | 1.000000 | 0.356500 |
| ours | 0.867643 | 53686.123 | 0.000 | 0.228027 | 1.000000 | 1.000000 |

## Pre-registered checks

- S1 nonCongestedRate vs best-single: PASS (paired mean 0)
- S1 p95QueueWaitMs vs best-single: PASS (paired mean 0)
- S1 completionRate vs cheapest-eligible: PASS (paired mean 0)
- S2 nonCongestedRate vs best-single: PASS (paired mean 0)
- S2 p95QueueWaitMs vs best-single: PASS (paired mean 0)
- S2 completionRate vs cheapest-eligible: PASS (paired mean 0)
- S3 nonCongestedRate vs best-single: PASS (paired mean 0)
- S3 p95QueueWaitMs vs best-single: PASS (paired mean 0)
- S3 completionRate vs cheapest-eligible: PASS (paired mean 0)

No figures were generated.
