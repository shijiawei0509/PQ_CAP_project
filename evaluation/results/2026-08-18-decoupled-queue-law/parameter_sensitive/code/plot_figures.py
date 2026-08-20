from __future__ import annotations

from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib import font_manager
import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output"
FIGURES = ROOT / "figures"
FIGURES.mkdir(exist_ok=True)

AGG = pd.read_csv(OUTPUT / "aggregate.csv")
SEEDS = pd.read_csv(OUTPUT / "per-seed.csv")

# Muted blue, green, and yellow selected to match the supplied reference figure.
COLORS = {"easy": "#91BBC4", "medium": "#7F9F5D", "hard": "#E5C34B"}
KAPPA_COLOR = "#3A7D9A"
MARKERS = {"easy": "o", "medium": "s", "hard": "^"}
LABELS = {"easy": "Easy", "medium": "Medium", "hard": "Hard"}

DELTA_PANEL_SPECS = [
    ("candidateCountMean", "Mean eligible models", 1.0,
     "(a) Candidate-space size", "difficulty_tolerance_candidate_space"),
    ("averageQualityGap", "Quality gap", 1.0,
     "(b) Quality preservation", "difficulty_tolerance_quality_gap"),
    ("completionAwareP95TtftMs", "Completion-aware P95 TTFT (s)", 1 / 1000,
     "(c) Tail latency", "difficulty_tolerance_p95_ttft"),
    ("averageRequestPayment", "Mean request payment (mUSD)", 1000,
     "(d) Request payment", "difficulty_tolerance_request_payment"),
]

KAPPA_PANEL_SPECS = [
    ("priceInducedRerouteRate", "Price-induced reroute rate (%)", 100,
     "(a) Routing response", "relative_congestion_reroute_rate"),
    ("completionAwareP95TtftMs", "Completion-aware P95 TTFT (s)", 1 / 1000,
     "(b) Tail latency", "relative_congestion_p95_ttft"),
    ("averageRequestPayment", "Mean request payment (mUSD)", 1000,
     "(c) Request payment", "relative_congestion_request_payment"),
    ("averageQualityGap", "Quality gap", 1.0,
     "(d) Quality preservation", "relative_congestion_quality_gap"),
]

for font_path in [
    "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf",
]:
    if Path(font_path).is_file():
        font_manager.fontManager.addfont(font_path)

mpl.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman"],
    "mathtext.fontset": "stix",
    "font.size": 8.5,
    "axes.labelsize": 9,
    "axes.titlesize": 9,
    "legend.fontsize": 8,
    "xtick.labelsize": 8,
    "ytick.labelsize": 8,
    "axes.spines.top": True,
    "axes.spines.right": True,
    "axes.linewidth": 0.8,
    "lines.linewidth": 1.6,
    "savefig.bbox": "tight",
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
})


def panel_caption(ax: plt.Axes, caption: str, y: float = -0.29) -> None:
    ax.text(0.5, y, caption, transform=ax.transAxes, fontsize=9.5,
            ha="center", va="top")


def box_axes(ax: plt.Axes) -> None:
    for spine in ax.spines.values():
        spine.set_visible(True)
        spine.set_linewidth(0.8)


def finish(fig: plt.Figure, stem: str) -> None:
    fig.align_labels()
    fig.savefig(FIGURES / f"{stem}.png", dpi=600, facecolor="white")
    fig.savefig(FIGURES / f"{stem}.pdf", facecolor="white")
    fig.savefig(FIGURES / f"{stem}.svg", facecolor="white")
    plt.close(fig)


def gradient_fill_below(ax: plt.Axes, x: np.ndarray, y: np.ndarray,
                        baseline: float, color: str, steps: int = 32,
                        max_alpha: float = 0.10) -> None:
    """Draw a subtle, non-overlapping vertical fade below a line."""
    distance = y - baseline
    edges = np.linspace(0.0, 1.0, steps + 1)
    for lower_fraction, upper_fraction in zip(edges[:-1], edges[1:]):
        lower = baseline + distance * lower_fraction
        upper = baseline + distance * upper_fraction
        alpha = max_alpha * upper_fraction ** 1.8
        ax.fill_between(x, lower, upper, color=color, alpha=alpha,
                        linewidth=0, edgecolor="none", zorder=0)


