/**
 * Turn two per-side evaluations into classified rows.
 *
 * The important call here is what counts as a DIFFERENCE. Only a genuine value
 * difference does. Two sides that are both undecidable — even for different reasons
 * — are not a difference; they're two unknowns, and putting them in the diff table
 * would pad the headline number with rows nobody can act on.
 */

import { describeReason, evaluate } from './evaluate.ts';
import type { EvalContext, EvalResult, Flag, Segment, Side } from './types.ts';

export type RowClass = 'differs' | 'same' | 'indeterminate' | 'missing-in-env';

export type Row = {
  key: string;
  name: string;
  left: EvalResult;
  right: EvalResult;
  cls: RowClass;
  leftWhy: string;
  rightWhy: string;
};

export type SideInputs = {
  side: Side;
  segIndex: Map<string, Segment>;
};

function toContext(side: Side): EvalContext {
  return {
    kind: 'customer',
    name: side.customer.name,
    keyAliases: side.customer.keyAliases,
  };
}

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function classify(left: EvalResult, right: EvalResult): RowClass {
  const leftMissing = !left.determinate && left.reason.kind === 'env_missing';
  const rightMissing = !right.determinate && right.reason.kind === 'env_missing';
  if (leftMissing !== rightMissing) return 'missing-in-env';

  if (left.determinate && right.determinate) {
    return jsonEq(left.value, right.value) ? 'same' : 'differs';
  }
  return 'indeterminate';
}

export function buildRows(
  flags: Flag[],
  left: SideInputs,
  right: SideInputs,
  flagsByKey: Map<string, Flag>,
): Row[] {
  const leftCtx = toContext(left.side);
  const rightCtx = toContext(right.side);
  const rows: Row[] = [];

  for (const flag of flags) {
    if (flag.archived) continue;
    const l = evaluate(leftCtx, flag, left.side.env, left.segIndex, flagsByKey);
    const r = evaluate(rightCtx, flag, right.side.env, right.segIndex, flagsByKey);
    rows.push({
      key: flag.key,
      name: flag.name,
      left: l,
      right: r,
      cls: classify(l, r),
      leftWhy: describeReason(l.reason),
      rightWhy: describeReason(r.reason),
    });
  }

  return rows.sort((a, b) => a.key.localeCompare(b.key));
}
