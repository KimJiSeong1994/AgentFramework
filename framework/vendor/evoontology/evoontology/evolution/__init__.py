"""Evolution lifecycle: EvolutionSession state machine and the adapter contract."""

from .adapter import EvolutionAdapter, normalize_result
from .session import (
    ACCEPTED,
    DEFAULT_MAX_ROUNDS,
    INCOMPLETE,
    RUNNING,
    TERMINAL_STATES,
    EvolutionBudgetExhausted,
    EvolutionError,
    EvolutionSession,
)

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
]
