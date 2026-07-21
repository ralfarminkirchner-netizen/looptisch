"""
Signature Cell — domain-agnostic unit of reconstructed recognizability.

Not essence. Not truth. A bounded, provenance-bearing, claim-ceilinged
record of a generative / statistical style fingerprint.

Aligned with ESSENCE domain package + Interferometer non-averaging rule.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from copy import deepcopy
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


DEFAULT_CLAIM_CEILING = {
    "cannot_imply_identity": True,
    "cannot_certify_understanding": True,
    "cannot_replace_source": True,
    "cannot_claim_truth_from_resonance": True,
    "cannot_auto_canonize": True,
    "cannot_average_away_minority": True,
    "max_scope": "research-v0",
    "notes": "Similarity is not identity. Resonance is not truth.",
}


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _new_id(prefix: str = "sig") -> str:
    return f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"


@dataclass
class ProvenanceStep:
    step: str
    actor: str
    at: str
    method: str
    input_ids: list[str] = field(default_factory=list)
    output_id: str = ""
    uncertainty: str = "medium"
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SignatureCell:
    """
    Core model.

    body.features: human-interpretable stats (may be long)
    body.vector: fixed-order float list for comparison (normalized-ish)
    body.vector_keys: labels aligned with vector
    body.params: optional generator params (e.g. SFX patch)
    """

    id: str
    domain: str  # text | audio | sfx | rhyme | image | multi
    title: str
    status: str = "draft"  # draft | proposed | sealed
    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)
    created_by: str = "agent:hermes"
    claim_ceiling: dict[str, Any] = field(default_factory=lambda: deepcopy(DEFAULT_CLAIM_CEILING))
    provenance: list[dict[str, Any]] = field(default_factory=list)
    body: dict[str, Any] = field(default_factory=dict)
    sealed_by_human: bool = False
    relations: list[dict[str, Any]] = field(default_factory=list)

    def fingerprint(self) -> str:
        payload = {
            "domain": self.domain,
            "vector": self.body.get("vector", []),
            "vector_keys": self.body.get("vector_keys", []),
        }
        raw = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
        return hashlib.sha256(raw).hexdigest()[:16]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": "SIGNATURE_CELL",
            "domain": self.domain,
            "title": self.title,
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "created_by": self.created_by,
            "claim_ceiling": self.claim_ceiling,
            "provenance": self.provenance,
            "body": self.body,
            "sealed_by_human": self.sealed_by_human,
            "relations": self.relations,
            "fingerprint": self.fingerprint(),
        }

    def save(self, path: str | Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")
        return path

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SignatureCell":
        return cls(
            id=data.get("id") or _new_id(),
            domain=data.get("domain", "unknown"),
            title=data.get("title", "untitled"),
            status=data.get("status", "draft"),
            created_at=data.get("created_at", _now_iso()),
            updated_at=data.get("updated_at", _now_iso()),
            created_by=data.get("created_by", "unknown"),
            claim_ceiling=data.get("claim_ceiling") or deepcopy(DEFAULT_CLAIM_CEILING),
            provenance=list(data.get("provenance") or []),
            body=dict(data.get("body") or {}),
            sealed_by_human=bool(data.get("sealed_by_human", False)),
            relations=list(data.get("relations") or []),
        )

    @classmethod
    def load(cls, path: str | Path) -> "SignatureCell":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls.from_dict(data)


def make_cell(
    domain: str,
    title: str,
    body: dict[str, Any],
    *,
    actor: str = "agent:hermes",
    method: str = "extract",
    input_ids: list[str] | None = None,
    notes: str = "",
) -> SignatureCell:
    cell_id = _new_id("sig")
    step = ProvenanceStep(
        step="extract",
        actor=actor,
        at=_now_iso(),
        method=method,
        input_ids=input_ids or [],
        output_id=cell_id,
        notes=notes,
    )
    return SignatureCell(
        id=cell_id,
        domain=domain,
        title=title,
        created_by=actor,
        provenance=[step.to_dict()],
        body=body,
    )
