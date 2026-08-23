#!/usr/bin/env python3
# Fleet circuit breaker for repeated terminal provider failures (RAI-106).
#
# Deliberately not an agent: an agent run depends on the exact Claude access
# that fails during the outage this is meant to catch (RAI-104's diagnosis).
# Stdlib only - no dependency surface to go stale between the rare times this
# code path actually runs.
#
# State machine: closed -> open -> closed. See the `runbook` document on
# RAI-106 for the full design and the operational read of each state.
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

API_URL = os.environ.get("PAPERCLIP_API_URL", "http://paperclip:3100")
API_KEY = os.environ.get("PAPERCLIP_API_KEY", "")
COMPANY_ID = os.environ["PAPERCLIP_COMPANY_ID"]
ISSUE_ID = os.environ.get("BREAKER_ISSUE_ID", "")  # where status comments/interactions land
STATE_PATH = os.environ.get("BREAKER_STATE_PATH", "/state/breaker-state.json")

POLL_INTERVAL_SECONDS = int(os.environ.get("BREAKER_POLL_INTERVAL_SECONDS", "60"))
FAILURE_WINDOW_SECONDS = int(os.environ.get("BREAKER_FAILURE_WINDOW_SECONDS", "300"))
FAILURE_THRESHOLD_COUNT = int(os.environ.get("BREAKER_FAILURE_THRESHOLD_COUNT", "5"))
FAILURE_THRESHOLD_AGENTS = int(os.environ.get("BREAKER_FAILURE_THRESHOLD_AGENTS", "2"))
ERROR_CODES = set(
    c.strip() for c in os.environ.get("BREAKER_ERROR_CODES", "acpx_turn_failed").split(",") if c.strip()
)
PROBE_INTERVAL_BASE_SECONDS = int(os.environ.get("BREAKER_PROBE_INTERVAL_BASE_SECONDS", "300"))
PROBE_INTERVAL_MAX_SECONDS = int(os.environ.get("BREAKER_PROBE_INTERVAL_MAX_SECONDS", "1800"))
ESCALATION_THRESHOLD_SECONDS = int(os.environ.get("BREAKER_ESCALATION_THRESHOLD_SECONDS", "1800"))

RUNS_LIMIT = 100


def log(msg):
    print(f"{now_iso()} {msg}", flush=True)


def now():
    # Wall-clock is fine here: this runs as a real long-lived process, not a
    # replayable workflow script.
    return time.time()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def parse_iso(s):
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def api_request(method, path, body=None):
    url = f"{API_URL.rstrip('/')}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {API_KEY}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    # Paperclip's hostname allowlist only permits `localhost` and
    # `rainn.thenairn.com` (PAPERCLIP_ALLOWED_HOSTNAMES on the paperclip
    # container - see docker-compose.paperclip.yml). The docker-network alias
    # `paperclip` this connects through is not on that list, so the Host
    # header has to say `localhost` even though the connection itself goes to
    # `paperclip:3100`. Verified live on 2026-08-23: without this override
    # every call 403s with "Hostname 'paperclip' is not allowed".
    req.add_header("Host", "localhost")
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def load_state():
    default = {
        "state": "closed",
        "openedAt": None,
        "pausedAgentIds": [],
        "probeAgentId": None,
        "probeIssuedAt": None,
        "nextProbeAt": None,
        "probeIntervalSeconds": PROBE_INTERVAL_BASE_SECONDS,
        "escalatedAt": None,
    }
    if not os.path.exists(STATE_PATH):
        return default
    try:
        with open(STATE_PATH) as f:
            saved = json.load(f)
        default.update(saved)
        return default
    except (json.JSONDecodeError, OSError):
        log(f"WARNING: state file at {STATE_PATH} unreadable, starting from closed")
        return default


def save_state(state):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_PATH)


def post_comment(body):
    if not ISSUE_ID:
        log(f"NOTE (no BREAKER_ISSUE_ID set, not posted): {body}")
        return
    try:
        api_request("POST", f"/api/issues/{ISSUE_ID}/comments", {"body": body})
    except urllib.error.URLError as e:
        log(f"ERROR posting comment: {e}")


def post_interaction(title, summary, help_text):
    if not ISSUE_ID:
        log(f"NOTE (no BREAKER_ISSUE_ID set, interaction not posted): {title}")
        return
    payload = {
        "kind": "ask_user_questions",
        "continuationPolicy": "wake_assignee",
        # addresseeAgentId deliberately unset: a stuck provider quota/outage is
        # a spend/custody fact, the same reasoning as the RAI-104 escalation.
        "title": title,
        "summary": summary,
        "payload": {
            "version": 1,
            "title": title,
            "questions": [
                {
                    "id": "ack",
                    "prompt": help_text,
                    "selectionMode": "single",
                    "required": False,
                    "options": [
                        {"id": "ack", "label": "Understood, keep waiting"},
                    ],
                }
            ],
        },
    }
    try:
        api_request("POST", f"/api/issues/{ISSUE_ID}/interactions", payload)
    except urllib.error.URLError as e:
        log(f"ERROR posting interaction: {e}")


