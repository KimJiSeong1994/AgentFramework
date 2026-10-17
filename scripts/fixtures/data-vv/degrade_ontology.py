#!/usr/bin/env python3
"""Copy the fixture's EvoOntology workspace and remove the pieces that were added after the first stage-3 e2e runs
(the "가금" term + mapping, the inclusive-window and radius-self conventions, the counting-word aliases of the
wild-bird term). On that degraded workspace HPAI-MAP-002/003 fail again, which gives the stage-4 evolution driver a
real gap to close: `python3 scripts/otter-evo-evolve.py --workspace <out>/.evoontology`.

    python3 scripts/fixtures/data-vv/degrade_ontology.py ~/.cache/otter/e2e/evo-degraded
"""
import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DROP_TERMS = {"t-poultry"}
DROP_CONSTRAINTS = {"c-window-inclusive", "c-radius-self"}
DROP_ALIASES = {"t-outbreak-wild": {"건수", "검출 건수", "야생조류 검출 건수", "야생조류 검출건수", "검출건수"}}
DROP_KEYWORDS = {"c-livestock-like": {"가금"}}


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    out = Path(sys.argv[1]).expanduser().resolve()
    src = HERE / ".evoontology"
    dst = out / ".evoontology"
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("trajectories", "evolution", "tasks", "visualizations"))
    active = json.loads((dst / "active.json").read_text(encoding="utf-8"))
    version = active.get("active_version") or active.get("version")
    vdir = dst / "versions" / version
    load = lambda n: json.loads((vdir / n).read_text(encoding="utf-8"))
    save = lambda n, v: (vdir / n).write_text(json.dumps(v, ensure_ascii=False, indent=2), encoding="utf-8")
    terms = [t for t in load("terms.json") if t["id"] not in DROP_TERMS]
    for t in terms:
        if t["id"] in DROP_ALIASES:
            t["aliases"] = [a for a in t.get("aliases", []) if a not in DROP_ALIASES[t["id"]]]
    mappings = [m for m in load("mappings.json") if m["term_id"] not in DROP_TERMS]
    relations = [r for r in load("relations.json") if r["source"] not in DROP_TERMS and r["target"] not in DROP_TERMS]
    constraints = [c for c in load("constraints.json") if c["id"] not in DROP_CONSTRAINTS and c["target"] not in DROP_TERMS]
    for c in constraints:
        if c["id"] in DROP_KEYWORDS:
            c["trigger_keywords"] = [k for k in c["trigger_keywords"] if k not in DROP_KEYWORDS[c["id"]]]
    save("terms.json", terms)
    save("mappings.json", mappings)
    save("relations.json", relations)
    save("constraints.json", constraints)
    (dst / "state.json").unlink(missing_ok=True)
    print(f"degraded workspace: {dst} (version {version}: {len(terms)} terms, {len(mappings)} mappings, {len(constraints)} constraints)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