def line_panel(ax: plt.Axes, frame: pd.DataFrame, x: str, metric: str,
               ylabel: str, transform: float = 1.0, default: float | None = None,
               seed_frame: pd.DataFrame | None = None) -> None:
    plotted_series: list[tuple[np.ndarray, np.ndarray, str]] = []
    for difficulty in ["easy", "medium", "hard"]:
        part = frame[frame.stratum == difficulty].sort_values(x)
        xv = part[x].to_numpy(float)
        y = part[f"{metric}Mean"].to_numpy(float) * transform
        lo = part[f"{metric}CiLow"].to_numpy(float) * transform
        hi = part[f"{metric}CiHigh"].to_numpy(float) * transform
        color = COLORS[difficulty]
        if seed_frame is not None:
            raw = seed_frame[seed_frame.stratum == difficulty]
            ax.scatter(raw[x], raw[metric] * transform, s=6, alpha=0.11,
                       color=color, edgecolors="none", zorder=2)
        ax.errorbar(xv, y, yerr=np.vstack([y - lo, hi - y]),
                    color=color, marker=MARKERS[difficulty], markersize=4.5,
                    markerfacecolor="white", markeredgewidth=1.1,
                    linewidth=1.9, elinewidth=0.9, capsize=2.2,
                    label=LABELS[difficulty], zorder=5)
        plotted_series.append((xv, y, color))
    if default is not None:
        ax.axvline(default, color="#555555", linestyle="--", linewidth=1,
                   alpha=0.85, zorder=3)
        ax.text(default, 0.90, " default", transform=ax.get_xaxis_transform(),
                ha="left", va="top", color="#555555", fontsize=7.5,
                zorder=6)
    ax.margins(y=0.08)
    ax.autoscale_view()
    baseline = ax.get_ylim()[0]
    for xv, y, color in plotted_series:
        gradient_fill_below(ax, xv, y, baseline, color)
    ax.set_xlabel(r"Tolerance scale $s_\Delta$")
    ax.set_ylabel(ylabel)
    ax.set_axisbelow(True)
    ax.grid(axis="y", color="#dddddd", linewidth=0.6, alpha=0.72)


def plot_delta() -> None:
    frame = AGG[(AGG.family == "delta-scan") &
                (AGG.scenario == "soft-congestion") &
                (AGG.stratum.isin(["easy", "medium", "hard"]))]
    raw = SEEDS[(SEEDS.family == "delta-scan") &
                (SEEDS.scenario == "soft-congestion") &
                (SEEDS.stratum.isin(["easy", "medium", "hard"]))]
    fig, axes = plt.subplots(2, 2, figsize=(7.2, 6.4), constrained_layout=True)
    for ax, (metric, ylabel, scale, caption, _) in zip(axes.flat, DELTA_PANEL_SPECS):
        line_panel(ax, frame, "deltaScale", metric, ylabel, scale, 1.0, raw)
        box_axes(ax)
        panel_caption(ax, caption)
    axes[0, 0].legend(frameon=False, ncol=3, loc="upper left")
    finish(fig, "fig1_difficulty_tolerance_sensitivity")


def plot_delta_panels() -> None:
    frame = AGG[(AGG.family == "delta-scan") &
                (AGG.scenario == "soft-congestion") &
                (AGG.stratum.isin(["easy", "medium", "hard"]))]
    raw = SEEDS[(SEEDS.family == "delta-scan") &
                (SEEDS.scenario == "soft-congestion") &
                (SEEDS.stratum.isin(["easy", "medium", "hard"]))]
    for index, (metric, ylabel, scale, _, stem) in enumerate(DELTA_PANEL_SPECS):
        fig, ax = plt.subplots(figsize=(2.15, 2.05), constrained_layout=True)
        line_panel(ax, frame, "deltaScale", metric, ylabel, scale, 1.0, raw)
        box_axes(ax)
        if index == 0:
            ax.legend(frameon=False, ncol=3, loc="upper left", fontsize=6,
                      handlelength=1.1, handletextpad=0.35, columnspacing=0.7)
        elif ax.get_legend() is not None:
            ax.get_legend().remove()
        fig.align_labels()
        fig.savefig(FIGURES / f"{stem}.pdf", facecolor="white",
                    bbox_inches=None)
        plt.close(fig)


