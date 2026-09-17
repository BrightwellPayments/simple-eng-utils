# ld-flag-compare

Read-only tooling for answering "which LaunchDarkly flags are on for this customer,
and why?" against the ReadyRemit LD project. Everything here uses the LD **REST
API** — no SDK, no writes. Two jobs:

- **`compare`** — diff how every flag resolves between two `(environment, customer)`
  pairs. Same customer across two environments, or two customers in one environment.
- **`audit`** and friends — classify flags by their state in one environment
  (on-for-all / on-for-a-few / off-for-all / other), and check deprecation history.

## Setup

```bash
npm install
cp .env.example .env
# then paste a token into .env
```

Create the token in LD under **Account settings → Authorization → Access tokens**.
**Reader scope is enough** — nothing here writes to LaunchDarkly.

> **Do not copy someone else's `.env`.** It holds a live API token. `.env` is
> gitignored; if this repo is handed over as a folder or zip rather than a clone,
> delete `.env` from the copy and let the next person mint their own token.

Environments in the `ready-remit` project: `qa`, `staging`, `sandbox`, `uat`,
`dev`, `production`.

## Compare

Both modes are the same operation — compare side A against side B, where a side is
an `(environment, customer)` pair. `--env` and `--customer` set both sides;
`--left-*` / `--right-*` override one side.

```bash
# Same customer, two environments — "what's on in UAT that isn't on in prod?"
npm run compare -- --customer "Dash Solutions" --left-env production --right-env uat

# Two customers, one environment — "why does MidAtlantic behave differently?"
npm run compare -- --env production \
  --left-customer "MidAtlantic Federal Credit Union" --right-customer "Brightwell LLC"
```

`npm run compare -- --help` lists every flag. Reports are written to `OUT_DIR`
(default `C:\Code\Plans`) as `flag-diff-<leftEnv>-<leftCustomer>-vs-<rightEnv>-<rightCustomer>.{md,json}`,
and the markdown is also printed to stdout.

### Customers are identified by name

Targeting rules in this project key off the customer's **`name`** attribute — in the
production audit set, 71 targeting values are customer names versus 2 that are keys.
Name is also the only identifier that's stable across environments: the same customer
has a different `customerId` in each one.

```
production   Dash Solutions -> bab2cb18-…
uat          Dash Solutions -> d279f822-…
```

So the name is what you pass, and it's sufficient on its own.

### What key resolution adds

A minority of flags use **individual targeting**, which matches on the context key
rather than the name. To resolve those, the tool looks the customer up in LD's
contexts API for each environment and collects every key shape it has been seen
under:

| shape | reported by |
|---|---|
| `bab2cb18-…` | server SDKs (Transfer API, Jobs) |
| `customer-$bab2cb18-…` | JS / .NET client SDKs |
| `customer-bab2cb18-…` | mobile apps |

A flag matched via a prefixed alias is targeted at the **web or mobile** SDK surface
rather than the server — the report's "why" column names the alias that matched, so
you can tell which.

Resolution never blocks a run. If the customer can't be resolved — LD only retains
contexts an SDK has seen in roughly the last 30 days, so a dormant customer won't be
found — the tool warns, evaluates on name alone, and reports individually-targeted
flags as *indeterminate* rather than quietly claiming they're off. Pass
`--left-key` / `--right-key` to supply a key yourself, or `--no-resolve-keys` to skip
the lookup entirely.

If the name you typed doesn't match but differs only in case or spacing from a real
one, the tool adopts LD's spelling and says so. It does **not** case-fold during
evaluation: LD's `in` operator is case-sensitive, so a real case mismatch between a
context and a rule is a production bug and stays visible as a difference.

### Reading the report

- **Flags that differ** — both sides resolved to a real value, and the values differ.
  This is the section that matters.
- **Flag exists in only one environment** — new flags not yet promoted, mostly.
- **Indeterminate for at least one side** — the REST API cannot decide these without
  the SDK. Percent rollouts, unbounded ("big") segments, unmodeled operators, and
  unresolved individual targeting all land here. **These are not differences.** The
  tool deliberately refuses to guess which side of a rollout a customer falls on;
  that's the SDK's hashing and reproducing it would be a coin flip presented as fact.

## Audit

```bash
npm run audit                  # classify a fixed list of ~84 Transfer API + Jobs flags
npm run audit-ld-only          # classify LD flags OUTSIDE that list
npm run flag-history           # deprecation history for 15 suspected TA/Jobs flags
npm run flag-history-ours      # same, for every off-for-all flag in the audit set
npm run bucket-off-in-prod     # cross-reference prod off-for-all against uat + dev
```

All of them read `AUDIT_ENV` (default `production`) and write to `OUT_DIR`. Output
filenames are keyed by environment — `audit-production-state.json`,
`audit-uat-state.json` — so runs don't clobber each other.

The last three consume the output of the first, so run `npm run audit` for the
relevant environments first. `bucket-off-in-prod` needs all three of `production`,
`uat`, and `dev`:

```bash
AUDIT_ENV=production npm run audit
AUDIT_ENV=uat npm run audit
AUDIT_ENV=dev npm run audit
npm run bucket-off-in-prod
```

Audit buckets: `on-for-all` (fallthrough=true with no carve-outs, or env off with
`offVariation=true`) · `on-for->5` / `on-for-1-5` (partial, counted by explicit
targets) · `off-for-all` · `other` (percent rollout, prerequisite-gated, or rules we
can't resolve) · `archived` · `non-boolean` · `not-found`.

## Files

```
src/
├── index.ts            # compare CLI — arg parsing, wiring, output
├── customer.ts         # customer name -> per-env key aliases
├── evaluate.ts         # rule-walk evaluation for one customer in one environment
├── diff.ts             # per-flag classification across two sides
├── report.ts           # markdown + JSON rendering
├── ldApi.ts            # REST client: pagination, 429 retry, context search
├── types.ts            # LD API shapes + evaluation result types
├── auditProdState.ts   # audit: fixed ~84-flag Transfer API + Jobs list
├── auditLdOnlyFlags.ts # audit: everything outside that list
├── checkFlagHistory.ts # deprecation history from the LD audit log
└── bucketOffInProd.ts  # cross-env sub-bucketing of prod off-for-all flags
```

## Notes and limits

- **Read-only.** Nothing here modifies LaunchDarkly.
- **Evaluation order** mirrors the SDK: prerequisites → off → individual targets →
  rules in order → fallthrough. Anything undecidable from the REST payload is
  reported as indeterminate rather than guessed.
- **Rate limits** — LD allows roughly 5 req/sec. A compare run makes one paginated
  `/flags` call, one `/segments` call per environment, and one context search per
  side. A 429 is retried once, honoring `retry-after`.
- **Typecheck** with `npm run typecheck`. There is no test suite; the regression
  check is a known-answer compare run (see below).

### Known-answer check

Re-running the MidAtlantic vs Brightwell comparison in production should reproduce
`Plans/flag-diff-production-midatlantic-vs-brightwell.md` from 2026-05: 158 live
flags evaluated, 11 differing, 0 indeterminate. Differences beyond that are either
real LD changes since then or a regression — diff the two files and account for
every row.
