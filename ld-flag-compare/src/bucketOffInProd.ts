/**
 * One-shot cross-reference: for every flag classified `off-for-all` in production,
 * look up its UAT and dev classifications and assign one of five inventory sub-buckets.
 *
 * Output: `Plans/off-in-prod-bucketed.md` — sub-buckets with flag bullets, ready to
 * paste into `Plans/feature-flag-inventory.md`.
 *
 * Pre-req: `audit-production-state.json`, `audit-uat-state.json`, and
 * `audit-dev-state.json` already exist in `C:\Code\Plans\` (from `npm run audit`
 * with `AUDIT_ENV=production|uat|dev`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLANS_DIR = process.env.OUT_DIR ?? path.resolve(SCRIPT_DIR, '..', '..', 'Plans');

type Bucket =
  | 'on-for-all'
  | 'on-for->5'
  | 'on-for-1-5'
  | 'off-for-all'
  | 'other'
  | 'archived'
  | 'non-boolean'
  | 'not-found';

type Row = { flagKey: string; bucket: Bucket; detail: string };

function load(name: string): Row[] {
  const file = path.join(PLANS_DIR, name);
  if (!fs.existsSync(file)) {
    const env = name.replace(/^audit-|-state\.json$/g, '');
    console.error(`Missing ${file}\nGenerate it first:\n  AUDIT_ENV=${env} npm run audit`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

const prod = load('audit-production-state.json');
const uat = load('audit-uat-state.json');
const dev = load('audit-dev-state.json');

const uatByKey = new Map(uat.map((r) => [r.flagKey, r]));
const devByKey = new Map(dev.map((r) => [r.flagKey, r]));

// "Off for everyone in production — keep or kill?" excludes one flag that's also
// off-for-all in prod but is well-covered (`enable-dynamic-mobile-wallets` —
// belongs in "Ready to enable"). Mirror the audit doc's group D scope.
const OFF_PROD_EXCLUDED_FROM_KEEP_OR_KILL = new Set<string>(['enable-dynamic-mobile-wallets']);

const offInProd = prod.filter(
  (r) => r.bucket === 'off-for-all' && !OFF_PROD_EXCLUDED_FROM_KEEP_OR_KILL.has(r.flagKey),
);

type SubBucket =
  | 'off-everywhere'
  | 'dev-only'
  | 'uat-partial'
  | 'uat-on-for-all'
  | 'uat-complex';

const subBuckets: Record<SubBucket, { label: string; description: string; flags: string[] }> = {
  'off-everywhere': {
    label: 'Off everywhere — likely abandoned',
    description:
      "Off in dev, UAT, and prod. Strongest candidates for the deletion path unless there's a roadmap reason we're missing.",
    flags: [],
  },
  'dev-only': {
    label: 'Active development (in dev only)',
    description:
      "Currently on or partial in dev, but off in UAT and prod. Engineering is iterating; don't delete yet but no scaling planning needed.",
    flags: [],
  },
  'uat-partial': {
    label: 'On for some customers in UAT — testing in flight',
    description:
      'Partial rollout in UAT (1+ customers targeted). Likely the next batch queued for prod once UAT testing concludes. Confirm scenario coverage before promoting.',
    flags: [],
  },
  'uat-on-for-all': {
    label: 'Fully on in UAT — ready to schedule prod rollout',
    description:
      'Conventionally on-for-all (or stale-on) in UAT. UAT signals readiness; production rollout planning should pick these up next.',
    flags: [],
  },
  'uat-complex': {
    label: 'Complex configuration in UAT — needs LD UI inspection',
    description:
      'Percent rollouts, prerequisite-gated, or rule-driven in UAT. Determine actual UAT exposure before treating these as "tested."',
    flags: [],
  },
};

function classify(uatBucket: Bucket | undefined, devBucket: Bucket | undefined): SubBucket {
  const uatActive =
    uatBucket === 'on-for-all' ||
    uatBucket === 'on-for->5' ||
    uatBucket === 'on-for-1-5' ||
    uatBucket === 'other';

  if (!uatActive) {
    // UAT off-for-all or not-found
    const devActive =
      devBucket === 'on-for-all' ||
      devBucket === 'on-for->5' ||
      devBucket === 'on-for-1-5' ||
      devBucket === 'other';
    return devActive ? 'dev-only' : 'off-everywhere';
  }

  if (uatBucket === 'on-for-1-5' || uatBucket === 'on-for->5') return 'uat-partial';
  if (uatBucket === 'on-for-all') return 'uat-on-for-all';
  if (uatBucket === 'other') return 'uat-complex';

  // Shouldn't reach here given the uatActive check.
  return 'off-everywhere';
}

const details: Array<{ flagKey: string; sub: SubBucket; uat: Bucket | string; dev: Bucket | string }> = [];

for (const row of offInProd) {
  const uatRow = uatByKey.get(row.flagKey);
  const devRow = devByKey.get(row.flagKey);
  const sub = classify(uatRow?.bucket, devRow?.bucket);
  subBuckets[sub].flags.push(row.flagKey);
  details.push({
    flagKey: row.flagKey,
    sub,
    uat: uatRow?.bucket ?? 'MISSING',
    dev: devRow?.bucket ?? 'MISSING',
  });
}

// Sort each sub-bucket alphabetically for deterministic output.
for (const sb of Object.values(subBuckets)) sb.flags.sort();

const order: SubBucket[] = [
  'off-everywhere',
  'dev-only',
  'uat-partial',
  'uat-on-for-all',
  'uat-complex',
];

const out: string[] = [];
out.push(`# Off-in-prod flags bucketed by dev + UAT state`);
out.push('');
out.push(
  `Total: ${offInProd.length} flag${offInProd.length === 1 ? '' : 's'} (off-for-all in prod, excluding the well-covered one in "Ready to enable").`,
);
out.push('');
out.push('## Bucket sizes');
out.push('');
for (const k of order) out.push(`- ${subBuckets[k].label}: **${subBuckets[k].flags.length}**`);
out.push('');
out.push('## Bucket contents');
out.push('');

for (const k of order) {
  const sb = subBuckets[k];
  out.push(`### ${sb.label}`);
  out.push('');
  out.push(sb.description);
  out.push('');
  if (sb.flags.length === 0) {
    out.push('_(none)_');
  } else {
    for (const flag of sb.flags) {
      const det = details.find((d) => d.flagKey === flag)!;
      out.push(`- \`${flag}\`  *(uat: ${det.uat}, dev: ${det.dev})*`);
    }
  }
  out.push('');
}

out.push('## Per-flag detail (alphabetical)');
out.push('');
out.push('| flag_key | sub-bucket | UAT bucket | dev bucket |');
out.push('|---|---|---|---|');
details.sort((a, b) => a.flagKey.localeCompare(b.flagKey));
for (const d of details) {
  out.push(`| \`${d.flagKey}\` | ${subBuckets[d.sub].label} | ${d.uat} | ${d.dev} |`);
}

const outPath = path.join(PLANS_DIR, 'off-in-prod-bucketed.md');
fs.writeFileSync(outPath, out.join('\n'));
console.error(`Wrote ${outPath}`);
console.log(out.join('\n'));