def plot_control() -> None:
    frame = AGG[(AGG.family == "difficulty-control") &
                (AGG.scenario == "soft-congestion") &
                (AGG.stratum.isin(["easy", "medium", "hard"]))]
    order = ["easy", "medium", "hard"]
    variants = [("aware", "Difficulty-aware", "#0072B2"),
                ("blind-0.10", "Uniform 0.10", "#D55E00")]
    metrics = [
        ("candidateCountMean", "Mean eligible models", 1.0,
         "(a) Candidate-space size"),
        ("averageQualityGap", "Quality gap", 1.0, "(b) Quality preservation"),
        ("completionAwareP95TtftMs", "Completion-aware P95 TTFT (s)", 1 / 1000,
         "(c) Tail latency"),
        ("averageRequestPayment", "Mean request payment (mUSD)", 1000,
         "(d) Request payment"),
    ]
    fig, axes = plt.subplots(2, 2, figsize=(7.2, 6.1), constrained_layout=True)
    x = np.arange(3)
    width = 0.34
    for ax, (metric, ylabel, scale, caption) in zip(axes.flat, metrics):
        for index, (parameter, legend, color) in enumerate(variants):
            selected = (frame[frame.parameterId == parameter]
                        .set_index("stratum").loc[order])
            y = selected[f"{metric}Mean"].to_numpy(float) * scale
            lo = selected[f"{metric}CiLow"].to_numpy(float) * scale
            hi = selected[f"{metric}CiHigh"].to_numpy(float) * scale
            positions = x + (index - 0.5) * width
            ax.bar(positions, y, width, label=legend, color=color, alpha=0.88,
                   edgecolor="white", linewidth=0.5)
            ax.errorbar(positions, y, yerr=np.vstack([y - lo, hi - y]),
                        fmt="none", ecolor="#333333", capsize=2.2, linewidth=0.8)
        ax.set_xticks(x, [LABELS[item] for item in order])
        ax.set_ylabel(ylabel)
        ax.grid(axis="y", color="#dddddd", linewidth=0.6, alpha=0.8)
        box_axes(ax)
        panel_caption(ax, caption, y=-0.20)
    axes[0, 0].legend(frameon=False, loc="upper right")
    finish(fig, "fig2_difficulty_aware_vs_uniform")


def draw_kappa_panel(ax: plt.Axes, frame: pd.DataFrame, raw: pd.DataFrame,
                     metric: str, ylabel: str, scale: float,
                     compact_xlabel: bool = False) -> None:
    labels = frame.kappa.to_numpy(float)
    xv = np.arange(len(labels), dtype=float)
    y = frame[f"{metric}Mean"].to_numpy(float) * scale
    lo = frame[f"{metric}CiLow"].to_numpy(float) * scale
    hi = frame[f"{metric}CiHigh"].to_numpy(float) * scale
    position = {value: index for index, value in enumerate(labels)}
    raw_x = raw.kappa.map(position).to_numpy(float)
    default_position = position[1.0]
    ax.axvspan(default_position - 0.12, default_position + 0.12,
               color="#D9E2E5", alpha=0.12, linewidth=0, zorder=1)
    ax.scatter(raw_x, raw[metric] * scale, s=8, alpha=0.15,
               color=KAPPA_COLOR, edgecolors="none", zorder=2)
    ax.errorbar(xv, y, yerr=np.vstack([y - lo, hi - y]), marker="o",
                color=KAPPA_COLOR, markerfacecolor="white",
                markeredgewidth=1.1, markersize=4.5, linewidth=1.9,
                elinewidth=0.9, capsize=2.2, zorder=5)
    ax.margins(y=0.08)
    ax.autoscale_view()
    gradient_fill_below(ax, xv, y, ax.get_ylim()[0], KAPPA_COLOR,
                        max_alpha=0.08)
    ax.scatter([default_position], [y[default_position]], s=28,
               color=KAPPA_COLOR, edgecolors="white", linewidths=0.8,
               zorder=6)
    ax.axvline(default_position, color="#555555", linestyle="--", linewidth=1)
    ax.text(default_position, 0.90, " default", transform=ax.get_xaxis_transform(),
            ha="left", va="top", color="#555555", fontsize=7.5)
    ax.set_xticks(xv, [f"{value:g}" for value in labels])
    ax.set_xlabel(r"$\kappa_{CAP}$" if compact_xlabel else
                  r"Relative-congestion coefficient $\kappa_{CAP}$")
    ax.set_ylabel(ylabel)
    ax.grid(axis="y", color="#dddddd", linewidth=0.6, alpha=0.8)
    box_axes(ax)


