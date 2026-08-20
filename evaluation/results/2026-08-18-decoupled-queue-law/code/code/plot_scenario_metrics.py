"""Plot the five registered aggregate metrics for S1, S2, and S3."""

from __future__ import annotations

from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
import numpy as np
import pandas as pd


HERE = Path(__file__).resolve().parent
RESULT_ROOT = HERE.parent
AGGREGATE_PATH = RESULT_ROOT / "output" / "aggregate.csv"
SCENARIOS = ("S1", "S2", "S3")
METHODS = (
    "ours",
    "best-single",
    "cheapest-eligible",
    "irt-router-style",
    "mixllm-style",
    "openrouter-performance-style",
    "least-loaded-eligible",
)
METHOD_LABELS = {
    "ours": "Ours",
    "best-single": "Best Single",
    "cheapest-eligible": "Cheapest Eligible",
    "irt-router-style": "IRT-style",
    "mixllm-style": "MixLLM-style",
    "openrouter-performance-style": "OpenRouter Performance",
    "least-loaded-eligible": "Least-loaded Eligible",
}
METHOD_TICKS = {
    "ours": "Ours",
    "best-single": "Best",
    "cheapest-eligible": "Cheap",
    "irt-router-style": "IRT",
    "mixllm-style": "MixLLM",
    "openrouter-performance-style": "OR-Perf",
    "least-loaded-eligible": "Least",
}
METHOD_COLORS = {
    "ours": "#245B8A",
    "best-single": "#8C8C8C",
    "cheapest-eligible": "#3C8D87",
    "irt-router-style": "#7D6AA5",
    "mixllm-style": "#D9923B",
    "openrouter-performance-style": "#A9C8E2",
    "least-loaded-eligible": "#B36A7C",
}
METHOD_HATCHES = {
    "ours": "///",
    "best-single": "\\\\\\",
    "cheapest-eligible": "xxx",
    "irt-router-style": "...",
    "mixllm-style": "++",
    "openrouter-performance-style": "oo",
    "least-loaded-eligible": "--",
}
PANELS = (
    ("p95QueueWaitMs", "P95 queue wait (ms)", "lower"),
    ("nonCongestedRate", "Non-congested rate", "higher"),
    ("loadGini", "Normalized-load Gini", "lower"),
    ("completionRate", "Completion rate", "higher"),
    ("averageQuality", "Average quality", "higher"),
)
BLACK = "#202020"
GRID = "#E6E6E6"


def configure_style() -> None:
    mpl.rcParams.update(
        {
            "font.family": "serif",
            "font.serif": ["Times New Roman", "Times", "DejaVu Serif"],
            "mathtext.fontset": "stix",
            "font.size": 8.5,
            "axes.labelsize": 9.2,
            "xtick.labelsize": 7.3,
            "ytick.labelsize": 7.8,
            "legend.fontsize": 7.4,
            "axes.linewidth": 0.85,
            "axes.edgecolor": BLACK,
            "axes.unicode_minus": False,
            "legend.frameon": False,
            "savefig.bbox": "tight",
            "savefig.facecolor": "white",
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
            "hatch.linewidth": 0.75,
        }
    )


def validate_source(data: pd.DataFrame) -> None:
    required = {"scenario", "method", "seedCount"}
    for metric, _, _ in PANELS:
        required.update({f"{metric}Mean", f"{metric}Std"})
    missing = sorted(required.difference(data.columns))
    if missing:
        raise ValueError(f"Aggregate CSV is missing columns: {missing}")
    expected = {(scenario, method) for scenario in SCENARIOS for method in METHODS}
    observed = set(zip(data["scenario"], data["method"]))
    if observed != expected:
        raise ValueError(
            f"Expected exactly {len(expected)} scenario-method rows; "
            f"missing={sorted(expected - observed)}, extra={sorted(observed - expected)}"
        )
    if not data["seedCount"].eq(6).all():
        raise ValueError("Every aggregate row must contain six seeds")
    metric_columns = [
        column
        for metric, _, _ in PANELS
        for column in (f"{metric}Mean", f"{metric}Std")
    ]
    if not np.isfinite(data[metric_columns].to_numpy(dtype=float)).all():
        raise ValueError("All plotted means and standard deviations must be finite")
    for metric in ("nonCongestedRate", "completionRate", "averageQuality"):
        values = data[f"{metric}Mean"]
        if not values.between(0, 1).all():
            raise ValueError(f"{metric} means must lie in [0, 1]")


def all_spines(ax: mpl.axes.Axes) -> None:
    for spine in ax.spines.values():
        spine.set_visible(True)
        spine.set_linewidth(0.85)
        spine.set_color(BLACK)
    ax.tick_params(direction="out", width=0.75, length=3)


def clipped_error(values: np.ndarray, errors: np.ndarray, bounded: bool) -> np.ndarray:
    lower = np.minimum(errors, values)
    if bounded:
        upper = np.minimum(errors, 1.0 - values)
    else:
        upper = errors
    return np.vstack((lower, np.maximum(upper, 0.0)))


def panel_limits(metric: str, values: np.ndarray, errors: np.ndarray) -> tuple[float, float]:
    if metric in {"nonCongestedRate", "completionRate"}:
        return 0.0, 1.05
    if metric == "p95QueueWaitMs":
        return 0.0, max(1.0, float(np.max(values + errors)) * 1.08)
    low = float(np.min(values - errors))
    high = float(np.max(values + errors))
    padding = max((high - low) * 0.15, 0.001)
    if metric == "averageQuality":
        return max(0.0, low - padding), min(1.0, high + padding)
    return max(0.0, low - padding), high + padding


