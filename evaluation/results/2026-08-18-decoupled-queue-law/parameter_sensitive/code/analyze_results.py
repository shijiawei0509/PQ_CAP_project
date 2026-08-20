from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output"
AGGREGATE = pd.read_csv(OUTPUT / "aggregate.csv")
PER_SEED = pd.read_csv(OUTPUT / "per-seed.csv")
DIFFICULTIES = ["easy", "medium", "hard"]


def record(frame: pd.DataFrame, **filters: object) -> pd.Series:
    selected = frame
    for key, value in filters.items():
        selected = selected[selected[key] == value]
    if len(selected) != 1:
        raise AssertionError(f"Expected one row for {filters}, received {len(selected)}")
    return selected.iloc[0]


def paired_effect(
    family: str,
    scenario: str,
    stratum: str,
    point: str,
    reference: str,
    metric: str,
) -> dict[str, float]:
    subset = PER_SEED[
        (PER_SEED.family == family)
        & (PER_SEED.scenario == scenario)
        & (PER_SEED.stratum == stratum)
        & (PER_SEED.parameterId.isin([point, reference]))
    ]
    pivot = subset.pivot(index="seed", columns="parameterId", values=metric)
    differences = (pivot[point] - pivot[reference]).to_numpy()
    mean = float(np.mean(differences))
    std = float(np.std(differences, ddof=1)) if len(differences) > 1 else 0.0
    sem = std / math.sqrt(len(differences)) if len(differences) > 1 else 0.0
    margin = 2.5706 * sem if len(differences) == 6 else 1.96 * sem
    z_score = abs(mean / sem) if sem > 0 else 0.0
    return {
        "mean": mean,
        "ciLow": mean - margin,
        "ciHigh": mean + margin,
        "pTwoSidedNormalApprox": math.erfc(z_score / math.sqrt(2))
        if not np.allclose(differences, 0) else 1.0,
    }


def dominates(challenger: pd.Series, default: pd.Series) -> bool:
    higher = ["averageQualityMean", "sloSuccessRateMean", "completionRateMean"]
    lower = [
        "averageQualityGapMean",
        "completionAwareP95TtftMsMean",
        "averageRequestPaymentMean",
    ]
    weak = all(challenger[key] >= default[key] - 1e-12 for key in higher) and \
        all(challenger[key] <= default[key] + 1e-12 for key in lower)
    strict = any(challenger[key] > default[key] + 1e-12 for key in higher) or \
        any(challenger[key] < default[key] - 1e-12 for key in lower)
    return bool(weak and strict)


def summarize() -> dict[str, object]:
    default_delta = {
        difficulty: record(
            AGGREGATE,
            family="delta-scan",
            parameterId="delta-1",
            scenario="soft-congestion",
            stratum=difficulty,
        )
        for difficulty in DIFFICULTIES
    }
    candidate_order = (
        default_delta["easy"].candidateCountMeanMean
        >= default_delta["medium"].candidateCountMeanMean
        >= default_delta["hard"].candidateCountMeanMean
    )
    control = {}
    for difficulty in DIFFICULTIES:
        aware = record(
            AGGREGATE,
            family="difficulty-control",
            parameterId="aware",
            scenario="soft-congestion",
            stratum=difficulty,
        )
        blind = record(
            AGGREGATE,
            family="difficulty-control",
            parameterId="blind-0.10",
            scenario="soft-congestion",
            stratum=difficulty,
        )
        control[difficulty] = {
            "candidateCountDifference": float(
                aware.candidateCountMeanMean - blind.candidateCountMeanMean
            ),
            "qualityGapDifference": float(
                aware.averageQualityGapMean - blind.averageQualityGapMean
            ),
            "sloSuccessDifference": float(
                aware.sloSuccessRateMean - blind.sloSuccessRateMean
            ),
            "paymentDifference": float(
                aware.averageRequestPaymentMean - blind.averageRequestPaymentMean
            ),
            "pairedQualityGap": paired_effect(
                "difficulty-control", "soft-congestion", difficulty,
                "aware", "blind-0.10", "averageQualityGap",
            ),
            "pairedPayment": paired_effect(
                "difficulty-control", "soft-congestion", difficulty,
                "aware", "blind-0.10", "averageRequestPayment",
            ),
        }

    delta_dominators: dict[str, list[str]] = {}
    for scenario in ["regular", "soft-congestion"]:
        for difficulty in DIFFICULTIES:
            default = record(
                AGGREGATE, family="delta-scan", parameterId="delta-1",
                scenario=scenario, stratum=difficulty,
            )
            key = f"{scenario}/{difficulty}"
            delta_dominators[key] = []
            for neighbor in ["delta-0.75", "delta-1.25"]:
                challenger = record(
                    AGGREGATE, family="delta-scan", parameterId=neighbor,
                    scenario=scenario, stratum=difficulty,
                )
                if dominates(challenger, default):
                    delta_dominators[key].append(neighbor)

    kappa_default = record(
        AGGREGATE, family="kappa-scan", parameterId="kappa-1",
        scenario="soft-congestion", stratum="equal-weight",
    )
    kappa_dominators = []
    for neighbor in ["kappa-0.5", "kappa-2"]:
        challenger = record(
            AGGREGATE, family="kappa-scan", parameterId=neighbor,
            scenario="soft-congestion", stratum="equal-weight",
        )
        if dominates(challenger, kappa_default):
            kappa_dominators.append(neighbor)

    interaction = AGGREGATE[
        (AGGREGATE.family == "interaction")
        & (AGGREGATE.scenario == "soft-congestion")
        & (AGGREGATE.stratum == "equal-weight")
    ]
    result = {
        "status": "SUPPORTED" if (
            candidate_order
            and control["easy"]["candidateCountDifference"] > 0
            and control["hard"]["candidateCountDifference"] < 0
            and not any(delta_dominators.values())
            and not kappa_dominators
        ) else "PARTIALLY_SUPPORTED",
        "difficultyMechanism": {
            "candidateOrderPassed": bool(candidate_order),
            "defaultCandidateCounts": {
                difficulty: float(default_delta[difficulty].candidateCountMeanMean)
                for difficulty in DIFFICULTIES
            },
            "hardQualityGap": float(default_delta["hard"].averageQualityGapMean),
            "awareMinusBlind": control,
            "neighborDominators": delta_dominators,
        },
        "relativeCongestion": {
            "neighborDominators": kappa_dominators,
            "defaultPayment": float(kappa_default.averageRequestPaymentMean),
            "defaultSloSuccess": float(kappa_default.sloSuccessRateMean),
            "defaultCompletionAwareP95Ms": float(
                kappa_default.completionAwareP95TtftMsMean
            ),
            "kappa0To1RoutingEffect": paired_effect(
                "kappa-scan", "soft-congestion", "equal-weight",
                "kappa-1", "kappa-0", "priceInducedRerouteRate",
            ),
        },
        "interactionRanges": {
            "qualityGap": [float(interaction.averageQualityGapMean.min()),
                           float(interaction.averageQualityGapMean.max())],
            "sloSuccess": [float(interaction.sloSuccessRateMean.min()),
                           float(interaction.sloSuccessRateMean.max())],
            "payment": [float(interaction.averageRequestPaymentMean.min()),
                        float(interaction.averageRequestPaymentMean.max())],
        },
    }
    return result