def plot_kappa() -> None:
    frame = AGG[(AGG.family == "kappa-scan") &
                (AGG.scenario == "soft-congestion") &
                (AGG.stratum == "equal-weight")].sort_values("kappa")
    raw = SEEDS[(SEEDS.family == "kappa-scan") &
                (SEEDS.scenario == "soft-congestion") &
                (SEEDS.stratum == "equal-weight")]
    fig, axes = plt.subplots(2, 2, figsize=(7.2, 6.4), constrained_layout=True)
    for ax, (metric, ylabel, scale, caption, _) in zip(axes.flat,
                                                       KAPPA_PANEL_SPECS):
        draw_kappa_panel(ax, frame, raw, metric, ylabel, scale)
        panel_caption(ax, caption)
    finish(fig, "fig3_relative_congestion_sensitivity")


def plot_kappa_panels() -> None:
    frame = AGG[(AGG.family == "kappa-scan") &
                (AGG.scenario == "soft-congestion") &
                (AGG.stratum == "equal-weight")].sort_values("kappa")
    raw = SEEDS[(SEEDS.family == "kappa-scan") &
                (SEEDS.scenario == "soft-congestion") &
                (SEEDS.stratum == "equal-weight")]
    for metric, ylabel, scale, _, stem in KAPPA_PANEL_SPECS:
        fig, ax = plt.subplots(figsize=(2.15, 2.05), constrained_layout=True)
        draw_kappa_panel(ax, frame, raw, metric, ylabel, scale,
                         compact_xlabel=True)
        fig.align_labels()
        fig.savefig(FIGURES / f"{stem}.pdf", facecolor="white",
                    bbox_inches=None)
        plt.close(fig)


def plot_interaction() -> None:
    frame = AGG[(AGG.family == "interaction") &
                (AGG.scenario == "soft-congestion") &
                (AGG.stratum == "equal-weight")]
    deltas = [0.75, 1.0, 1.25]
    kappas = [0.5, 1.0, 2.0]
    metrics = [
        ("averageQualityGapMean", "(a) Quality gap", 1.0, ".3f"),
        ("completionAwareP95TtftMsMean", "(b) P95 TTFT", 1 / 1000, ".1f"),
        ("averageRequestPaymentMean", "(c) Request payment", 1000, ".3f"),
    ]
    fig, axes = plt.subplots(1, 3, figsize=(8.4, 3.25), constrained_layout=True)
    for ax, (metric, caption, scale, fmt) in zip(axes, metrics):
        matrix = (frame.pivot(index="deltaScale", columns="kappa", values=metric)
                  .loc[deltas, kappas].to_numpy(float) * scale)
        image = ax.imshow(matrix, cmap="cividis", aspect="auto")
        threshold = (matrix.min() + matrix.max()) / 2
        for row in range(matrix.shape[0]):
            for col in range(matrix.shape[1]):
                color = "white" if matrix[row, col] < threshold else "black"
                ax.text(col, row, format(matrix[row, col], fmt), ha="center",
                        va="center", color=color, fontsize=8)
        ax.scatter([1], [1], marker="s", s=310, facecolors="none",
                   edgecolors="#D55E00", linewidths=2)
        ax.set_xticks(range(3), ["0.5", "1", "2"])
        ax.set_yticks(range(3), ["0.75", "1", "1.25"])
        ax.set_xlabel(r"$\kappa_{CAP}$")
        if ax is axes[0]:
            ax.set_ylabel(r"Tolerance scale $s_\Delta$")
        box_axes(ax)
        fig.colorbar(image, ax=ax, fraction=0.048, pad=0.03)
        panel_caption(ax, caption, y=-0.28)
    finish(fig, "fig4_local_interaction")


if __name__ == "__main__":
    plot_delta()
    plot_delta_panels()
    plot_control()
    plot_kappa()
    plot_kappa_panels()
    plot_interaction()
    print(f"Wrote 12 publication figure files and 8 panel PDFs to {FIGURES}")