def fetch_recent_runs():
    return api_request("GET", f"/api/companies/{COMPANY_ID}/heartbeat-runs?limit={RUNS_LIMIT}") or []


def fetch_agents():
    return api_request("GET", f"/api/companies/{COMPANY_ID}/agents") or []


def pause_agent(agent_id):
    api_request("POST", f"/api/agents/{agent_id}/pause")


def resume_agent(agent_id):
    api_request("POST", f"/api/agents/{agent_id}/resume")


def failing_window(runs):
    cutoff = now() - FAILURE_WINDOW_SECONDS
    matches = []
    for r in runs:
        if r.get("errorCode") not in ERROR_CODES:
            continue
        ts = parse_iso(r.get("finishedAt") or r.get("startedAt") or r.get("createdAt"))
        if ts is None or ts < cutoff:
            continue
        matches.append(r)
    return matches


def check_closed(state):
    runs = fetch_recent_runs()
    matches = failing_window(runs)
    distinct_agents = {r.get("agentId") for r in matches if r.get("agentId")}
    if len(matches) < FAILURE_THRESHOLD_COUNT or len(distinct_agents) < FAILURE_THRESHOLD_AGENTS:
        return
    trip(state, matches, distinct_agents)


def trip(state, matches, distinct_agents):
    agents = fetch_agents()
    paused = []
    for a in agents:
        if a.get("status") == "paused":
            continue
        try:
            pause_agent(a["id"])
            paused.append(a["id"])
        except urllib.error.URLError as e:
            log(f"ERROR pausing agent {a.get('id')}: {e}")
    state["state"] = "open"
    state["openedAt"] = now_iso()
    state["pausedAgentIds"] = paused
    state["probeAgentId"] = None
    state["probeIssuedAt"] = None
    state["nextProbeAt"] = now() + PROBE_INTERVAL_BASE_SECONDS
    state["probeIntervalSeconds"] = PROBE_INTERVAL_BASE_SECONDS
    state["escalatedAt"] = None
    save_state(state)
    codes = ", ".join(sorted({r.get("errorCode") for r in matches}))
    agent_count = len(distinct_agents)
    log(f"TRIP: {len(matches)} failures ({codes}) across {agent_count} agents; paused {len(paused)} agents")
    post_comment(
        "**Standing:** this is the fleet circuit breaker (RAI-106) - it pauses the agent "
        "fleet automatically when the provider is refusing every call, instead of letting "
        "runs retry into a dead end.\n\n"
        f"**Tripped.** {len(matches)} runs failed with `{codes}` across {agent_count} agents "
        f"in the last {FAILURE_WINDOW_SECONDS // 60} minutes. Paused {len(paused)} agents. "
        f"A single probe agent will be resumed every {PROBE_INTERVAL_BASE_SECONDS // 60} minutes "
        "to test recovery; the rest stay paused until a probe succeeds, or resume immediately if "
        "someone resumes them by hand."
    )


def check_open(state):
    agents_by_id = {a["id"]: a for a in fetch_agents()}
    still_paused = [aid for aid in state["pausedAgentIds"] if agents_by_id.get(aid, {}).get("status") == "paused"]

    if not still_paused:
        log("RECOVERED: no tracked agents still paused (manual clear or all resumed)")
        post_comment(
            "**Standing:** this is the fleet circuit breaker (RAI-106).\n\n"
            "**Cleared.** No previously-paused agents are still paused - resuming normal "
            "monitoring."
        )
        reset_to_closed(state)
        return

    if state["probeAgentId"] and state["probeIssuedAt"]:
        probe_result = check_probe_result(state, agents_by_id)
        if probe_result is not None:
            if probe_result:
                recover(state)
            else:
                backoff(state)
            return

    if state["nextProbeAt"] and now() >= state["nextProbeAt"] and not state["probeAgentId"]:
        issue_probe(state, still_paused)

    escalate_if_stale(state)


