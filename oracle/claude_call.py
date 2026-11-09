"""
Shared Claude call used by every oracle check.

One place for: model choice, streaming (long inputs/outputs stay clear of HTTP
timeouts), server-side refusal fallback, typed error mapping, and stop-reason
handling. Callers get plain text back or an OracleError - never partial output.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import anthropic

log = logging.getLogger("mandate-oracle")

# Current Sonnet; override per deployment. (claude-3-5-sonnet-* models are retired.)
MODEL = os.environ.get("ORACLE_MODEL") or os.environ.get("REDACTION_MODEL") or "claude-sonnet-5-5"
EFFORT = os.environ.get("ORACLE_EFFORT", "medium")


class OracleError(RuntimeError):
    """The model call failed or returned unusable output. Callers should retry later,
    never treat this as a verdict against the submitter."""


async def complete(
    client: anthropic.AsyncAnthropic,
    *,
    system: str,
    user: str,
    max_tokens: int,
    output_format: dict[str, Any] | None = None,
    label: str = "request",
) -> str:
    output_config: dict[str, Any] = {"effort": EFFORT}
    if output_format is not None:
        output_config["format"] = output_format

    try:
        # The server-side fallback re-runs the request on another model if a safety
        # classifier declines, instead of failing the whole check.
        async with client.beta.messages.stream(
            model=MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config=output_config,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        ) as stream:
            message = await stream.get_final_message()
    except anthropic.AuthenticationError as e:
        raise OracleError("Anthropic authentication failed; check ANTHROPIC_API_KEY") from e
    except anthropic.BadRequestError as e:
        raise OracleError(f"Bad request to model: {e.message}") from e
    except anthropic.RateLimitError as e:
        raise OracleError("Rate limited by the Anthropic API after SDK retries") from e
    except anthropic.APIStatusError as e:
        raise OracleError(f"Anthropic API error {e.status_code}: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise OracleError("Could not reach the Anthropic API") from e

    if message.stop_reason == "refusal":
        category = getattr(message.stop_details, "category", None) if message.stop_details else None
        raise OracleError(f"Model declined {label} (category={category})")
    if message.stop_reason == "max_tokens":
        raise OracleError(f"{label} output truncated at max_tokens")

    text = "".join(block.text for block in message.content if block.type == "text")
    if not text.strip():
        raise OracleError(f"Model returned empty output for {label}")
    log.info("%s done (request_id=%s)", label, message._request_id)
    return text