def draw_panel(
    ax: mpl.axes.Axes,
    ordered: pd.DataFrame,
    metric: str,
    subtitle: str,
    preference: str,
    panel_label: str,
) -> None:
    x = np.arange(len(METHODS), dtype=float)
    values = ordered[f"{metric}Mean"].to_numpy(dtype=float)
    errors = ordered[f"{metric}Std"].to_numpy(dtype=float)
    bounded = metric in {"nonCongestedRate", "completionRate", "averageQuality"}
    yerr = clipped_error(values, errors, bounded)

    for index, method in enumerate(METHODS):
        ax.bar(
            x[index],
            values[index],
            width=0.72,
            color=METHOD_COLORS[method],
            edgecolor=BLACK,
            linewidth=0.7,
            hatch=METHOD_HATCHES[method],
            yerr=yerr[:, index : index + 1],
            error_kw={
                "ecolor": BLACK,
                "elinewidth": 0.75,
                "capsize": 2,
                "capthick": 0.75,
            },
            zorder=3,
        )
    ax.set_xlim(-0.62, len(METHODS) - 0.38)
    ax.set_ylim(*panel_limits(metric, values, errors))
    if metric == "p95QueueWaitMs":
        for index in np.flatnonzero(values == 0):
            ax.annotate(
                "0",
                (x[index], 0),
                xytext=(0, 3),
                textcoords="offset points",
                ha="center",
                va="bottom",
                fontsize=7.0,
            )
    ax.set_xticks(x, [METHOD_TICKS[method] for method in METHODS])
    ax.grid(True, axis="y", color=GRID, linewidth=0.55, zorder=0)
    if metric in {"nonCongestedRate", "completionRate"}:
        ax.yaxis.set_major_formatter(mpl.ticker.PercentFormatter(1.0))
    elif metric == "p95QueueWaitMs":
        ax.yaxis.set_major_formatter(
            mpl.ticker.FuncFormatter(lambda value, _: f"{value:,.0f}")
        )
    all_spines(ax)
    ax.text(
        0.5,
        -0.27,
        f"({panel_label}) {subtitle}",
        transform=ax.transAxes,
        ha="center",
        va="top",
        fontsize=9.0,
    )
    ax.text(
        0.98,
        0.96,
        f"{preference.capitalize()} is better",
        transform=ax.transAxes,
        ha="right",
        va="top",
        fontsize=7.2,
        color="#555555",
        bbox={"facecolor": "white", "edgecolor": "none", "alpha": 0.78, "pad": 1.0},
    )


def make_figure(data: pd.DataFrame, scenario: str) -> None:
    ordered = (
        data.loc[data["scenario"].eq(scenario)]
        .set_index("method")
        .loc[list(METHODS)]
        .reset_index()
    )
    fig, axes = plt.subplots(
        2,
        3,
        figsize=(12.0, 7.4),
        gridspec_kw={"hspace": 0.78, "wspace": 0.28},
    )
    plot_axes = axes.ravel()[:5]
    for index, (ax, (metric, subtitle, preference)) in enumerate(
        zip(plot_axes, PANELS)
    ):
        draw_panel(
            ax,
            ordered,
            metric,
            subtitle,
            preference,
            chr(ord("a") + index),
        )

    legend_ax = axes.ravel()[5]
    legend_ax.axis("off")
    handles = [
        Patch(
            facecolor=METHOD_COLORS[method],
            edgecolor=BLACK,
            hatch=METHOD_HATCHES[method],
            linewidth=0.7,
            label=METHOD_LABELS[method],
        )
        for method in METHODS
    ]
    legend_ax.legend(
        handles=handles,
        loc="center",
        ncol=1,
        handlelength=2.2,
        handleheight=1.2,
        labelspacing=0.75,
        title="Routing mechanism",
        title_fontsize=8.4,
    )
    legend_ax.text(
        0.5,
        0.08,
        "Bars: mean across 6 seeds\nWhiskers: sample standard deviation",
        transform=legend_ax.transAxes,
        ha="center",
        va="bottom",
        fontsize=7.6,
        color="#555555",
        linespacing=1.35,
    )
    fig.text(
        0.5,
        0.008,
        f"{scenario} scenario: routing-mechanism comparison",
        ha="center",
        va="bottom",
        fontsize=10.0,
        fontstyle="italic",
    )
    fig.subplots_adjust(left=0.06, right=0.985, bottom=0.14, top=0.985)
    stem = RESULT_ROOT / f"{scenario.lower()}_mechanism_metrics"
    fig.savefig(stem.with_suffix(".png"), dpi=300)
    fig.savefig(stem.with_suffix(".pdf"))
    fig.savefig(stem.with_suffix(".svg"))
    plt.close(fig)


def generate_all() -> None:
    configure_style()
    if not AGGREGATE_PATH.exists():
        raise FileNotFoundError(f"Verified aggregate data not found: {AGGREGATE_PATH}")
    data = pd.read_csv(AGGREGATE_PATH)
    validate_source(data)
    for scenario in SCENARIOS:
        make_figure(data, scenario)


if __name__ == "__main__":
    generate_all()
