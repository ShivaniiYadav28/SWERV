"""Shared ranking metrics for Smart Agent Assignment evaluation."""

from __future__ import annotations

import numpy as np
import pandas as pd


def ndcg_for_scenario(actual: np.ndarray, predicted_order: np.ndarray, cutoff: int) -> float:
    """Compute NDCG using reciprocal actual-rank gain; lower duration is better."""
    actual_order = pd.Series(actual).rank(method="average", ascending=True).to_numpy()
    relevance = 1.0 / actual_order
    ordered_relevance = relevance[predicted_order]
    ideal_relevance = np.sort(relevance)[::-1]

    def discounted_gain(values: np.ndarray) -> float:
        selected = values[:cutoff]
        positions = np.arange(2, len(selected) + 2)
        return float(np.sum(selected / np.log2(positions)))

    ideal = discounted_gain(ideal_relevance)
    return discounted_gain(ordered_relevance) / ideal if ideal > 0 else 0.0
