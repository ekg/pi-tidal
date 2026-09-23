#!/usr/bin/env python3
"""Mine pi session transcripts for Tidal eval history.

pi stores every session as JSONL under ~/.pi/agent/sessions/<project>/.
Assistant messages contain toolCall parts, so every `tidal_eval` we ever sent is
recoverable, in order, with timestamps — i.e. the edit trace of a performance.

Usage:
  tools/extract_session_evals.py                       # newest session for cwd
  tools/extract_session_evals.py --all                 # every session in the project
  tools/extract_session_evals.py FILE.jsonl ...        # explicit files
  tools/extract_session_evals.py --out ~/livecode/archive

Outputs (per session, in --out):
  <session-id>.evals.tidal   commented, in-order archive of every eval chunk
  <session-id>.evals.jsonl   {"t": iso8601, "tool": ..., "code": ...} per call
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys

PROJECTS = pathlib.Path.home() / ".pi/agent/sessions"
EVAL_TOOLS = {"tidal_eval", "tidal_hush", "tidal_mark", "tidal_status"}


def project_dir(cwd: str) -> pathlib.Path:
    """pi names session dirs from the cwd with '/' -> '-' and a trailing '--'."""
    slug = cwd.replace("/", "-")
    return PROJECTS / f"-{slug}--"


def iter_calls(path: pathlib.Path):
    """Yield (timestamp, tool_name, arguments) for every tool call in a session."""
    for line in path.open(encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = obj.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if isinstance(part, dict) and part.get("type") == "toolCall":
                yield (obj.get("timestamp", ""), part.get("name", ""),
                       part.get("arguments") or {})


def extract(path: pathlib.Path, out: pathlib.Path, only_evals: bool = True):
    sid = re.sub(r"^.*?_", "", path.stem) or path.stem
    recs = []
    for ts, name, args in iter_calls(path):
        if name not in EVAL_TOOLS:
            continue
        if only_evals and name != "tidal_eval":
            continue
        code = args.get("code") or args.get("action") or args.get("label") or ""
        recs.append({"t": ts, "tool": name, "code": code})

    if not recs:
        return None, 0

    out.mkdir(parents=True, exist_ok=True)
    (out / f"{sid}.evals.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in recs) + "\n")

    lines = [f"-- session {path.name}",
             f"-- {len(recs)} eval chunk(s), newest last",
             ""]
    for i, r in enumerate(recs, 1):
        lines.append(f"-- [{i}] {r['t']}")
        lines.append(r["code"].strip())
        lines.append("")
    (out / f"{sid}.evals.tidal").write_text("\n".join(lines))
    return sid, len(recs)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*", help="session .jsonl files")
    ap.add_argument("--all", action="store_true",
                    help="every session in the current project's dir")
    ap.add_argument("--project", default=os.getcwd(),
                    help="project cwd to locate sessions for (default: cwd)")
    ap.add_argument("--out", default=str(pathlib.Path.home() / "livecode/archive"))
    ap.add_argument("--include-marks", action="store_true",
                    help="also archive tidal_mark/hush calls")
    a = ap.parse_args()

    files = [pathlib.Path(f) for f in a.files]
    if not files:
        d = project_dir(a.project)
        if not d.is_dir():
            print(f"no session dir at {d}", file=sys.stderr)
            return 1
        files = sorted(d.glob("*.jsonl"))
        if not a.all:
            files = [max(files, key=lambda p: p.stat().st_mtime)] if files else []

    out = pathlib.Path(a.out).expanduser()
    total = 0
    for f in files:
        sid, n = extract(f, out, only_evals=not a.include_marks)
        if sid:
            print(f"{f.name}: {n} chunks -> {out}/{sid}.evals.tidal")
            total += n
        else:
            print(f"{f.name}: no tidal evals")
    print(f"total {total} chunk(s) -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