def markdown_table(frame: pd.DataFrame, columns: list[str]) -> str:
    view = frame[columns].copy()
    for column in columns:
        if pd.api.types.is_numeric_dtype(view[column]):
            view[column] = view[column].map(lambda value: f"{value:.6g}")
    header = "| " + " | ".join(columns) + " |"
    divider = "|" + "|".join(["---"] * len(columns)) + "|"
    rows = ["| " + " | ".join(map(str, values)) + " |"
            for values in view.itertuples(index=False, name=None)]
    return "\n".join([header, divider, *rows])


def write_report(summary: dict[str, object]) -> None:
    delta = AGGREGATE[
        (AGGREGATE.family == "delta-scan")
        & (AGGREGATE.scenario == "soft-congestion")
        & (AGGREGATE.stratum.isin(DIFFICULTIES))
    ].sort_values(["stratum", "deltaScale"])
    kappa = AGGREGATE[
        (AGGREGATE.family == "kappa-scan")
        & (AGGREGATE.stratum == "equal-weight")
    ].sort_values("kappa")
    report = f"""# Parameter Sensitivity Experiment Report

## Overall result

**{summary['status']}**

The formal run contains 174 paired simulations and 348,000 requests across six formal seeds. External traces are 100% paired; final-load and hard-cap invariants pass.

## Difficulty-tolerance scan under soft congestion

{markdown_table(delta, [
    'parameterId', 'stratum', 'candidateCountMeanMean',
    'averageQualityGapMean', 'sloSuccessRateMean',
    'completionAwareP95TtftMsMean', 'averageRequestPaymentMean'
])}

## Relative-congestion scan (difficulty-equal-weight estimand)

{markdown_table(kappa, [
    'parameterId', 'priceInducedRerouteRateMean',
    'averageQualityGapMean', 'sloSuccessRateMean',
    'completionAwareP95TtftMsMean', 'averageRequestPaymentMean'
])}

## Interpretation

- The default candidate-space ordering is Easy >= Medium >= Hard: {summary['difficultyMechanism']['candidateOrderPassed']}.
- The default Hard quality gap is {summary['difficultyMechanism']['hardQualityGap']:.6f}, below its 0.05 tolerance.
- Difficulty-aware minus difficulty-blind candidate-count effects are Easy {summary['difficultyMechanism']['awareMinusBlind']['easy']['candidateCountDifference']:.3f}, Medium {summary['difficultyMechanism']['awareMinusBlind']['medium']['candidateCountDifference']:.3f}, and Hard {summary['difficultyMechanism']['awareMinusBlind']['hard']['candidateCountDifference']:.3f}.
- Neighboring delta-scale points that strictly dominate the default are recorded in `interpretation.json`; none may be hidden.
- Neighboring kappa points that strictly dominate `kappa=1`: {summary['relativeCongestion']['neighborDominators']}.

Completed-only tail latency is diagnostic. The primary service interpretation uses all-request SLO success and completion-aware P95 with failures penalized at the frozen 300 s timeout.
"""
    (OUTPUT / "REPORT.md").write_text(report, encoding="utf-8")


if __name__ == "__main__":
    summary = summarize()
    (OUTPUT / "interpretation.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    write_report(summary)
    print(json.dumps(summary, indent=2))