def check_probe_result(state, agents_by_id):
    runs = fetch_recent_runs()
    probe_started = parse_iso(state["probeIssuedAt"])
    candidates = [
        r for r in runs
        if r.get("agentId") == state["probeAgentId"]
        and parse_iso(r.get("startedAt") or r.get("createdAt")) and parse_iso(r.get("startedAt") or r.get("createdAt")) >= probe_started
    ]
    for r in candidates:
        if r.get("status") in ("succeeded",):
            return True
        if r.get("errorCode") in ERROR_CODES:
            return False
    return None  # no result yet, keep waiting


def issue_probe(state, still_paused):
    agent_id = still_paused[0]
    try:
        resume_agent(agent_id)
    except urllib.error.URLError as e:
        log(f"ERROR resuming probe agent {agent_id}: {e}")
        return
    state["probeAgentId"] = agent_id
    state["probeIssuedAt"] = now_iso()
    save_state(state)
    log(f"PROBE: resumed {agent_id} to test recovery")


def backoff(state):
    interval = min(state["probeIntervalSeconds"] * 2, PROBE_INTERVAL_MAX_SECONDS)
    try:
        pause_agent(state["probeAgentId"])
    except urllib.error.URLError as e:
        log(f"ERROR re-pausing probe agent: {e}")
    log(f"PROBE FAILED: {state['probeAgentId']} still hitting the same error, backing off to {interval}s")
    state["probeAgentId"] = None
    state["probeIssuedAt"] = None
    state["nextProbeAt"] = now() + interval
    state["probeIntervalSeconds"] = interval
    save_state(state)


def recover(state):
    for aid in state["pausedAgentIds"]:
        if aid == state["probeAgentId"]:
            continue
        try:
            resume_agent(aid)
        except urllib.error.URLError as e:
            log(f"ERROR resuming {aid}: {e}")
    opened_at = parse_iso(state["openedAt"])
    duration_minutes = round((now() - opened_at) / 60) if opened_at else None
    log(f"RECOVERED: probe succeeded, resumed remaining agents (paused ~{duration_minutes} min)")
    post_comment(
        "**Standing:** this is the fleet circuit breaker (RAI-106).\n\n"
        f"**Recovered.** Probe run succeeded - resumed the rest of the fleet. "
        f"Paused for approximately {duration_minutes} minutes."
    )
    reset_to_closed(state)


def escalate_if_stale(state):
    if state["escalatedAt"]:
        return
    opened_at = parse_iso(state["openedAt"])
    if opened_at is None or now() - opened_at < ESCALATION_THRESHOLD_SECONDS:
        return
    duration_minutes = round((now() - opened_at) / 60)
    post_interaction(
        "Fleet has been paused by the circuit breaker for over 30 minutes",
        f"{len(state['pausedAgentIds'])} agents paused since {state['openedAt']}, still probing.",
        f"The provider has been refusing every call for about {duration_minutes} minutes. "
        f"The breaker keeps probing every {state['probeIntervalSeconds'] // 60} minutes and will "
        "resume the fleet itself the moment a probe succeeds - no action needed unless you want to "
        "raise a spend limit or investigate directly. This is a one-time notice; it will not repeat "
        "until the breaker clears and trips again.",
    )
    state["escalatedAt"] = now_iso()
    save_state(state)
    log("ESCALATED: outage exceeded threshold, notified the board")


def reset_to_closed(state):
    state["state"] = "closed"
    state["openedAt"] = None
    state["pausedAgentIds"] = []
    state["probeAgentId"] = None
    state["probeIssuedAt"] = None
    state["nextProbeAt"] = None
    state["probeIntervalSeconds"] = PROBE_INTERVAL_BASE_SECONDS
    state["escalatedAt"] = None
    save_state(state)


def main():
    if not API_KEY:
        log("FATAL: PAPERCLIP_API_KEY not set - waiting rather than crash-looping. "
            "See the runbook document on RAI-106 for how to provision one.")
        while not API_KEY:
            time.sleep(POLL_INTERVAL_SECONDS)
            globals()["API_KEY"] = os.environ.get("PAPERCLIP_API_KEY", "")

    log(f"starting: poll={POLL_INTERVAL_SECONDS}s window={FAILURE_WINDOW_SECONDS}s "
        f"threshold={FAILURE_THRESHOLD_COUNT}runs/{FAILURE_THRESHOLD_AGENTS}agents codes={ERROR_CODES}")
    state = load_state()
    log(f"loaded state: {state['state']}")

    while True:
        try:
            if state["state"] == "closed":
                check_closed(state)
            else:
                check_open(state)
        except urllib.error.URLError as e:
            log(f"ERROR talking to Paperclip API this tick: {e}")
        except Exception as e:  # noqa: BLE001 - a poll loop must not die on a bad tick
            log(f"ERROR unexpected: {e!r}")
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    sys.exit(main())
