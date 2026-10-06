"""Configuration for the local automation service.

This process is intentionally not a public API.  It listens only on loopback
and every request must carry the token shared with the TypeScript backend.
"""

from __future__ import annotations

from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Settings:
    internal_token: str

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(internal_token=os.environ.get("AUTOMATION_API_TOKEN", "").strip())


def get_settings() -> Settings:
    """Read configuration lazily so tests and local tooling can set env first."""
    return Settings.from_env()
