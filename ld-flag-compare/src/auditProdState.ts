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

// Output writes land in C:\Code\Plans\ regardless of cwd, resolved relative to
// this script file. Set OUT_DIR to send them somewhere else.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.OUT_DIR ?? path.resolve(SCRIPT_DIR, '..', '..', 'Plans');

const FLAG_KEYS: string[] = [
  // Transfer API + Jobs unique flag keys (84 total) — from Step 1 inventory
  'allow-non-us-senders',
  'bancorp-balance-check-2024',
  'enable-accept-policy-copy',
  'enable-aft-partialauth',
  'enable-ascii-bancorp-entities',
  'enable-ascii-bancorp-transactions',
  'enable-ascii-pathward-recon',
  'enable-ascii-pending-prefunding-recon',
  'enable-ascii-prefunding-recon',
  'enable-async-doddfrank',
  'enable-bad-bin-validation',
  'enable-business-recipient-limits',
  'enable-card-bin-validation',
  'enable-cash-payer-transaction-limits',
  'enable-cmf-additional-names',
  'enable-cmf-separate-second-last-name',
  'enable-customer-hold-release',
  'enable-customer-specific-bin-validation',
  'enable-default-mobile-wallet-provider',
  'enable-dynamic-field-rules',
  'enable-dynamic-mobile-wallets',
  'enable-flex-van-balance-check',
  'enable-generic-hold-release',
  'enable-get-ledger-entries-from-database',
  'enable-get-transfers',
  'enable-hold-event-logging',
  'enable-locks-for-settlement-accounts-update',
  'enable-mastercard-paying-branch-routing',
  'enable-mastercard-time-out-response',
  'enable-moneygram-reporting',
  'enable-multiple-rsp-per-customer',
  'enable-new-customer-recon',
  'enable-new-transfer-status-webhook-fields',
  'enable-pending-cancel',
  'enable-promo-threshold-pricing',
  'enable-pull-funds-cross-provider',
  'enable-quote-blocking',
  'enable-quote-list-refactor',
  'enable-quote-without-sender-id',
  'enable-receive-amount-quote',
  'enable-report-config-canceled-prefunding-recon',
  'enable-report-config-cmf',
  'enable-report-config-consolidatedcustomerrecon',
  'enable-report-config-creditcustomerrecon',
  'enable-report-config-debitcustomerrecon',
  'enable-report-config-fundsmovement',
  'enable-report-config-meta-pathward-recon',
  'enable-report-config-pending-prefunding-recon',
  'enable-report-config-postedtransactions',
  'enable-report-config-prefunding-recon',
  'enable-report-config-pts',
  'enable-report-config-sender-update',
  'enable-rsp-by-corridor',
  'enable-sanctions-hit-logic',
  'enable-screening-recipient-cardholder-name',
  'enable-sender-changed-refactor',
  'enable-sender-dynamic-field-rules',
  'enable-sender-group-kyc',
  'enable-sender-group-limits',
  'enable-sender-id-number-itin',
  'enable-sla-date-available-calculation-improvements',
  'enable-state-corridor-filtering',
  'enable-transfer-receipt-creation',
  'enable-velocity-entity-updates',
  'enable-visa-account-cancel',
  'filter-out-not-applicable-states',
  'generate-corridor-columns-for-customer-recon',
  'get-profile-code-refactor',
  'get-sender-fields-from-all-providers',
  'get_currencies_by_transfer_method_provider',
  'hide-aft-corridor',
  'notes-to-mc',
  'oct-cancel',
  'remove-date-available-buffer-days',
  'require-quote-id-on-transfer',
  'restrict-moneygram-cancelation',
  'return-currencies-by-provider-corridors-only',
  'save-date-available',
  'send-alacer-second-last-name',
  'sender-fields-skip-phone-number',
  'stablecoin-transfer-method',
  'use_transfer_ledger_approach_in_balance_check',
  'visa-a-w-receive-amount',
  'visa-oct-receive-amount',
];

type Bucket =
  | 'off-for-all'
  | 'on-for-all'
  | 'on-for-1-5'
  | 'on-for->5'
  | 'other'
  | 'archived'
  | 'not-found'
  | 'non-boolean';

interface Classification {
  flagKey: string;
  bucket: Bucket;
  detail: string;
  explicitTrueCustomers?: string[];
  fallthroughIsTrue?: boolean;
  ruleCount?: number;
  hasPrerequisite?: boolean;
}

