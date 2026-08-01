#!/usr/bin/env python3
"""
Deterministic fact collector for the docker upgrade sweep.

Phase 1 of the sweep. Emits a JSON fact table with NO model involvement, so
there is no hallucination surface on any of the load-bearing numbers:
  - what version is actually RUNNING (probed from the live container)
  - when the local image was BUILT
  - the latest upstream release + date (GitHub API)
  - security advisories published AFTER the local image was built (the gap)
  - EOL dates (endoflife.date)

Phase 2 (agents) consumes this and only does judgment: upgrade risk, ordering,
whether a better-maintained image exists. Agents are never asked to look up a
version number, because that is where they drift (notably: right month/day,
wrong year).

Usage:  ./collect.py [--inventory inventory.json] [--out facts.json]
Requires: docker, gh (authenticated), python3.
"""
import json, subprocess, argparse, sys, datetime, urllib.request, re

TODAY = datetime.date.today()


def sh(cmd, timeout=60):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def gh_api(path, jq=None):
    cmd = f"gh api {path}"
    if jq:
        cmd += f" --jq '{jq}'"
    return sh(cmd)


def days_ago(iso):
    if not iso:
        return None
    try:
        d = datetime.date.fromisoformat(iso[:10])
        return (TODAY - d).days
    except Exception:
        return None


def local_image_built(image):
    """When was the local copy of this image built upstream."""
    out = sh(f"docker image inspect {image} --format '{{{{.Created}}}}'")
    return out[:10] if out else ""


def running_version(svc):
    """Probe the LIVE container for its actual version. This is the single most
    valuable fact and the one agents consistently guessed wrong."""
    c = svc["container"]
    if svc.get("probe"):
        out = sh(f"docker exec {c} {svc['probe']}", timeout=30)
        if out:
            m = re.search(r"[0-9]+\.[0-9]+[0-9a-zA-Z.\-+]*", out)
            return m.group(0) if m else out.splitlines()[0][:80]
    for label in ("org.opencontainers.image.version", "build_version", "version"):
        out = sh(f"docker inspect {c} --format '{{{{index .Config.Labels \"{label}\"}}}}'")
        if out and out != "<no value>":
            return out
    return ""


def latest_release(repo):
    out = gh_api(f"repos/{repo}/releases/latest", '.tag_name + "|" + .published_at')
    if out and "|" in out:
        tag, pub = out.split("|", 1)
        return tag.strip(), pub[:10]
    # fall back to the most recent release of any kind (prereleases included)
    out = gh_api(f"repos/{repo}/releases?per_page=1", '.[0].tag_name + "|" + .[0].published_at')
    if out and "|" in out:
        tag, pub = out.split("|", 1)
        return tag.strip() + " (prerelease)", pub[:10]
    return "", ""


def repo_health(repo):
    out = gh_api(f"repos/{repo}", '"\\(.archived)|\\(.pushed_at)|\\(.stargazers_count)"')
    if out and "|" in out:
        a, p, s = out.split("|")
        return {"archived": a == "true", "last_push": p[:10],
                "last_push_days": days_ago(p[:10]), "stars": int(s or 0)}
    return {}


def advisories_since(repo, since):
    """Advisories published after the local image was built = the actual exposure."""
    raw = gh_api(f"repos/{repo}/security-advisories?per_page=100",
                 '.[] | "\\(.published_at)|\\(.severity)|\\(.summary)"')
    out = []
    if not raw:
        return out
    for line in raw.splitlines():
        parts = line.split("|", 2)
        if len(parts) < 3:
            continue
        pub, sev, summ = parts[0][:10], parts[1], parts[2]
        if since and pub <= since:
            continue
        out.append({"published": pub, "severity": sev, "summary": summ[:200]})
    return out


