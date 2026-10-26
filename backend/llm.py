"""The one place that talks to the model (gpt-6-luna through Portkey).

Every call is logged to the usage table (input, cached input, output tokens) and checked against spending caps.
The key comes from PORTKEY_API_KEY: first this repo's .env, then the .env one folder above.
"""
import json
import os
from pathlib import Path

from dotenv import load_dotenv
from openai import BadRequestError, OpenAI

from . import db

ROOT = Path(__file__).resolve().parent.parent
for folder in (ROOT, ROOT.parent):
    load_dotenv(folder / ".env")

MODEL = "gpt-6-luna"

# Spending caps. A bug or a bad actor hits these long before the budget is gone.
SESSION_TOKEN_CAP = int(os.getenv("SESSION_TOKEN_CAP", 80_000))
DAILY_TOKEN_CAP = int(os.getenv("DAILY_TOKEN_CAP", 1_500_000))
MAX_TOOL_STEPS = 4

# USD per 1M tokens. Assumed values: replace with the real gpt-6-luna prices (see report, Tokenomics).
PRICE_IN = float(os.getenv("PRICE_IN_PER_M", 0.40))
PRICE_CACHED = float(os.getenv("PRICE_CACHED_PER_M", 0.10))
PRICE_OUT = float(os.getenv("PRICE_OUT_PER_M", 1.60))


class MissingApiKey(RuntimeError):
    pass


class BudgetExceeded(RuntimeError):
    pass


BLOCKED_NOTICE = "Sorry, that message was stopped by the safety filter. Please ask about products, prices, or shipping."


class ContentBlocked(RuntimeError):
    pass


_client = None


def client() -> OpenAI:
    global _client
    if _client is None:
        key = os.getenv("PORTKEY_API_KEY")
        if not key:
            raise MissingApiKey("PORTKEY_API_KEY is not set. Add it to .env (here, or one folder up).")
        _client = OpenAI(api_key=key, base_url="https://api.portkey.ai/v1", default_headers={"x-portkey-api-key": key})
    return _client


def session_tokens(session: str) -> int:
    r = db.one("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS t FROM usage WHERE session=?", (session,))
    return r["t"]


def today_tokens() -> int:
    r = db.one("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS t FROM usage WHERE date(ts)=date('now')")
    return r["t"]


def check_budget(session: str) -> None:
    if session_tokens(session) >= SESSION_TOKEN_CAP:
        db.log_safety("budget_blocked", f"session {session} hit the {SESSION_TOKEN_CAP} token cap")
        raise BudgetExceeded("This session has used its token allowance. Please start a new session later.")
    if today_tokens() >= DAILY_TOKEN_CAP:
        db.log_safety("budget_blocked", f"daily cap of {DAILY_TOKEN_CAP} tokens reached")
        raise BudgetExceeded("The app has reached its daily limit. Please try again tomorrow.")


def call(agent: str, session: str, messages: list, tools: list | None = None, json_mode: bool = False):
    """One model call. Logs tokens, enforces the budget, returns the raw response message."""
    check_budget(session)
    # gpt-6-luna only allows function tools when reasoning_effort is "none"; it is also the cheapest, fastest setting.
    kwargs = {"model": MODEL, "messages": messages, "reasoning_effort": "none"}
    if tools:
        kwargs["tools"] = tools
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    try:
        resp = client().chat.completions.create(**kwargs)
    except BadRequestError as e:
        if getattr(e, "code", None) == "content_filter":  # the provider's own safety filter rejected the text
            db.log_safety("provider_filter", f"{agent}: message blocked by the model provider's content filter")
            raise ContentBlocked(BLOCKED_NOTICE) from e
        raise
    u = resp.usage
    cached = getattr(getattr(u, "prompt_tokens_details", None), "cached_tokens", 0) or 0
    db.run(
        "INSERT INTO usage (agent, session, prompt_tokens, cached_tokens, completion_tokens) VALUES (?,?,?,?,?)",
        (agent, session, u.prompt_tokens, cached, u.completion_tokens),
    )
    return resp.choices[0].message


def run_agent(agent: str, session: str, system: str, messages: list, tools: list | None = None,
              impls: dict | None = None, json_mode: bool = False) -> str:
    """Tool-calling loop with a hard step limit, so an agent can never loop forever."""
    convo = [{"role": "system", "content": system}, *messages]
    for step in range(MAX_TOOL_STEPS + 1):
        last_step = step == MAX_TOOL_STEPS
        msg = call(agent, session, convo, None if last_step else tools, json_mode)
        if not msg.tool_calls or last_step:
            if msg.tool_calls:  # still wanted tools after the limit
                db.log_safety("loop_stopped", f"{agent} hit the {MAX_TOOL_STEPS}-step tool limit")
            return msg.content or ""
        convo.append(msg.model_dump(exclude_none=True))
        for tc in msg.tool_calls:
            try:
                args = json.loads(tc.function.arguments or "{}")
                result = impls[tc.function.name](**args)
            except Exception as e:  # a bad tool call goes back to the model as an error, not a crash
                result = {"error": str(e)}
            convo.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps(result)})
    return ""


def cost_usd(prompt: int, cached: int, completion: int) -> float:
    fresh = max(prompt - cached, 0)
    return (fresh * PRICE_IN + cached * PRICE_CACHED + completion * PRICE_OUT) / 1_000_000