function classify(flag: Flag, envKey: string): Classification {
  const flagKey = flag.key;

  if (flag.archived) {
    return { flagKey, bucket: 'archived', detail: 'flag archived globally' };
  }

  const env: EnvironmentConfig | undefined = flag.environments?.[envKey];
  if (!env) {
    return { flagKey, bucket: 'not-found', detail: `no env config for "${envKey}"` };
  }

  if (flag.kind !== 'boolean') {
    return { flagKey, bucket: 'non-boolean', detail: `kind=${flag.kind}` };
  }

  const trueIdx = flag.variations.findIndex((v) => v.value === true);
  const falseIdx = flag.variations.findIndex((v) => v.value === false);
  if (trueIdx < 0 || falseIdx < 0) {
    return { flagKey, bucket: 'non-boolean', detail: 'missing true or false variation' };
  }

  const hasPrereq = (env.prerequisites?.length ?? 0) > 0;

  if (env.on === false) {
    const off = env.offVariation ?? falseIdx;
    if (off === trueIdx) {
      return { flagKey, bucket: 'on-for-all', detail: 'env off but offVariation=true', hasPrerequisite: hasPrereq };
    }
    return { flagKey, bucket: 'off-for-all', detail: 'env off, serves false', hasPrerequisite: hasPrereq };
  }

  // env.on === true
  const ft = env.fallthrough;
  const ftIsRollout = !!ft.rollout;
  const ftIsTrue = !ftIsRollout && ft.variation === trueIdx;
  const ftIsFalse = !ftIsRollout && ft.variation === falseIdx;

  // Individual targets serving true
  const individualTrue = new Set<string>();
  for (const t of env.targets ?? []) {
    if (t.variation === trueIdx) for (const v of t.values) individualTrue.add(v);
  }
  for (const t of env.contextTargets ?? []) {
    if (t.variation === trueIdx) for (const v of t.values) individualTrue.add(v);
  }

  // Walk rules
  let hasRolloutRule = false;
  let hasUnresolvableTrueRule = false;
  let hasFalseRule = false;
  const ruleEnabled = new Set<string>();
  const ruleCount = (env.rules ?? []).length;

  for (const rule of env.rules ?? []) {
    if (rule.rollout) {
      // Percent rollout from a rule — indeterminate enablement
      hasRolloutRule = true;
      continue;
    }
    if (rule.variation === undefined) continue;
    if (rule.variation === falseIdx) {
      hasFalseRule = true;
      continue;
    }
    if (rule.variation !== trueIdx) {
      // shouldn't happen for boolean flags, but treat as unresolvable
      hasUnresolvableTrueRule = true;
      continue;
    }
    // rule serves true — try to resolve customer list from clauses
    let resolvable = true;
    const matchedCustomers = new Set<string>();
    let firstClause = true;
    for (const clause of rule.clauses) {
      if (clause.negate) {
        resolvable = false;
        break;
      }
      const attr = clause.attribute?.toLowerCase() ?? '';
      const op = clause.op;
      const ck = (clause.contextKind ?? 'user').toLowerCase();

      // Only resolve clauses on customer-like contexts
      if (ck !== 'user' && ck !== 'customer') {
        resolvable = false;
        break;
      }

      const isCustomerKeyAttr =
        attr === 'customerid' || attr === 'key' || attr === 'customername' || attr === 'name';

      if (!isCustomerKeyAttr) {
        resolvable = false;
        break;
      }
      if (op !== 'in') {
        resolvable = false;
        break;
      }
      const values = (clause.values as unknown[]).map((v) => String(v));
      if (firstClause) {
        for (const v of values) matchedCustomers.add(v);
        firstClause = false;
      } else {
        // intersect (rule clauses are ANDed)
        for (const c of [...matchedCustomers]) if (!values.includes(c)) matchedCustomers.delete(c);
      }
    }
    if (!resolvable) {
      hasUnresolvableTrueRule = true;
    } else {
      for (const c of matchedCustomers) ruleEnabled.add(c);
    }
  }

  if (hasPrereq) {
    return {
      flagKey,
      bucket: 'other',
      detail: `has ${env.prerequisites!.length} prerequisite(s) — depends on parent flag`,
      hasPrerequisite: true,
      ruleCount,
      fallthroughIsTrue: ftIsTrue,
    };
  }

  if (ftIsRollout) {
    return { flagKey, bucket: 'other', detail: 'fallthrough is percent rollout', ruleCount };
  }

  if (ftIsTrue) {
    if (hasFalseRule || hasRolloutRule || hasUnresolvableTrueRule) {
      return { flagKey, bucket: 'other', detail: 'default-true with carve-outs or unresolvable rules', ruleCount, fallthroughIsTrue: true };
    }
    return { flagKey, bucket: 'on-for-all', detail: 'fallthrough=true, no carve-outs', ruleCount, fallthroughIsTrue: true };
  }

  if (ftIsFalse) {
    if (hasRolloutRule || hasUnresolvableTrueRule) {
      return { flagKey, bucket: 'other', detail: 'default-false with rollout or unresolvable true-rules', ruleCount, fallthroughIsTrue: false };
    }
    const all = new Set<string>([...individualTrue, ...ruleEnabled]);
    const count = all.size;
    if (count === 0) {
      return { flagKey, bucket: 'off-for-all', detail: 'env on but nothing serves true', ruleCount, fallthroughIsTrue: false };
    }
    if (count <= 5) {
      return { flagKey, bucket: 'on-for-1-5', detail: `${count} customer(s) explicitly enabled`, explicitTrueCustomers: [...all], ruleCount, fallthroughIsTrue: false };
    }
    return { flagKey, bucket: 'on-for->5', detail: `${count} customer(s) explicitly enabled`, explicitTrueCustomers: [...all], ruleCount, fallthroughIsTrue: false };
  }

  return { flagKey, bucket: 'other', detail: 'unknown fallthrough state', ruleCount };
}

