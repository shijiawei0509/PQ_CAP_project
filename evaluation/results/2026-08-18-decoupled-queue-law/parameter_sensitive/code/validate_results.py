from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output"
FIGURES = ROOT / "figures"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    aggregate = pd.read_csv(OUTPUT / "aggregate.csv")
    per_seed = pd.read_csv(OUTPUT / "per-seed.csv")
    expected_figures = [
        FIGURES / f"{stem}.{extension}"
        for stem in [
            "fig1_difficulty_tolerance_sensitivity",
            "fig2_difficulty_aware_vs_uniform",
            "fig3_relative_congestion_sensitivity",
            "fig4_local_interaction",
        ]
        for extension in ["png", "pdf", "svg"]
    ]

    request_rows = 0
    with gzip.open(OUTPUT / "per-request.csv.gz", "rt", encoding="utf-8") as handle:
        next(handle)
        for request_rows, _ in enumerate(handle, start=1):
            pass

    checks = {
        "perRequestRows": request_rows == 348_000,
        "perSeedRows": len(per_seed) == 696,
        "aggregateRows": len(aggregate) == 116,
        "sixSeedsPerAggregate": bool((aggregate.seedCount == 6).all()),
        "allFiniteAggregateMetrics": bool(
            aggregate.drop(columns=["deltaScale"])
            .select_dtypes(include="number").notna().all().all()
        ),
        "allCompletionRatesValid": bool(
            aggregate.completionRateMean.between(0, 1).all()
        ),
        "allSloRatesValid": bool(aggregate.sloSuccessRateMean.between(0, 1).all()),
        "allFigureFormatsPresent": all(path.is_file() and path.stat().st_size > 1000
                                       for path in expected_figures),
        "pilotPassed": json.loads(
            (ROOT / "pilot" / "activation-audit.json").read_text(encoding="utf-8")
        )["status"] == "PASS",
    }
    if not all(checks.values()):
        raise AssertionError({key: value for key, value in checks.items() if not value})

    artifacts = sorted(
        [path for path in OUTPUT.iterdir() if path.name != "manifest.json"]
        + expected_figures
    )
    manifest = {
        "status": "PASS",
        "checks": checks,
        "artifacts": [
            {
                "path": str(path.relative_to(ROOT)),
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
            for path in artifacts
        ],
    }
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(json.dumps(checks, indent=2))


if __name__ == "__main__":
    main()
