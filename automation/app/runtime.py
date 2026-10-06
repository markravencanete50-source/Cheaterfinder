"""Lazy dependency checks for the Python-owned browser and HTTP transports."""

from __future__ import annotations

from importlib.util import find_spec
import platform
import sys


def browser_engine_available() -> bool:
    """Check the sealed Firefox cache without triggering a download."""
    if find_spec("invisible_playwright") is None or find_spec("invisible_core") is None:
        return False
    try:
        from invisible_core.download import cache_dir_for_seal
        from invisible_core.seal import active_seal

        seal = active_seal()
        asset = seal.asset_for(sys.platform, platform.machine())
        return (cache_dir_for_seal(seal) / asset.entry_rel).is_file()
    except Exception:
        return False


def runtime_status() -> dict[str, str | bool]:
    """Report the intended automation transport without starting a browser.

    Imports stay lazy: the Express app can health-check this process without
    downloading a browser engine or allocating a TLS session.
    """
    return {
        "browser": "invisible_playwright",
        "browser_available": find_spec("invisible_playwright") is not None,
        "browser_engine_available": browser_engine_available(),
        "http": "pyhttpz",
        # pyhttpz is installed from PyPI but imported as `httpz`.
        "http_available": find_spec("httpz") is not None,
    }
