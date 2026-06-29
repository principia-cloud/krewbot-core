"""Custom-tools MCP — auto-exposes every Python script under
`def/scripts/` as an MCP tool.

The runtime agent spawns this MCP with:

    AGENT_DEF_DIR = /data/agents/{agentId}/def

On startup, we walk `{AGENT_DEF_DIR}/scripts/*.py` (top level only — files
under `_lib/` are treated as helper libraries, not tools) and register
each file as an MCP tool. Tool name = filename stem.

Each script is required to export, at module scope:

    TOOL_SCHEMA: dict     # JSON Schema describing the input shape
    TOOL_DESCRIPTION: str # (optional) one-line description for the model

    def tool_entry(args: dict) -> str | dict:
        '''Called when the tool is invoked. Receives the model's
        JSON input (parsed to a dict) and must return a JSON-serialisable
        result or a plain string.'''
        ...

If the file fails to import, or is missing TOOL_SCHEMA / tool_entry, we
still register a placeholder tool that returns a descriptive error when
invoked — so the creator (and the model) can see exactly what's wrong
instead of the tool silently not appearing.

The scripts subtree is pre-pended to sys.path so each tool can
`from _lib.helpers import foo` for shared code.
"""

import importlib.util
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Callable

# Ensure co-located log.py is importable. Mirrors the pattern every
# other MCP in this directory uses.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mcp.server.fastmcp import FastMCP

from platform_log import init_logger, log_catch

logger = init_logger("mcp-custom-tools")

mcp = FastMCP("custom_tools")

AGENT_DEF_DIR = Path(os.environ.get("AGENT_DEF_DIR", "")).resolve()
SCRIPTS_DIR = AGENT_DEF_DIR / "scripts" if AGENT_DEF_DIR else None


# ---------------------------------------------------------------------------
# Script discovery + loading
# ---------------------------------------------------------------------------


def _discover_scripts() -> list[Path]:
    """Top-level .py files under scripts/, excluding _lib/ and dunders."""
    if not SCRIPTS_DIR or not SCRIPTS_DIR.exists():
        return []
    results: list[Path] = []
    for entry in sorted(SCRIPTS_DIR.iterdir()):
        if not entry.is_file():
            continue
        if entry.suffix != ".py":
            continue
        if entry.name.startswith("_"):
            continue
        results.append(entry)
    return results


def _load_script_module(path: Path) -> tuple[Any | None, str | None]:
    """Import a script as an isolated module. Returns (module, error_msg).
    error_msg is None iff the import succeeded."""
    spec = importlib.util.spec_from_file_location(
        f"agent_tool_{path.stem}", str(path)
    )
    if spec is None or spec.loader is None:
        return None, f"Could not build import spec for {path}"
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        return None, f"Import failed:\n{traceback.format_exc(limit=5)}{exc}"
    return module, None


def _extract_tool(
    module: Any,
) -> tuple[dict | None, str, Callable[[dict], Any] | None, str | None]:
    """Pull TOOL_SCHEMA, TOOL_DESCRIPTION, tool_entry out of a module.
    Returns (schema, description, entry, error_msg)."""
    schema = getattr(module, "TOOL_SCHEMA", None)
    if not isinstance(schema, dict):
        return None, "", None, (
            "Missing or invalid TOOL_SCHEMA (must be a dict at module scope)."
        )
    description = getattr(module, "TOOL_DESCRIPTION", "") or ""
    if not isinstance(description, str):
        description = ""
    entry = getattr(module, "tool_entry", None)
    if not callable(entry):
        return None, "", None, (
            "Missing tool_entry callable (must accept a dict and return a "
            "JSON-serialisable value or string)."
        )
    return schema, description, entry, None


def _format_result(value: Any) -> str:
    """Coerce a tool's return value into a string for the MCP response."""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, default=str)
    except (TypeError, ValueError):
        return str(value)


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------


