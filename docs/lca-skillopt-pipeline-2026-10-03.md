# Wiki-grounded SkillOpt pilot: capability-blocked execution

## Status and scope

The requested outcome is real Microsoft/SkillOpt optimization of `llm-wiki`, independent qualification, candidate-specific user approval, safe production application and fresh verification. **That outcome has not been delivered.** No model experiment, optimizer-generated candidate, independent final result or production skill change has occurred.

The first non-inference capability gate stops with `isolation_unavailable`. Core evidence/fragment validation and separate upstream/native publication work do not substitute for a working end-to-end optimization experiment. The missing live host, containment, evaluator, fixture and application evidence must not be inferred from unit tests. Full pipeline completion remains blocked, not waived.

The [observed preflight receipt](../artifacts/skillopt-pilot/capability.json) records the refusal and its evidence limits.

[Non-inference verification](../artifacts/skillopt-pilot/verification.json): 702 framework tests passed, one skipped; strict TypeScript passed; 36 Python tests passed, including nine native scratch tests. The framework total includes 22 real Darwin transaction tests. Scoped architecture findings were resolved; these checks do not constitute the final experiment/production boundary review.

The production `.agents/skills/llm-wiki/SKILL.md` remains SHA256 `ed89aae4ffa07e585d4977f4964b0638ad3bb58c85e35fd7ff219551bcc1583b`. P1 remains closed/off with its original campaign binding. No observation activation, transcript harvesting, Wiki compilation/capture/register, model download, runtime upgrade, policy/router/permission change or Git publication is part of this work.

## Exact source and authority boundary