def eol_info(product, cycle):
    try:
        with urllib.request.urlopen(f"https://endoflife.date/api/{product}.json", timeout=25) as r:
            data = json.load(r)
    except Exception:
        return {}
    for c in data:
        if str(c.get("cycle")) == str(cycle):
            eol = c.get("eol")
            return {"cycle": cycle, "eol": eol, "latest_in_cycle": c.get("latest"),
                    "is_eol": bool(eol) and eol is not True and str(eol) < str(TODAY),
                    "days_to_eol": days_ago(eol) and -days_ago(eol) if isinstance(eol, str) else None}
    return {"cycle": cycle, "eol": "UNKNOWN"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inventory", default="inventory.json")
    ap.add_argument("--out", default="facts.json")
    args = ap.parse_args()

    inv = json.load(open(args.inventory))
    running = set(sh("docker ps --format '{{.Names}}'").splitlines())

    facts = []
    for svc in inv["services"]:
        c, image = svc["container"], svc["image"]
        print(f"  collecting {c} ...", file=sys.stderr)
        f = {
            "container": c, "image": image,
            "compose_file": svc.get("compose", ""),
            "criticality": svc.get("criticality", "medium"),
            "pinned": bool(svc.get("pinned")),
            "custom_build": bool(svc.get("custom_build")),
            "inventory_note": svc.get("note", ""),
            "is_running": c in running,
            "local_image_built": local_image_built(image),
            "running_version": running_version(svc) if c in running else "",
        }
        f["local_image_age_days"] = days_ago(f["local_image_built"])

        if svc.get("repo"):
            tag, pub = latest_release(svc["repo"])
            f["repo"] = svc["repo"]
            f["latest_release"] = tag
            f["latest_release_date"] = pub
            f["latest_release_age_days"] = days_ago(pub)
            f["repo_health"] = repo_health(svc["repo"])
            f["advisories_since_local_build"] = advisories_since(svc["repo"], f["local_image_built"])
            # Monorepo caveat: several containers can map to ONE repo (e.g. immich's
            # server / ML / kiosk). GitHub advisories are per-REPO, so every such
            # container inherits the whole repo's advisory feed even when the CVE ships
            # only in a sibling component. Flag it so judgment agents don't treat a
            # server-side web CVE as exposure on an internal inference microservice.
            shares = [s["container"] for s in inv["services"]
                      if s.get("repo") == svc["repo"] and s["container"] != c]
            if shares and f["advisories_since_local_build"]:
                f["advisory_attribution_warning"] = (
                    f"repo {svc['repo']} is shared with {shares}; advisories are per-repo, "
                    f"verify each actually ships in THIS component before weighting it")
        if svc.get("eol"):
            cycle = image.split(":")[-1].split("-")[0]
            f["eol"] = eol_info(svc["eol"], cycle)
        facts.append(f)

    out = {"generated": str(TODAY), "host": sh("hostname"), "services": facts}
    json.dump(out, open(args.out, "w"), indent=2)

    # console summary, sorted by exposure
    def score(f):
        adv = f.get("advisories_since_local_build", [])
        crit = sum(1 for a in adv if a["severity"] in ("critical", "high"))
        return (crit, len(adv), f.get("local_image_age_days") or 0)

    print(f"\n{'CONTAINER':<32} {'RUNNING':<18} {'LATEST':<20} {'AGE':>5}  ADVISORIES(crit/high)", file=sys.stderr)
    for f in sorted(facts, key=score, reverse=True):
        adv = f.get("advisories_since_local_build", [])
        ch = sum(1 for a in adv if a["severity"] in ("critical", "high"))
        flag = "!!" if ch else ("!" if adv else "  ")
        eol = f.get("eol", {})
        extra = " EOL" if eol.get("is_eol") else ""
        arch = " ARCHIVED" if f.get("repo_health", {}).get("archived") else ""
        print(f"{flag}{f['container']:<30} {f['running_version'][:17]:<18} "
              f"{f.get('latest_release', '-')[:19]:<20} {str(f.get('local_image_age_days', '?')):>4}d  "
              f"{ch}/{len(adv)}{extra}{arch}", file=sys.stderr)
    print(f"\nwrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
