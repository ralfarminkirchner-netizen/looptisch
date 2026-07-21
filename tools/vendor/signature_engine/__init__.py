"""Signature of Style — local-first engine package."""

from .audio_style import audio_to_cell, sfx_params_to_cell, synthesize_tone_wav
from .cell import SignatureCell, make_cell
from .interfere import cluster_soft, interfere_set, minority_signals, pair_interfere
from .text_style import burrows_delta, profile_text, text_to_cell

__all__ = [
    "SignatureCell",
    "make_cell",
    "text_to_cell",
    "profile_text",
    "burrows_delta",
    "audio_to_cell",
    "sfx_params_to_cell",
    "synthesize_tone_wav",
    "pair_interfere",
    "interfere_set",
    "cluster_soft",
    "minority_signals",
]
