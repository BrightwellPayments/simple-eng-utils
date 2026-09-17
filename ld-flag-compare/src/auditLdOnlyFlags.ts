import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';
import { LdClient } from './ldApi.ts';
import type { Flag, EnvironmentConfig } from './types.ts';

dotenv.config();

const TOKEN = process.env.LD_API_TOKEN;
const PROJECT = process.env.LD_PROJECT_KEY ?? 'ready-remit';
const ENV_KEY = process.env.AUDIT_ENV ?? 'production';

if (!TOKEN) {
  console.error('LD_API_TOKEN missing in .env');
  process.exit(1);
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.OUT_DIR ?? path.resolve(SCRIPT_DIR, '..', '..', 'Plans');

/** Written by `npm run audit` for this same environment. */
const AUDIT_INPUT = `audit-${ENV_KEY}-state.json`;

// Names we have specific suspicion about (plausibly-TA / plausibly-Jobs flags
// surfaced in earlier audit). Highlighted in output.
const PLAUSIBLE_TA_JOBS = new Set<string>([
  'alacer-files-reg-entity-data',
  'enable-b2b-transfers',
  'enable-mastercard-name-character-strip',
  'enable-mastercard-name-transliteration',
  'enable-mc-account-cancel',
  'enable-sender-audit-log',
  'enable-sls-beneficiary',
  'sls-include-regulated-entities',
  'dodd-frank-cancel',
  'enable-incomplete-sender-field',
  'enable-mvb-balance-file',
  'enable-reg-entity-by-profile',
  'enable-promo-threshold-pricing-reporting',
  'enable-field-ordering',
  'enable-card-onboarding-fields',
  'validate-transfer-quote-id',
  'quote-by-receive-amount-option',
  'post-transfers-return-top-level-quote-history-id',
  'moneygram-default-subdivision-by-country',
  'sender-fields-skip-id',
  'enable-updated-date-on-entities-report',
]);

type Bucket =
  | 'off-for-all'
  | 'on-for-all'
  | 'on-for-1-5'
  | 'on-for->5'
  | 'other'
  | 'archived'
  | 'non-boolean';

interface Classification {
  flagKey: string;
  bucket: Bucket;
  detail: string;
  staleOn: boolean; // env.on=false but offVariation=true
  explicitTrueCustomers?: string[];
}

function classify(flag: Flag, envKey: string): Classification {
  const flagKey = flag.key;

  if (flag.archived) {
    return { flagKey, bucket: 'archived', detail: 'flag archived globally', staleOn: false };
  }

  const env: EnvironmentConfig | undefined = flag.environments?.[envKey];
  if (!env) {
    return { flagKey, bucket: 'other', detail: `no env config for "${envKey}"`, staleOn: false };
  }

  if (flag.kind !== 'boolean') {
    return { flagKey, bucket: 'non-boolean', detail: `kind=${flag.kind}`, staleOn: false };
  }

  const trueIdx = flag.variations.findIndex((v) => v.value === true);
  const falseIdx = flag.variations.findIndex((v) => v.value === false);
  if (trueIdx < 0 || falseIdx < 0) {
    return { flagKey, bucket: 'non-boolean', detail: 'missing true or false variation', staleOn: false };
  }

  if (env.on === false) {
    const off = env.offVariation ?? falseIdx;
    if (off === trueIdx) {
      return {
        flagKey,
        bucket: 'on-for-all',
        detail: 'env off but offVariation=true (stale-on)',
        staleOn: true,
      };
    }
    return { flagKey, bucket: 'off-for-all', detail: 'env off, serves false', staleOn: false };
  }

  const ft = env.fallthrough;
  const ftIsRollout = !!ft.rollout;
  const ftIsTrue = !ftIsRollout && ft.variation === trueIdx;
  const ftIsFalse = !ftIsRollout && ft.variation === falseIdx;

  const individualTrue = new Set<string>();
  for (const t of env.targets ?? []) {
    if (t.variation === trueIdx) for (const v of t.values) individualTrue.add(v);
  }
  for (const t of env.contextTargets ?? []) {
    if (t.variation === trueIdx) for (const v of t.values) individualTrue.add(v);
  }

  let hasRolloutRule = false;
  let hasUnresolvableTrueRule = false;
  let hasFalseRule = false;
  const ruleEnabled = new Set<string>();

  for (const rule of env.rules ?? []) {
    if (rule.rollout) {
      hasRolloutRule = true;
      continue;
    }
    if (rule.variation === undefined) continue;
    if (rule.variation === falseIdx) {
      hasFalseRule = true;
      continue;
    }
    if (rule.variation !== trueIdx) {
      hasUnresolvableTrueRule = true;
      continue;
    }
    let resolvable = true;
    const matched = new Set<string>();
    let first = true;
    for (const clause of rule.clauses) {
      if (clause.negate) { resolvable = false; break; }
      const attr = clause.attribute?.toLowerCase() ?? '';
      const op = clause.op;
      const ck = (clause.contextKind ?? 'user').toLowerCase();
      if (ck !== 'user' && ck !== 'customer') { resolvable = false; break; }
      const isCustomerKeyAttr =
        attr === 'customerid' || attr === 'key' || attr === 'customername' || attr === 'name';
      if (!isCustomerKeyAttr) { resolvable = false; break; }
      if (op !== 'in') { resolvable = false; break; }
      const values = (clause.values as unknown[]).map((v) => String(v));
      if (first) { for (const v of values) matched.add(v); first = false; }
      else { for (const c of [...matched]) if (!values.includes(c)) matched.delete(c); }
    }
    if (!resolvable) hasUnresolvableTrueRule = true;
    else for (const c of matched) ruleEnabled.add(c);
  }

  if ((env.prerequisites?.length ?? 0) > 0) {
    return {
      flagKey,
      bucket: 'other',
      detail: `has ${env.prerequisites!.length} prerequisite(s)`,
      staleOn: false,
    };
  }

  if (ftIsRollout) {
    return { flagKey, bucket: 'other', detail: 'fallthrough is percent rollout', staleOn: false };
  }

  if (ftIsTrue) {
    if (hasFalseRule || hasRolloutRule || hasUnresolvableTrueRule) {
      return { flagKey, bucket: 'other', detail: 'default-true with carve-outs / unresolvable rules', staleOn: false };
    }
    return { flagKey, bucket: 'on-for-all', detail: 'fallthrough=true, no carve-outs', staleOn: false };
  }

  if (ftIsFalse) {
    if (hasRolloutRule || hasUnresolvableTrueRule) {
      return { flagKey, bucket: 'other', detail: 'default-false with rollout / unresolvable true-rules', staleOn: false };
    }
    const all = new Set<string>([...individualTrue, ...ruleEnabled]);
    const count = all.size;
    if (count === 0) {
      return { flagKey, bucket: 'off-for-all', detail: 'env on but nothing serves true', staleOn: false };
    }
    if (count <= 5) {
      return {
        flagKey,
        bucket: 'on-for-1-5',
        detail: `${count} customer(s) explicitly enabled`,
        staleOn: false,
        explicitTrueCustomers: [...all],
      };
    }
    return {
      flagKey,
      bucket: 'on-for->5',
      detail: `${count} customer(s) explicitly enabled`,
      staleOn: false,
      explicitTrueCustomers: [...all],
    };
  }

  return { flagKey, bucket: 'other', detail: 'unknown fallthrough', staleOn: false };
}

(async function main() {
  const auditFile = path.join(OUT_DIR, AUDIT_INPUT);
  if (!fs.existsSync(auditFile)) {
    console.error(
      `Missing ${auditFile}\nRun the audit for this environment first:\n  AUDIT_ENV=${ENV_KEY} npm run audit`,
    );
    process.exit(1);
  }
  const auditedKeys: Set<string> = new Set(
    JSON.parse(fs.readFileSync(auditFile, 'utf8')).map((r: { flagKey: string }) => r.flagKey),
  );
  console.error(`Loaded ${auditedKeys.size} previously-audited keys.`);

  const client = new LdClient(TOKEN!);
  console.error(`Fetching LD flags for project=${PROJECT} env=${ENV_KEY}…`);
  const flags = await client.listAllFlags(PROJECT, ENV_KEY, ENV_KEY);
  console.error(`Got ${flags.length} flags total.`);

  const ldOnly = flags.filter((f) => !auditedKeys.has(f.key));
  console.error(`Auditing ${ldOnly.length} LD-only flags (not in our 84-flag scope).`);

  const results: Classification[] = ldOnly.map((f) => classify(f, ENV_KEY));

  const buckets: Record<string, Classification[]> = {};
  for (const r of results) {
    (buckets[r.bucket] ??= []).push(r);
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'audit-ld-only.json'),
    JSON.stringify(results, null, 2),
  );

  const order: Bucket[] = ['on-for-all', 'on-for->5', 'on-for-1-5', 'off-for-all', 'other', 'archived', 'non-boolean'];

  const lines: string[] = [];
  lines.push(`# LD-only flags audit — ${PROJECT} / ${ENV_KEY}`);
  lines.push('');
  lines.push(`${flags.length} total flags in LD. ${results.length} are NOT in the 84-flag Transfer API / Jobs audit scope.`);
  lines.push('');
  lines.push('## Bucket counts');
  lines.push('');
  for (const b of order) {
    if (buckets[b]) lines.push(`- **${b}**: ${buckets[b].length}`);
  }
  const staleOnCount = results.filter((r) => r.staleOn).length;
  lines.push(`- _(of which **stale-on**: ${staleOnCount} — env.on=false but offVariation=true)_`);
  lines.push('');

  lines.push('## Plausibly Transfer API / Jobs candidates (21)');
  lines.push('');
  lines.push('| flag | bucket | detail | "always on" deprecated? |');
  lines.push('|---|---|---|---|');
  const plausible = results.filter((r) => PLAUSIBLE_TA_JOBS.has(r.flagKey));
  plausible.sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket) || a.flagKey.localeCompare(b.flagKey));
  for (const r of plausible) {
    const verdict =
      r.bucket === 'on-for-all'
        ? 'YES — rolled out everywhere'
        : r.bucket === 'archived'
          ? 'YES — archived in LD'
          : r.bucket === 'off-for-all'
            ? 'NO — never enabled (abandoned?)'
            : 'NO — still in rollout';
    lines.push(`| \`${r.flagKey}\` | ${r.bucket} | ${r.detail} | ${verdict} |`);
  }
  for (const k of PLAUSIBLE_TA_JOBS) {
    if (!results.find((r) => r.flagKey === k)) {
      lines.push(`| \`${k}\` | _not in LD_ | _missing_ | _can't say_ |`);
    }
  }
  lines.push('');

  for (const b of order) {
    if (!buckets[b]) continue;
    lines.push(`## ${b} (${buckets[b].length})`);
    lines.push('');
    lines.push('| flag | detail | enabled customers |');
    lines.push('|---|---|---|');
    const sorted = [...buckets[b]].sort((a, c) => a.flagKey.localeCompare(c.flagKey));
    for (const r of sorted) {
      const cust = r.explicitTrueCustomers ? r.explicitTrueCustomers.join(', ') : '';
      lines.push(`| \`${r.flagKey}\` | ${r.detail} | ${cust} |`);
    }
    lines.push('');
  }

  fs.writeFileSync(path.join(OUT_DIR, 'audit-ld-only.md'), lines.join('\n'));
  console.error(`Wrote ${path.join(OUT_DIR, 'audit-ld-only.md')}`);
  console.error(`Wrote ${path.join(OUT_DIR, 'audit-ld-only.json')}`);

  // Quick stdout summary
  console.log(`\n=== LD-only flag bucket summary (${results.length} flags) ===`);
  for (const b of order) {
    if (buckets[b]) console.log(`  ${b}: ${buckets[b].length}`);
  }
  console.log(`  (of which stale-on: ${staleOnCount})\n`);

  console.log(`=== Plausibly TA/Jobs flags (${PLAUSIBLE_TA_JOBS.size}) by bucket ===`);
  const counts: Record<string, number> = {};
  for (const r of plausible) counts[r.bucket] = (counts[r.bucket] ?? 0) + 1;
  for (const b of order) if (counts[b]) console.log(`  ${b}: ${counts[b]}`);
  const missingCount = [...PLAUSIBLE_TA_JOBS].filter((k) => !results.find((r) => r.flagKey === k)).length;
  if (missingCount > 0) console.log(`  not-in-LD: ${missingCount}`);
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
