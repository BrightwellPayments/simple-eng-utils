/** Markdown + JSON rendering for a two-sided flag comparison. */

import { slug } from './customer.ts';
import type { Row } from './diff.ts';
import type { EvalResult, Side } from './types.ts';

export function outputBasename(left: Side, right: Side): string {
  const l = `${left.env}-${slug(left.customer.name)}`;
  const r = `${right.env}-${slug(right.customer.name)}`;
  return `flag-diff-${l}-vs-${r}`;
}

function fmtValue(e: EvalResult): string {
  if (!e.determinate) return '_indet_';
  const v = e.value;
  if (v === null || v === undefined) return '_(null)_';
  if (typeof v === 'boolean') return String(v);
  return '`' + JSON.stringify(v) + '`';
}

/** `Dash Solutions @ production` — disambiguates columns in both modes. */
function columnHeader(side: Side): string {
  return `${side.customer.name} @ ${side.env}`;
}

function describeSide(side: Side): string[] {
  const lines: string[] = [];
  const c = side.customer;
  lines.push(`- **${columnHeader(side)}**`);
  lines.push(`  - customer id: ${c.guid ? `\`${c.guid}\`` : '_unresolved — name-only evaluation_'}`);
  if (c.keyAliases.length) {
    lines.push(`  - key shapes matched: ${c.keyAliases.map((k) => `\`${k}\``).join(', ')}`);
  }
  for (const n of c.notes) lines.push(`  - ${n}`);
  return lines;
}

export function renderMarkdown(
  rows: Row[],
  left: Side,
  right: Side,
  project: string,
  generatedAt: string,
  full = false,
): string {
  const differs = rows.filter((r) => r.cls === 'differs');
  const indet = rows.filter((r) => r.cls === 'indeterminate');
  const missing = rows.filter((r) => r.cls === 'missing-in-env');
  const same = rows.filter((r) => r.cls === 'same');

  const L = columnHeader(left);
  const R = columnHeader(right);
  const crossEnv = left.env !== right.env;

  const out: string[] = [];
  out.push(
    crossEnv && left.customer.name === right.customer.name
      ? `# LaunchDarkly flag differences — ${left.customer.name}: ${left.env} vs ${right.env}`
      : `# LaunchDarkly flag differences — ${L} vs ${R}`,
  );
  out.push('');
  out.push(`Project \`${project}\` · kind=customer · matched on \`name\` · generated ${generatedAt}`);
  out.push('');
  out.push(...describeSide(left));
  out.push(...describeSide(right));
  out.push('');
  out.push(
    `Evaluated ${rows.length} live flags: **${differs.length} differ**, ${same.length} identical, ` +
      `${indet.length} indeterminate for at least one side` +
      (missing.length ? `, ${missing.length} missing in one environment` : '') +
      '.',
  );
  out.push('');

  out.push('## Flags that differ');
  out.push('');
  if (differs.length === 0) {
    out.push('_No differences — both sides resolve every flag to the same value._');
  } else {
    out.push(`| flag_key | ${L} | ${R} | why (left / right) |`);
    out.push('|---|---|---|---|');
    for (const r of differs) {
      out.push(
        `| \`${r.key}\` | ${fmtValue(r.left)} | ${fmtValue(r.right)} | ${r.leftWhy} / ${r.rightWhy} |`,
      );
    }
  }
  out.push('');

  if (missing.length) {
    out.push('## Flag exists in only one environment');
    out.push('');
    out.push(`| flag_key | ${L} | ${R} |`);
    out.push('|---|---|---|');
    for (const r of missing) {
      out.push(`| \`${r.key}\` | ${r.leftWhy} | ${r.rightWhy} |`);
    }
    out.push('');
  }

  if (indet.length) {
    out.push('## Indeterminate for at least one side');
    out.push('');
    out.push(
      '_Not confirmed differences. The REST API cannot decide these without the SDK ' +
        '(percent rollouts, unbounded segments, unmodeled operators)._',
    );
    out.push('');
    out.push(`| flag_key | ${L} | ${R} |`);
    out.push('|---|---|---|');
    for (const r of indet) {
      out.push(`| \`${r.key}\` | ${r.leftWhy} | ${r.rightWhy} |`);
    }
    out.push('');
  }

  if (full) {
    out.push('## Full comparison (all flags)');
    out.push('');
    out.push(`| flag_key | ${L} | ${R} | why (left / right) |`);
    out.push('|---|---|---|---|');
    for (const r of rows) {
      out.push(
        `| \`${r.key}\` | ${fmtValue(r.left)} | ${fmtValue(r.right)} | ${r.leftWhy} / ${r.rightWhy} |`,
      );
    }
    out.push('');
  }

  return out.join('\n');
}

export function renderJson(
  rows: Row[],
  left: Side,
  right: Side,
  project: string,
  generatedAt: string,
  full = false,
): string {
  return JSON.stringify(
    {
      project,
      generatedAt,
      left: { env: left.env, customer: left.customer },
      right: { env: right.env, customer: right.customer },
      counts: {
        evaluated: rows.length,
        differs: rows.filter((r) => r.cls === 'differs').length,
        same: rows.filter((r) => r.cls === 'same').length,
        indeterminate: rows.filter((r) => r.cls === 'indeterminate').length,
        missingInEnv: rows.filter((r) => r.cls === 'missing-in-env').length,
      },
      rows: full ? rows : rows.filter((r) => r.cls !== 'same'),
    },
    null,
    2,
  );
}