- Upstream: [Microsoft/SkillOpt](https://github.com/microsoft/SkillOpt), MIT, commit `fa4ca184573e42ec11472959dd57422381418096`. Source version `0.2.0` alone does not identify the required API revision.
- Dependencies are isolated and hash-locked in `scripts/skillopt-requirements.lock`. No optional cloud/benchmark/UI extras or global environment changes are needed. Source/import/license/dependency and private interpreter identities require the runner's actual verification, not just a successful import.
- Research snapshot includes the immutable authored note `42a99b2d70786650607a57589de0e8bfa4f07c5e97e1a485cd9a686b26b02df8` **and** its source-page A13 erratum identifying ExitPlanTool. The raw Bash typo is historical data, not the corrected claim. This is an authored-note hash, not a web-original snapshot hash.
- Only a supplemental paragraph after exact Compile step 2 may be optimized. Every existing byte, including all eight Compile requirements, is protected. Empty fragment means byte-identical baseline; no hand-authored winning seed. Paragraph limits are 1200 UTF-8 bytes/200 estimated tokens; full skill limits are 16384 bytes/2000 estimated body tokens. Structural validation does not replace independent semantic authority review.
- Source snapshots are metadata only: relative path, size, content hash and raw/annotation/synthesis/contract classification. Source locks, aliases, changing inodes, malformed encoding, detected secrets, missing correction or protected configuration drift are refused.

## Observed runtime blocker

The actual version commands reported OpenCode `1.18.33` and Ollama `0.34.3`; declared SDK/plugin pins remain `1.18.32`. Resolved launcher-file hashes are recorded by `preflight`, but do not claim transitive native executable identity, actual skill loading or original-loaded-byte attestation.

A minimal `sandbox-exec` launch succeeded. It is only a primitive smoke test; actual role-specific filesystem/network/child containment remains unverified.

The reviewed Ollama implementation allocates its internal llama-server port with `ListenTCP(localhost:0)`, closes that reservation and then starts the child on the selected port:

- [Runner allocation and child launch](https://github.com/ollama/ollama/blob/v0.34.3/llm/llama_server.go#L360-L505).
- [Scheduler runner construction](https://github.com/ollama/ollama/blob/v0.34.3/server/sched.go).
- [Public-listener environment controls](https://github.com/ollama/ollama/blob/v0.34.3/envconfig/config.go).

No supported fixed/reserved internal runner route was found in these surfaces. `OLLAMA_HOST` fixes the **outer** listener, not the internal route. The installed native runner's observed `--no-jinja`/chat-template path also prevents silently substituting direct native OpenAI chat and assuming identical rendering/tools/thinking.

The approved boundary requires an evaluation-owned OS-contained service and narrowly fixed/reserved routes. It excludes broad loopback permission, use of an arbitrary shared service as if owned, host patch/fork/upgrade or renderer/provider substitution. No such workaround was attempted. Continuing the genuine end-to-end slice requires an explicit owner decision about that runtime constraint, followed by the corresponding reviewed, actually verified implementation. A capability refusal is not an optimization success.

## Available commands

From the repository root:

```sh
bun scripts/lca-skillopt.ts snapshot
bun scripts/lca-skillopt.ts preflight
bun test framework/test/skillopt-pilot.test.ts framework/test/skillopt-host.test.ts
```

`snapshot` exits zero only for a valid bounded source snapshot. `preflight` currently exits **1** with a structured refusal, zero pilot backend requests, `experimentAdmitted:false`, `productionApplied:false`, and explicit unverified live-role/load fields. Missing runtime/version/sandbox evidence also refuses. Neither command writes Wiki or skill bytes, starts a model service, or produces a candidate. Unknown phases, including `optimize`/`apply`, exit **2**; there is no successful placeholder phase.

The Python/native modules are subordinate implementation work, not a bypass around this admission gate. Actual interpreter verification must use the dedicated absolute `SKILLOPT_PYTHON` with `-I`; no PATH Python or guessed install attestation. Native publication checks belong in scratch until a genuinely qualified and independently reviewed candidate has owner-observed approval. No production apply or rollback is currently warranted.

The [measured Python runtime receipt](../artifacts/skillopt-pilot/runtime.json) verifies Python 3.13.2, the pinned upstream version, MIT license, installed source manifest (141 files/963171 bytes), dependency lock and interpreter hash. The portable source lock binds the SHA256 of a private `runtime-proof.json` beside the venv; absolute interpreter and venv paths stay in that private receipt. This is installation provenance, not model execution or containment evidence.

With the dedicated absolute interpreter already exported as `SKILLOPT_PYTHON`, non-inference checks are:

```sh
"$SKILLOPT_PYTHON" -I scripts/skillopt_runner.py verify-runtime --source-lock scripts/skillopt-source-lock.json
"$SKILLOPT_PYTHON" -I -m unittest discover -s tests -p 'test_skillopt_*.py'
```

Native access probes report numeric OS error codes only. Read probes discard contents, write probes neither create nor modify files, and literal-IP TCP probes send no application bytes. Their scratch tests do not establish actual role containment.

Native exchange protocol v2 captures a stable bounded displaced third version from its open descriptor into private durable retention before closing it. This preserves the observed snapshot, not unlimited subsequent writes. An oversized, changing or otherwise uncaptured object produces `RACE_HELD`; EOF is not a release acknowledgement. The controller must retain that helper for explicit owner recovery rather than treating a recovery log entry as permission to discard user work. Native fault tests use a separately compiled test-only barrier variant; production builds have no environment-controlled fault barrier.

## Unchanged experiment and promotion requirements

Before full model execution, the complete approved source-derived schedule, actual role containment, fresh skill returned-body witness, independent fixture/gold isolation and measured forecast must pass. Training/selection/final/safety minimum independent families remain 24/16/24/12, with the prescribed three-repeat paired comparisons and four final strata. Final gold stays unavailable to the optimizer; agent-authored examples cannot be relabeled human-authored.

Hard limits: 8000 actual target and 40 optimizer backend requests, six active hours, 256 MiB private artifacts, one serial GPU inference, one epoch, at most three candidate steps, protected final/canary reserves and no automatic budget resets/expansion. The initial agent-proposed 500-request and universal 80%-power conditions were explicitly corrected before any model results; actual evidence gates were not weakened. Descriptive sensitivity is not a guarantee of power or efficacy.

Qualification still needs selection/final gain at least five percentage points, final two-sided 95% family-cluster bootstrap lower endpoint strictly above zero (10000 resamples, fixed seed), no critical-stratum regression, every safety repeat passing, no missing mandatory trial, latency ratio at most 1.10, and unchanged byte/token/provenance limits. None of these outcomes has been measured here.

Production application additionally requires independent authority review and the user's approval of the **exact candidate and bound evidence**. The native design uses durable backups/journaling and Darwin atomic exchange with retained displaced inodes; it is not compare-and-swap and cannot exclude uncooperative writers. A third version must be preserved, never overwritten to make recovery look successful. A fresh read-only production load and isolated behavior check on exact applied bytes are required afterward. No infrastructure test, simulated pass matrix or preflight refusal fulfils these deliverables.
