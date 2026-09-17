/**
 * Rule-walk evaluation of a LaunchDarkly flag for one customer in one environment,
 * using only what the REST API exposes.
 *
 * The walk mirrors the SDK's order: prerequisites -> off -> individual targets ->
 * rules (in order) -> fallthrough. Anything the REST payload cannot decide — percent
 * rollouts, unbounded segments, operators we don't model — comes back as
 * INDETERMINATE rather than a guess. A wrong confident answer is worse than a
 * flagged unknown, because the whole point of the tool is to be believed.
 */

import type {
  Clause,
  EnvironmentConfig,
  EvalContext,
  EvalReason,
  EvalResult,
  Flag,
  Rule,
  Segment,
  VariationOrRollout,
} from './types.ts';

/** Tri-state: true / false / null where null means "cannot decide". */
type Tri = boolean | null;

/**
 * Read the attribute a clause targets off our synthetic customer context.
 *
 * Three outcomes, and the difference matters:
 *  - `known`   — we have value(s). A LIST, because a customer has several key
 *                shapes (see ResolvedCustomer); a clause matches if any alias does.
 *  - `unknown` — the attribute isn't carried on this context at all. Definite
 *                non-match, exactly as LD treats a missing attribute.
 *  - `unresolved` — the attribute IS this customer's identity but we failed to
 *                resolve it (no key). Undecidable: answering "no match" here would
 *                report an individually-targeted flag as off for the customer.
 */
type AttrLookup =
  | { state: 'known'; values: string[] }
  | { state: 'unknown' }
  | { state: 'unresolved' };

function ctxAttrValues(ctx: EvalContext, attribute: string): AttrLookup {
  const a = attribute.toLowerCase();
  if (a === 'name' || a === 'customername') return { state: 'known', values: [ctx.name] };
  // For ReadyRemit customer contexts the context key IS the customerId.
  if (a === 'key' || a === 'customerid') {
    return ctx.keyAliases.length
      ? { state: 'known', values: ctx.keyAliases }
      : { state: 'unresolved' };
  }
  return { state: 'unknown' };
}

/**
 * Does the context match a single non-segment clause?
 *
 * Returns null when undecidable. Note the deliberate asymmetry between the two
 * "no match" cases below: a missing ATTRIBUTE is a definite non-match (LD treats it
 * that way, and `negate` legitimately flips it), but a clause scoped to a context
 * KIND we don't model is undecidable — the real evaluation context may well carry
 * that kind, so answering `false` there would let a `negate` flip it into a
 * confident, wrong `true`.
 */
function clauseMatchesSimple(ctx: EvalContext, clause: Clause): Tri {
  const ck = (clause.contextKind ?? 'user').toLowerCase();
  if (ck !== 'customer' && ck !== 'user') return null;

  const lookup = ctxAttrValues(ctx, clause.attribute ?? '');
  if (lookup.state === 'unknown') return false;
  if (lookup.state === 'unresolved') return null;
  const actuals = lookup.values;

  const values = (clause.values ?? []).map((v) => String(v));

  // LD's string operators are case-sensitive; we match its semantics exactly. A
  // case mismatch between context and rule is a real production bug, so it has to
  // stay visible as a difference rather than being normalized away here. The CLI
  // guards the input side by adopting LD's canonical spelling of the name.
  const anyAlias = (pred: (actual: string) => Tri): Tri => {
    let sawNull = false;
    for (const actual of actuals) {
      const r = pred(actual);
      if (r === true) return true;
      if (r === null) sawNull = true;
    }
    return sawNull ? null : false;
  };

  switch (clause.op) {
    case 'in':
      return anyAlias((actual) => values.includes(actual));
    case 'contains':
      return anyAlias((actual) => values.some((v) => actual.includes(v)));
    case 'startsWith':
      return anyAlias((actual) => values.some((v) => actual.startsWith(v)));
    case 'endsWith':
      return anyAlias((actual) => values.some((v) => actual.endsWith(v)));
    case 'matches':
      return anyAlias((actual) => {
        try {
          return values.some((v) => new RegExp(v).test(actual));
        } catch {
          return null;
        }
      });
    default:
      return null; // numeric / date / semver ops we don't model
  }
}

