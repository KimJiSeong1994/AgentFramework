"""EvoOntology core — deterministic capabilities for the self-evolving ontology layer.

Layout follows the product design doc:

- ``ontology/``   — record models + versioned store (save / load / publish / rollback)
- ``runtime/``    — semantic runtime (browse / resolve / manifest) + MCP server
- ``trajectory/`` — tool-call-level task trajectory recording
- ``trigger/``    — evolution-due detection (new-task count + elapsed time)
- ``evaluation/`` — GT / LLM-Judge scheduling + aggregation gate
- ``evolution/``  — EvolutionSession lifecycle state machine + adapter contract

Build and Evolve intelligence lives in the plugin skills; this package provides
only deterministic capabilities.
"""

from .evaluation.evaluation import EvaluationGate
from .evolution.adapter import EvolutionAdapter, normalize_result
from .evolution.session import (
    ACCEPTED,
    DEFAULT_MAX_ROUNDS,
    INCOMPLETE,
    RUNNING,
    TERMINAL_STATES,
    EvolutionBudgetExhausted,
    EvolutionError,
    EvolutionSession,
)
from .ontology.models import Constraint, Evidence, Mapping, Relation, Term
from .ontology.store import SemanticStore
from .runtime.runtime import SemanticLayer
from .trajectory.trajectory import TrajectoryStore, from_message_trace, truncate_result
from .trigger.trigger import EvolutionTrigger
from .visualization import visualize
from .workspace import (
    ensure_workspace,
    load_project,
    resolve_workspace,
    resolve_workspace_for_version,
    save_project,
)

__version__ = "1.1.0"

__all__ = [
    "EvolutionSession",
    "EvolutionAdapter",
    "EvolutionError",
    "EvolutionBudgetExhausted",
    "normalize_result",
    "RUNNING",
    "ACCEPTED",
    "INCOMPLETE",
    "TERMINAL_STATES",
    "DEFAULT_MAX_ROUNDS",
    "SemanticStore",
    "SemanticLayer",
    "TrajectoryStore",
    "EvolutionTrigger",
    "EvaluationGate",
    "resolve_workspace",
    "resolve_workspace_for_version",
    "ensure_workspace",
    "load_project",
    "save_project",
    "visualize",
    "truncate_result",
    "from_message_trace",
    "Term",
    "Mapping",
    "Relation",
    "Constraint",
    "Evidence",
]

