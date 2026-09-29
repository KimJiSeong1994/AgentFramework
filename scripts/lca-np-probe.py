#!/usr/bin/env python3
"""Stage 4 check: does OLLAMA_NUM_PARALLEL=2 give two independent prefix caches (main slot + worker slot)?

    python3 scripts/lca-np-probe.py --host 127.0.0.1:11434            # the user's server (NUM_PARALLEL=1)
    python3 scripts/lca-np-probe.py --host 127.0.0.1:11435            # a second instance started with NUM_PARALLEL=2

Sends two long, different prefixes (A ≈ main's system prompt, B ≈ a worker's) in the order A A B A B A and prints
`prompt_eval_count` per call from /api/generate. With one slot the 4th call (A after B) re-prefills the whole prefix;
with two slots llama-server routes each prompt to the slot holding its cache, so A and B both stay cheap. Also
reports whether the llama-server child runs with `-np 2` and whether the MTP draft (`--spec-type draft-mtp`) is still
enabled. Stdlib only; no OpenCode involved.
"""
import argparse
import json
import subprocess
import time
import urllib.request


def prefix(seed: str, n_words: int) -> str:
    words = ("system rule tool file path verify review ledger queue prefix cache slot worker main ontology " * 200).split()
    return f"[{seed}] " + " ".join(f"{w}{i % 97}" for i, w in enumerate(words[:n_words])) + f"\nUser: reply with the single word {seed}."


def generate(host: str, model: str, prompt: str) -> dict:
    body = json.dumps({"model": model, "prompt": prompt, "stream": False, "keep_alive": "10m", "options": {"num_predict": 4, "temperature": 0}}).encode()
    req = urllib.request.Request(f"http://{host}/api/generate", data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=600) as r:
        d = json.loads(r.read())
    d["_wall"] = round(time.time() - t0, 2)
    return d


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1:11434")
    ap.add_argument("--model", default="gemma4:26b-a4b-it-mtp-q4_K_M")
    ap.add_argument("--words", type=int, default=2500, help="prefix length in words (~3-4K tokens)")
    a = ap.parse_args()
    A, B = prefix("ALPHA", a.words), prefix("BRAVO", a.words)
    order = ["A", "A", "B", "A", "B", "A"]
    rows = []
    for i, k in enumerate(order, 1):
        d = generate(a.host, a.model, A if k == "A" else B)
        pe = d.get("prompt_eval_count", 0)
        rows.append((i, k, pe, round(d.get("prompt_eval_duration", 0) / 1e9, 2), d["_wall"]))
        print(f"call {i} {k}: prompt_eval_count={pe} prefill={rows[-1][3]}s wall={d['_wall']}s", flush=True)
    # prompt_eval_count is the whole prompt even on a cache hit (Ollama reports tokens, not uncached tokens); the
    # prefill DURATION is the signal: a hit takes ~0.05 s, a miss re-prefills at ~700 tok/s
    full = max(r[3] for r in rows)
    reprefill = [r for r in rows[1:] if r[3] > max(0.5, full * 0.3)]
    print(f"\nfull prefill ≈ {full}s for {rows[0][2]} tokens; calls that re-prefilled after the first: {[f'{r[0]}{r[1]}' for r in reprefill] or 'none'}")
    if any(r[0] == 4 for r in reprefill):
        print("verdict: A was evicted by B — only one effective prefix cache")
    else:
        print("verdict: A and B stayed cached across alternation — both prefixes survive (slot or host prompt cache)")
    try:
        ps = subprocess.run(["pgrep", "-fl", "llama-server"], capture_output=True, text=True).stdout
        for line in ps.splitlines():
            if "-np" in line:
                np = line.split("-np")[1].split()[0]
                print(f"llama-server: -np {np}, draft-mtp={'--spec-type draft-mtp' in line}, ctx={line.split('-c ')[1].split()[0] if '-c ' in line else '?'}")
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