function keyInSegmentList(
  ctx: EvalContext,
  flat: string[] | undefined,
  contextual: Array<{ contextKind: string; values: string[] }> | undefined,
): boolean {
  if (flat?.some((k) => ctx.keyAliases.includes(k))) return true;
  for (const c of contextual ?? []) {
    const kind = (c.contextKind ?? 'user').toLowerCase();
    if ((kind === ctx.kind || kind === 'user') && c.values?.some((k) => ctx.keyAliases.includes(k))) {
      return true;
    }
  }
  return false;
}

/** Segment membership. null when a segment rule is undecidable. */
export function inSegment(ctx: EvalContext, seg: Segment | undefined): Tri {
  if (!seg) return false;
  if (seg.unbounded) return null; // big segment — membership lives out-of-band
  if (keyInSegmentList(ctx, seg.excluded, seg.excludedContexts)) return false;
  if (keyInSegmentList(ctx, seg.included, seg.includedContexts)) return true;
  for (const rule of seg.rules ?? []) {
    if (rule.weight !== undefined && rule.weight !== null) return null; // % rollout
    let allMatch = true;
    for (const clause of rule.clauses ?? []) {
      let m = clauseMatchesSimple(ctx, clause);
      if (m === null) return null;
      if (clause.negate) m = !m;
      if (!m) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return true;
  }
  return false;
}

/** Full clause eval, including segmentMatch (which needs the segment index). */
function clauseMatches(ctx: EvalContext, clause: Clause, segIndex: Map<string, Segment>): Tri {
  const op = clause.op?.toLowerCase();
  if (op === 'segmentmatch') {
    let anyNull = false;
    for (const segKey of (clause.values ?? []).map((v) => String(v))) {
      const r = inSegment(ctx, segIndex.get(segKey));
      if (r === true) return true;
      if (r === null) anyNull = true;
    }
    return anyNull ? null : false;
  }
  return clauseMatchesSimple(ctx, clause);
}

/** Clauses within a rule are ANDed. A single definite non-match kills the rule. */
function ruleMatches(ctx: EvalContext, rule: Rule, segIndex: Map<string, Segment>): Tri {
  let sawNull = false;
  for (const clause of rule.clauses ?? []) {
    let m = clauseMatches(ctx, clause, segIndex);
    if (m === null) {
      sawNull = true;
      continue;
    }
    if (clause.negate) m = !m;
    if (!m) return false;
  }
  return sawNull ? null : true;
}

/** Which alias did an individual target hit? Used for the report's "why" column. */
function matchedTargetAlias(ctx: EvalContext, values: string[] | undefined): string | undefined {
  return (values ?? []).find((v) => ctx.keyAliases.includes(v));
}

function variationValue(flag: Flag, idx: number | undefined): unknown {
  if (idx === undefined) return null;
  return flag.variations[idx]?.value;
}

function determinate(flag: Flag, idx: number | undefined, reason: EvalReason): EvalResult {
  return {
    determinate: true,
    variationIndex: idx ?? -1,
    value: variationValue(flag, idx),
    reason,
  };
}

export function evaluate(
  ctx: EvalContext,
  flag: Flag,
  envKey: string,
  segIndex: Map<string, Segment>,
  flagsByKey: Map<string, Flag>,
  depth = 0,
): EvalResult {
  if (flag.archived) return determinate(flag, undefined, { kind: 'archived' });

  const env: EnvironmentConfig | undefined = flag.environments?.[envKey];
  if (!env) return { determinate: false, reason: { kind: 'env_missing', env: envKey } };
  if (depth > 10) return { determinate: false, reason: { kind: 'depth_exceeded' } };

  // Prerequisites: the parent must be ON and serving the required variation.
  for (const pre of env.prerequisites ?? []) {
    const parent = flagsByKey.get(pre.key);
    if (!parent) {
      return { determinate: false, reason: { kind: 'prerequisite_missing', prerequisiteKey: pre.key } };
    }
    const parentEnv = parent.environments?.[envKey];
    if (parentEnv && parentEnv.on === false) {
      return determinate(flag, env.offVariation, {
        kind: 'prerequisite_failed',
        prerequisiteKey: pre.key,
      });
    }
    const pEval = evaluate(ctx, parent, envKey, segIndex, flagsByKey, depth + 1);
    if (!pEval.determinate) {
      return {
        determinate: false,
        reason: {
          kind: 'prerequisite_indeterminate',
          prerequisiteKey: pre.key,
          detail: describeReason(pEval.reason),
        },
      };
    }
    if (pEval.variationIndex !== pre.variation) {
      return determinate(flag, env.offVariation, {
        kind: 'prerequisite_failed',
        prerequisiteKey: pre.key,
      });
    }
  }

  if (env.on === false) return determinate(flag, env.offVariation, { kind: 'off' });

  // Individual targets, matched against every key shape this customer uses.
  const targets = [...(env.targets ?? []), ...(env.contextTargets ?? [])].filter((t) => {
    const tk = (t.contextKind ?? 'user').toLowerCase();
    return tk === 'customer' || tk === 'user';
  });
  for (const t of targets) {
    const alias = matchedTargetAlias(ctx, t.values);
    if (alias !== undefined) {
      return determinate(flag, t.variation, { kind: 'target', matchedAlias: alias });
    }
  }
  // No alias matched — but with no resolved key we cannot claim the customer ISN'T
  // in that target list. Only flags that actually use individual targeting are
  // affected; everything else proceeds to the rules.
  if (ctx.keyAliases.length === 0 && targets.some((t) => (t.values ?? []).length > 0)) {
    return {
      determinate: false,
      reason: {
        kind: 'key_unresolved',
        detail: 'flag uses individual targeting and no customer key was resolved',
      },
    };
  }

  let idx = 0;
  for (const rule of env.rules ?? []) {
    const m = ruleMatches(ctx, rule, segIndex);
    if (m === null) {
      return {
        determinate: false,
        reason: {
          kind: 'rule_indeterminate',
          ruleIndex: idx,
          detail: 'undecidable clause (segment, rollout, or unmodeled operator)',
        },
      };
    }
    if (m) {
      if (rule.rollout) {
        return {
          determinate: false,
          reason: { kind: 'rollout_indeterminate', from: 'rule', ruleIndex: idx },
        };
      }
      return determinate(flag, rule.variation, {
        kind: 'rule',
        ruleIndex: idx,
        ruleDescription: rule.description,
      });
    }
    idx++;
  }

  const ft: VariationOrRollout = env.fallthrough;
  if (ft.rollout) {
    return { determinate: false, reason: { kind: 'rollout_indeterminate', from: 'fallthrough' } };
  }
  return determinate(flag, ft.variation, { kind: 'fallthrough' });
}

/** Human-readable "why" for the report's explanation column. */
export function describeReason(r: EvalReason): string {
  switch (r.kind) {
    case 'archived':
      return 'flag archived';
    case 'off':
      return 'flag OFF → offVariation';
    case 'prerequisite_failed':
      return `prerequisite \`${r.prerequisiteKey}\` not met`;
    case 'target':
      return `individual target (\`${r.matchedAlias}\`)`;
    case 'rule':
      return `rule #${r.ruleIndex} matched${r.ruleDescription ? ` (${r.ruleDescription})` : ''}`;
    case 'fallthrough':
      return 'fallthrough (default)';
    case 'env_missing':
      return `no \`${r.env}\` env config`;
    case 'rollout_indeterminate':
      return r.from === 'fallthrough'
        ? 'fallthrough is a % rollout'
        : `rule #${r.ruleIndex} matched but serves a % rollout`;
    case 'segment_indeterminate':
      return `rule #${r.ruleIndex} depends on segment \`${r.segmentKey}\``;
    case 'rule_indeterminate':
      return `rule #${r.ruleIndex}: ${r.detail}`;
    case 'key_unresolved':
      return r.detail;
    case 'prerequisite_indeterminate':
      return `prerequisite \`${r.prerequisiteKey}\` indeterminate: ${r.detail}`;
    case 'prerequisite_missing':
      return `prerequisite \`${r.prerequisiteKey}\` not found`;
    case 'depth_exceeded':
      return 'prerequisite chain too deep';
    case 'error':
      return r.message;
  }
}
