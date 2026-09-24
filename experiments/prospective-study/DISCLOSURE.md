# Local sanitization and disclosure gate

The user approved consistent substitution plus scanning for task-scoped copies.
Original captures, substitution maps, independent acceptance, references and raw
validation output remain local. No local inference model is used. The disclosure
and verification commands make **no model requests**; the separately invoked
[restricted remote runner](REMOTE.md) accepts only a verified sanitized payload.

## What the gate checks

1. Require a frozen capture, exact source-file allowlist and its task rationale.
   Include only the module and dependencies/public checks needed for the task,
   not the entire repository. Do not send unselected files, original metadata,
   credential files, hidden checks or reference code.
2. Use one reversible, injective literal-substitution map across task text,
   decoded JSON/JSONL fields, nested JSON arguments, code and local oracle inputs.
   Recognize common credentials, email addresses, common phone/identity-number
   formats, explicitly named personal-data fields, private IPs/internal hosts,
   URLs and private paths. Extra locally identified names belong in `privateTerms`.
   Absolute path placeholders remain absolute; JSON types and line order remain.
3. Reject unsupported media, binary/invalid UTF-8, long opaque encoded content,
   ambiguous encoded secrets, reserved placeholders and collisions. Never
   silently drop data and label a partial result equivalent.
4. Run Gitleaks with the repository's fixed `scan.toml`, built-in default rules,
   an empty ignore list and input allow-comments disabled. Ambient configuration
   cannot override it. Only exact generated markers are scanner-allowlisted;
   source containing that marker prefix is refused. Record/check scanner version
   and configuration hash. Missing scanner, errors or remaining findings refuse
   the sample rather than treating it as clean.
5. Require exact agreement of the complete inspect report except its source
   byte count/hash. This retains coverage, event membership, process links,
   chronology, directory-scope confidence, references and failure states.
6. Run original and sanitized public checks in disposable networkless Docker
   containers. Both must pass. Run the same frozen hidden cases on both original
   and sanitized initial code, comparing **each case**, not just total failures.
   Apply the separately frozen reference patch to independent copies; it must
   pass public checks and all the same hidden cases on both sides.
7. Generate both supplements from sanitized history, scan the exact outward
   payload again, and seal its file inventory and hashes. Verify the seal,
   original capture, pipeline, private map/scope and scan before opening a payload.
   A gets no supplement; B gets mechanical recent records; C gets inspect facts.
   Every arm receives identical sanitized task/history/workspace bytes.

## Acceptance contract

Acceptance is authored from the real request before treatment outcomes exist.
The agent is responsible for this judgment, rather than asking the user to score
each result. A repair case must reproduce its expected initial failure; an
already-correct case must initially pass. The oracle is a finite executable
interpretation of the request, **not a claim of automatically proven independence
or exhaustive semantic correctness**. Unsuitable tasks are excluded with a reason.

In addition to existing capture contract fields, freeze:

```json
{
  "provenance": "independent-task-specific",
  "expectedInitial": "fail",
  "referenceFiles": [
    { "from": "reference/feature.cjs", "to": "src/feature.cjs" }
  ]
}
```

The reference files reside in the external oracle directory and are copied at
capture time. They never enter `payload/`. Hidden checks must emit one JSON
object on stdout, with unique, non-sensitive case IDs and boolean results:

```json
{"schemaVersion":1,"cases":[{"id":"boundary","passed":false},{"id":"ordinary","passed":true}]}
```

Exit zero iff all cases pass. Both initial runs must match the declared
`expectedInitial`; reference runs must pass every case with unchanged case IDs.
Timeouts, invalid output and execution/environment failures refuse admission.
This first gate targets tasks with a passing public smoke check; tasks whose
public environment cannot run are not currently admitted.

## Commands

Store task-specific scope under ignored local output, for example:

```json
{
  "files": ["src/feature.cjs", "test/public.cjs"],
  "rationale": "The affected module and its fixed public smoke check.",
  "privateTerms": []
}
```

```sh
node experiments/prospective-study/cli.cjs disclose CAPTURE_DIRECTORY SCOPE_JSON
node experiments/prospective-study/cli.cjs verify-disclosure DISCLOSURE_DIRECTORY raw
node experiments/prospective-study/cli.cjs verify-disclosure DISCLOSURE_DIRECTORY mechanical
node experiments/prospective-study/cli.cjs verify-disclosure DISCLOSURE_DIRECTORY xray
```

`disclose` is a local operation, **not an upload**. It refuses an existing output
directory, retains a private exclusion receipt on failure and does not retry
until success. Originals are unchanged. The resulting structure is:

```text
capture/disclosure/
  payload/                  sanitized allowlisted sources, task/history, supplements
  private/                  maps, scope, transformed oracle, references, checks, gate
```

Only `openForArm(directory, arm)` supplies the outward object, using the bytes
actually verified. Never hand a remote model the capture/disclosure filesystem
root. A future remote tool adapter must call `guardToolResponse` before sending
test output or any newly generated content; an original or newly recognized
sensitive value blocks that response. It must not expose a general shell or the
oracle directory. The CLI `run` rejects raw captures and changed/unsealed
payloads; it never falls back to unrestricted snapshot access.

## Limits and evidence

Scanning does not identify every personal name, proprietary fact, indirect
identifier or obfuscated secret. Case-by-case equality on a finite suite is not
full program equivalence. The user-approved method accepts these residual limits;
do not market a passed gate as guaranteed anonymity or safety. Host owners can
forge local manifests: hashes protect against accidental drift, not a hostile
administrator. No provider-retention guarantee follows from this gate.

Synthetic regression tests cover consistent replacements, scanner bypass
attempts, unsupported encodings, directory-scope preservation, per-case changes
hidden by equal totals, an invalid reference, payload tampering, tool-output
leaks and exclusion of private material. Run with a locally pinned Node Docker
image and Gitleaks on PATH:

```sh
AXR_TEST_IMAGE=sha256:YOUR_LOCAL_IMAGE_ID node --experimental-strip-types --test --test-concurrency=1 experiments/prospective-study/*.test.cjs
```

These are infrastructure checks, not real-agent productivity evidence. The
previous 36-trial pilot and its null comparison remain unchanged.

### Sanitization-only validation — 2026-09-24, before remote integration

- 22/22 prospective-study tests pass, including 10 disclosure tests; none skipped.
- 332/332 existing product tests pass. Existing lint scope exits zero with 91
  warnings and 159 informational diagnostics; it does not include experiments.
- A path-shape regression initially changed directory-scope evidence. The strict
  comparison refused it; absolute placeholders now preserve that shape, and the
  same tests pass without weakening diagnostic comparison.
- Local checks on the same three frozen 64-KiB OMP prefixes retain exact
  diagnostic parity, with 45/44/27 distinct literal replacements and zero
  residual Gitleaks findings. These counts include recognized values such as
  URLs, not a count of proven secrets. They are prefix-only transformation
  checks, without workspace/reference acceptance, **not export authorization**.
- This validation made zero remote-model requests and zero local-model requests.
  No real treatment trials have run; utility relative to an ordinary summary is
  still unproven. No new package version is published.

Local receipts: `output/prospective-study/all-tests-final.tap`,
`output/prospective-study/product-tests.tap`,
`output/prospective-study/product-lint.log`, and
`output/prospective-study/real-prefix-check-final.json`. Raw logs, maps and
private evaluation artifacts are not committed or published.