def _register_broken(name: str, reason: str) -> None:
    """Register a placeholder tool that always reports a load-time error.
    Keeps diagnostics visible to the model and the creator rather than
    silently dropping broken tools."""
    doc = (
        f"[Unavailable] This custom tool failed to load.\n\n"
        f"Reason:\n{reason}\n\n"
        f"Fix the script under def/scripts/{name}.py and the tool will "
        f"reappear on the next session."
    )

    @mcp.tool(name=name, description=doc)
    def _broken(input: str = "{}") -> str:  # noqa: ARG001
        return json.dumps({"error": "tool_unavailable", "reason": reason})


def _register_tool(
    name: str,
    description: str,
    schema: dict,
    entry: Callable[[dict], Any],
) -> None:
    """Register a working tool. Input is a single JSON-string arg whose
    shape is documented in the description. Validation is kept minimal
    (JSON-parse + pass-through) — richer validation happens inside
    tool_entry itself where the agent has full context.

    Single-string-arg shape is a deliberate tradeoff against dynamic
    function signature generation — every tool here is user-defined and
    its schema is fully dynamic. Documenting the expected shape in the
    description gives the model everything it needs to form correct
    calls without the MCP needing to generate a matching Python
    signature per script.
    """
    schema_block = json.dumps(schema, indent=2)
    doc_lines = [
        description.strip() or f"Custom tool `{name}`.",
        "",
        "Expected input (JSON-serialise a matching object into `input`):",
        "```json",
        schema_block,
        "```",
    ]
    doc = "\n".join(doc_lines)

    @mcp.tool(name=name, description=doc)
    def _tool(input: str = "{}") -> str:
        try:
            args = json.loads(input) if input else {}
        except json.JSONDecodeError as exc:
            return json.dumps({"error": "invalid_json_input", "message": str(exc)})
        if not isinstance(args, dict):
            return json.dumps({
                "error": "invalid_input_shape",
                "message": "Input must be a JSON object, not a list/primitive.",
            })
        try:
            result = entry(args)
        except Exception as exc:
            log_catch(
                logger,
                "custom_tool.invocation_failed",
                exc,
                toolName=name,
            )
            return json.dumps({
                "error": "tool_raised",
                "message": str(exc),
                "traceback": traceback.format_exc(limit=5),
            })
        return _format_result(result)


# ---------------------------------------------------------------------------
# Boot: scan scripts/, register everything discovered
# ---------------------------------------------------------------------------


def _bootstrap() -> None:
    if not AGENT_DEF_DIR:
        logger.warning(
            "AGENT_DEF_DIR not set; no custom tools will be registered.",
            extra={"event": "custom_tools.no_def_dir"},
        )
        return
    if SCRIPTS_DIR and SCRIPTS_DIR.exists():
        # Let scripts import siblings under _lib/.
        sys.path.insert(0, str(SCRIPTS_DIR))

    scripts = _discover_scripts()
    logger.info(
        "discovered custom scripts",
        extra={
            "event": "custom_tools.discovered",
            "count": len(scripts),
            "defDir": str(AGENT_DEF_DIR),
        },
    )
    for path in scripts:
        name = path.stem
        module, err = _load_script_module(path)
        if err:
            logger.warning(
                "custom tool import failed",
                extra={
                    "event": "custom_tools.import_failed",
                    "toolName": name,
                    "path": str(path),
                    "error": err[:500],
                },
            )
            _register_broken(name, err)
            continue
        schema, description, entry, err = _extract_tool(module)
        if err or schema is None or entry is None:
            logger.warning(
                "custom tool missing required exports",
                extra={
                    "event": "custom_tools.exports_missing",
                    "toolName": name,
                    "error": err,
                },
            )
            _register_broken(name, err or "Missing required exports.")
            continue
        _register_tool(name, description, schema, entry)
        logger.info(
            "custom tool registered",
            extra={
                "event": "custom_tools.registered",
                "toolName": name,
            },
        )


if __name__ == "__main__":
    # Gating under __main__ keeps the module import-safe for unit tests
    # (which exercise the pure helpers above without triggering FastMCP's
    # dynamic tool registration). In production the MCP subprocess
    # runs this file directly, so _bootstrap always fires.
    _bootstrap()
    mcp.run()
