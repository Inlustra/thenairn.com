#!/usr/bin/env python3
"""
Migrate thenairn.com/.env into a single 1Password item, and emit a template
that reconstructs .env byte-for-byte via `op inject`.

Design notes (RAI-15):

  * ONE item, not one-per-variable. Recovery means opening a single 1Password
    entry, not hunting through 73. The item is the complete record: config
    values are stored as plain text fields so they are readable at a glance,
    secrets as concealed fields.

  * The template holds `op://` references ONLY. thenairn.com is a PUBLIC
    GitHub repo, so no literal value from .env may ever land in it -- not even
    the "harmless" paths and hostnames.

  * Comments from .env are STRIPPED from the template, not carried over. This
    is not tidiness: the .env comments annotate the credentials they sit above
    ("UniFi local admin 'claude'", "Dedicated HA user 'frigate'") and in two
    cases state a username that is itself the value of a variable. Copying them
    into a public repo would publish exactly what the migration is meant to
    protect. The comments are preserved instead as the `_env_comments` field on
    the 1Password item, so the recovery context survives without being public.

  * The template is named `tools/env.template`, deliberately NOT `.env.tpl`.
    .gitignore line 2 is `.env.*`, which would swallow that name. The ignore
    rules for .env are correct and are not to be touched (see RAI-15 scope
    note); we route around them instead.

  * Variable order, blank-line grouping and shell quoting are preserved, so the
    rebuilt file stays diff-readable against the original. Because comments are
    dropped, --verify compares the parsed NAME->VALUE mapping rather than a file
    hash: every one of the 73 values must survive the round trip exactly.

Usage:
    env-to-1password.py --dry-run     # classify + report, touches nothing
    env-to-1password.py --apply       # write 1Password item + template
    env-to-1password.py --verify      # rebuild .env from 1P, compare all values

No secret value is ever printed to stdout/stderr by any mode.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

HQ = "/mnt/user/HQ"
OP = os.environ.get("OP_BIN", f"{HQ}/tools/op")
TOKEN_FILE = f"{HQ}/.op/service-account-token"

DEFAULT_ENV = f"{HQ}/thenairn.com/.env"
DEFAULT_TEMPLATE = f"{HQ}/thenairn.com/tools/env.template"
DEFAULT_VAULT = "claw"
DEFAULT_ITEM = "thenairn-env"

# Variables that are configuration, not credentials. Everything NOT in this set
# is treated as a secret and stored concealed -- the default is "assume secret",
# so a new variable added to .env fails safe.
#
# Judgement calls, recorded so they can be argued with:
#   *_USER / *_USERNAME are treated as SECRET. They are half of a credential
#   pair and cost nothing to protect.
#   MAIL_HOST, PLEX_ADVERTISE_IP and MULLVAD_SERVER are treated as CONFIG but
#   still live in 1Password like everything else -- the public repo only ever
#   sees the op:// reference, so classification affects field *type*, not
#   exposure.
CONFIG_VARS = {
    "AMEDIA_DIR",
    "BACKUP_DIR",
    "BOOT_DIR",
    "CAMERA_DIR",
    "COMPOSE_FILE",
    "CONFIG_DIR",
    "DOWNLOADS_DIR",
    "GAMES_DIR",
    "HINDSIGHT_DB_NAME",
    "HINDSIGHT_LLM_MODEL",
    "HINDSIGHT_VERSION",
    "IMMICH_VERSION",
    "INTERNAL_DIR",
    "JWT_ISSUER",
    "LARGE_TEMP_DIR",
    "MAIL_DRIVER",
    "MAIL_ENCRYPTION",
    "MAIL_HOST",
    "MAIL_PORT",
    "MEDIA_DIR",
    "MULLVAD_SERVER",
    "NEXTCLOUD_DIR",
    "OPENCLAW_CONFIG_DIR",
    "OPENCLAW_INFRA_WORKSPACE_DIR",
    "OPENCLAW_WORKSPACE_DIR",
    "PAPERLESS_DOCS_DIR",
    "PERSONAL_MEDIA_DIR",
    "PLEX_ADVERTISE_IP",
    "SCANS_DIR",
    "WUD_SLACK_CHANNEL",
}

ASSIGN_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


def op_env():
    env = dict(os.environ)
    if not env.get("OP_SERVICE_ACCOUNT_TOKEN"):
        with open(TOKEN_FILE) as fh:
            env["OP_SERVICE_ACCOUNT_TOKEN"] = fh.read().strip()
    return env


def run_op(args, stdin=None, check=True):
    proc = subprocess.run(
        [OP, *args],
        input=stdin,
        env=op_env(),
        capture_output=True,
        text=True,
    )
    if check and proc.returncode != 0:
        # op errors can quote the offending value; scrub before surfacing.
        sys.exit(f"op {' '.join(args[:2])} failed (rc={proc.returncode})")
    return proc


def parse_env(path):
    """Return (lines, entries). entries: name -> (value, quoted, line_index)."""
    with open(path) as fh:
        lines = fh.read().split("\n")

    entries = {}
    for i, line in enumerate(lines):
        m = ASSIGN_RE.match(line)
        if not m:
            continue
        name, raw = m.group(1), m.group(2)
        quoted = len(raw) >= 2 and raw.startswith('"') and raw.endswith('"')
        value = raw[1:-1] if quoted else raw
        if '"' in value or "\\" in value:
            sys.exit(
                f"{name}: value contains a quote or backslash; round-trip through "
                "the template is not guaranteed. Handle this variable by hand."
            )
        if name in entries:
            sys.exit(f"{name}: assigned twice in {path}; resolve before migrating.")
        entries[name] = (value, quoted, i)
    return lines, entries


def build_template(lines, entries, vault, item_id, item_title):
    """Emit op:// references only. Comments are dropped (see module docstring);
    blank-line grouping is kept so the file stays readable.

    References use the item's immutable ID, not its title. A title reference
    breaks the moment an item with that title is deleted and recreated: op's
    secret provisioning keeps resolving to the dead one ("could not find item
    ... because it has been deleted or archived"). The ID also survives someone
    renaming the item in the 1Password UI.
    """
    by_index = {idx: name for name, (_v, _q, idx) in entries.items()}
    out = []
    for i, line in enumerate(lines):
        if i in by_index:
            name = by_index[i]
            _value, quoted, _idx = entries[name]
            ref = f"op://{vault}/{item_id}/{name}"
            out.append(f'{name}="{ref}"' if quoted else f"{name}={ref}")
        elif line.strip().startswith("#"):
            continue  # never publish .env commentary
        else:
            out.append(line)

    # Collapse runs of blank lines left behind by removed comments.
    collapsed = []
    for line in out:
        if line.strip() == "" and collapsed and collapsed[-1].strip() == "":
            continue
        collapsed.append(line)

    header = [
        "# Generated by tools/env-to-1password.py -- DO NOT EDIT BY HAND.",
        "# Every value lives in 1Password. Rebuild .env with:",
        "#     tools/bootstrap-env.sh",
        "# This file contains references only and is safe in a public repo.",
        f"# Source item: {item_title!r} in vault {vault!r} (referenced by ID below).",
        "",
    ]
    return "\n".join(header + collapsed)


def build_item_json(lines, entries, item):
    fields = []
    for name, (value, _quoted, _idx) in sorted(entries.items()):
        fields.append(
            {
                "id": name,
                "label": name,
                "type": "STRING" if name in CONFIG_VARS else "CONCEALED",
                "value": value,
            }
        )
    # Preserve the .env commentary here rather than in the public template.
    comments = [l for l in lines if l.strip().startswith("#")]
    if comments:
        fields.append(
            {
                "id": "_env_comments",
                "label": "_env_comments",
                "type": "CONCEALED",
                "value": "\n".join(comments),
            }
        )
    return {"title": item, "category": "SECURE_NOTE", "fields": fields}


def sha(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def item_exists(vault, item):
    proc = run_op(["item", "get", item, "--vault", vault, "--format", "json"], check=False)
    return proc.returncode == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", default=DEFAULT_ENV)
    ap.add_argument("--template", default=DEFAULT_TEMPLATE)
    ap.add_argument("--vault", default=DEFAULT_VAULT)
    ap.add_argument("--item", default=DEFAULT_ITEM)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--verify", action="store_true")
    args = ap.parse_args()

    if not (args.apply or args.verify):
        args.dry_run = True

    lines, entries = parse_env(args.env)
    secrets = [n for n in entries if n not in CONFIG_VARS]
    config = [n for n in entries if n in CONFIG_VARS]
    unknown_config = CONFIG_VARS - set(entries)

    print(f"source        : {args.env}")
    print(f"sha256        : {sha(args.env)}")
    print(f"variables     : {len(entries)}")
    print(f"  secret      : {len(secrets)}  (stored CONCEALED)")
    print(f"  config      : {len(config)}  (stored as plain text)")
    print(f"destination   : op://{args.vault}/{args.item}")
    print(f"template      : {args.template}")
    if unknown_config:
        print(f"NOTE: classified-as-config but absent from .env: {sorted(unknown_config)}")

    if args.dry_run:
        print("\n-- secret (concealed) --")
        for n in sorted(secrets):
            print(f"   {n}")
        print("\n-- config (plain text) --")
        for n in sorted(config):
            print(f"   {n}")
        print("\ndry run: nothing written.")
        return

    if args.apply:
        payload = build_item_json(lines, entries, args.item)
        fd, tmp = tempfile.mkstemp(prefix="rai15-", suffix=".json")
        os.fchmod(fd, 0o600)
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(payload, fh)
            if item_exists(args.vault, args.item):
                sys.exit(
                    f"op://{args.vault}/{args.item} already exists. Refusing to "
                    "overwrite. Delete or rename it first, or pass --item."
                )
            proc = run_op(
                ["item", "create", "--vault", args.vault, "--template", tmp,
                 "--format", "json"]
            )
            item_id = json.loads(proc.stdout)["id"]
        finally:
            os.remove(tmp)
        print(f"\ncreated op://{args.vault}/{item_id} ({args.item}) with {len(entries)} fields")

        tpl = build_template(lines, entries, args.vault, item_id, args.item)
        with open(args.template, "w") as fh:
            fh.write(tpl)
        os.chmod(args.template, 0o644)
        print(f"wrote {args.template} ({len(entries)} op:// references, 0 literal values)")
        print("\nnow run: env-to-1password.py --verify")
        return

    if args.verify:
        fd, tmp = tempfile.mkstemp(prefix="rai15-verify-")
        os.close(fd)
        os.chmod(tmp, 0o600)
        try:
            proc = run_op(["inject", "-i", args.template, "-o", tmp, "-f"], check=False)
            if proc.returncode != 0:
                sys.exit("op inject failed; template references do not resolve.")

            _rebuilt_lines, rebuilt = parse_env(tmp)
            origin = {n: v for n, (v, _q, _i) in entries.items()}
            got = {n: v for n, (v, _q, _i) in rebuilt.items()}

            missing = sorted(set(origin) - set(got))
            extra = sorted(set(got) - set(origin))
            differing = sorted(n for n in set(origin) & set(got) if origin[n] != got[n])

            print(f"\nrebuilt variables : {len(got)} / {len(origin)}")
            print(f"missing           : {missing or 'none'}")
            print(f"unexpected        : {extra or 'none'}")
            print(f"value mismatches  : {differing or 'none'}")
            if missing or extra or differing:
                sys.exit("\nMISMATCH: rebuilt .env does not reproduce the original values.")
            print(f"\nVERIFIED: all {len(origin)} values round-trip exactly through 1Password.")
        finally:
            os.remove(tmp)


if __name__ == "__main__":
    main()