(async function main() {
  const client = new LdClient(TOKEN!);
  console.error(`Fetching flags for project=${PROJECT} env=${ENV_KEY}…`);
  const flags = await client.listAllFlags(PROJECT, ENV_KEY, ENV_KEY);
  console.error(`Got ${flags.length} flags total. Filtering to ${FLAG_KEYS.length} target keys.`);

  const byKey = new Map<string, Flag>();
  for (const f of flags) byKey.set(f.key, f);

  const results: Classification[] = [];
  for (const key of FLAG_KEYS) {
    const flag = byKey.get(key);
    if (!flag) {
      results.push({ flagKey: key, bucket: 'not-found', detail: 'flag not found in project' });
      continue;
    }
    results.push(classify(flag, ENV_KEY));
  }

  // Bucket summary
  const buckets: Record<string, number> = {};
  for (const r of results) buckets[r.bucket] = (buckets[r.bucket] ?? 0) + 1;

  // Write JSON + markdown to C:\Code\Plans\ (resolved relative to script file).
  // Output base name is keyed off the LD env so prod/uat/dev runs don't clobber each other.
  const OUT_BASE = `audit-${ENV_KEY}-state`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${OUT_BASE}.json`), JSON.stringify(results, null, 2));
  console.error(`Wrote ${path.join(OUT_DIR, `${OUT_BASE}.json`)}`);

  const order: Bucket[] = ['on-for-all', 'on-for->5', 'on-for-1-5', 'off-for-all', 'other', 'archived', 'non-boolean', 'not-found'];
  const sorted = [...results].sort(
    (a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket) || a.flagKey.localeCompare(b.flagKey),
  );

  const lines: string[] = [];
  lines.push(`# State audit — ${PROJECT} / ${ENV_KEY}`);
  lines.push('');
  lines.push(`Audited ${results.length} flag keys.`);
  lines.push('');
  lines.push('## Bucket counts');
  lines.push('');
  for (const b of order) if (buckets[b]) lines.push(`- **${b}**: ${buckets[b]}`);
  lines.push('');
  lines.push('## Per-flag classification');
  lines.push('');
  lines.push('| flag_key | bucket | detail | enabled customers |');
  lines.push('|---|---|---|---|');
  for (const r of sorted) {
    const cust = r.explicitTrueCustomers ? r.explicitTrueCustomers.join(', ') : '';
    lines.push(`| \`${r.flagKey}\` | ${r.bucket} | ${r.detail} | ${cust} |`);
  }
  fs.writeFileSync(path.join(OUT_DIR, `${OUT_BASE}.md`), lines.join('\n'));
  console.error(`Wrote ${path.join(OUT_DIR, `${OUT_BASE}.md`)}`);

  // Print summary to stdout
  console.log(lines.join('\n'));
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
