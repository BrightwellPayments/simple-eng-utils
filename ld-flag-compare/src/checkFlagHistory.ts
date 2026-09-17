import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';

dotenv.config();

const TOKEN = process.env.LD_API_TOKEN;
const PROJECT = process.env.LD_PROJECT_KEY ?? 'ready-remit';
const ENV_KEY = process.env.AUDIT_ENV ?? 'production';
if (!TOKEN) { console.error('LD_API_TOKEN missing'); process.exit(1); }

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.OUT_DIR ?? path.resolve(SCRIPT_DIR, '..', '..', 'Plans');

/** Read this env's audit output, with a message that names the fix. */
function readAuditInput(): string {
  const file = path.join(OUT_DIR, AUDIT_INPUT);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    console.error(
      `Missing ${file}\nRun the audit for this environment first:\n  AUDIT_ENV=${ENV_KEY} npm run audit`,
    );
    process.exit(1);
  }
}

// Mode A (default): 15 plausibly-TA/Jobs flags from LD-only set.
// Mode B (--our-off-for-all): all off-for-all flags from our 84-audit set.
//   Reads the audit output for this env and filters bucket === 'off-for-all'.
//   Run `npm run audit` first — the filename must match what auditProdState.ts writes.
const MODE_OUR = process.argv.includes('--our-off-for-all');
const AUDIT_INPUT = `audit-${ENV_KEY}-state.json`;

const FLAGS: string[] = MODE_OUR
  ? JSON.parse(readAuditInput())
      .filter((r: { bucket: string }) => r.bucket === 'off-for-all')
      .map((r: { flagKey: string }) => r.flagKey)
  : [
      'alacer-files-reg-entity-data',
      'dodd-frank-cancel',
      'enable-b2b-transfers',
      'enable-field-ordering',
      'enable-mastercard-name-character-strip',
      'enable-mastercard-name-transliteration',
      'enable-promo-threshold-pricing-reporting',
      'enable-reg-entity-by-profile',
      'enable-updated-date-on-entities-report',
      'moneygram-default-subdivision-by-country',
      'post-transfers-return-top-level-quote-history-id',
      'quote-by-receive-amount-option',
      'sender-fields-skip-id',
      'sls-include-regulated-entities',
      'validate-transfer-quote-id',
    ];

const OUTPUT_BASENAME = MODE_OUR
  ? 'audit-our-off-for-all-history'
  : 'audit-ld-deprecation-check';
const HEADING = MODE_OUR
  ? "Audit set (our 84): off-for-all flag deprecation-history check"
  : "LD off-for-all deprecation history check (15 plausibly-TA/Jobs flags)";

interface AuditEntry {
  date: number;
  titleVerb?: string;
  shortDescription?: string;
  description?: string;
  comment?: string;
  member?: { firstName?: string; lastName?: string; email?: string };
}

async function ldGet<T>(url: string): Promise<T> {
  const full = url.startsWith('http') ? url : 'https://app.launchdarkly.com' + url;
  const r = await fetch(full, {
    headers: { Authorization: TOKEN!, 'LD-API-Version': '20240415', Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return (await r.json()) as T;
}

interface FlagSummary {
  flagKey: string;
  createdDate?: string;
  isDeprecated: boolean;
  deprecatedDate?: string;
  wasEverTurnedOn: boolean;
  turnOnEvents: { date: string; verb: string; desc: string; who: string }[];
  turnOffEvents: { date: string; verb: string; desc: string; who: string }[];
  fallthroughChanges: { date: string; verb: string; desc: string; who: string }[];
  totalEvents: number;
  verdict:
    | 'deprecated-by-pattern' // was on-for-all, now off — fits the team's deprecation flow
    | 'abandoned' // created, never turned on
    | 'ld-deprecated-tag' // explicitly tagged deprecated in LD UI
    | 'unclear';
}

function relevant(e: AuditEntry, term: string) {
  const blob = `${e.titleVerb ?? ''} ${e.shortDescription ?? ''} ${e.description ?? ''}`.toLowerCase();
  return blob.includes(term.toLowerCase());
}

function fmt(e: AuditEntry) {
  return {
    date: new Date(e.date).toISOString().slice(0, 10),
    verb: e.titleVerb ?? '',
    desc: (e.shortDescription ?? e.description ?? '').slice(0, 140),
    who: [e.member?.firstName, e.member?.lastName].filter(Boolean).join(' ') || e.member?.email || '',
  };
}

async function checkFlag(flagKey: string): Promise<FlagSummary> {
  // Fetch flag itself for deprecated status + creation date
  const flag: any = await ldGet(`/api/v2/flags/${PROJECT}/${encodeURIComponent(flagKey)}?env=${ENV_KEY}`);
  const isDeprecated = !!flag.deprecated;
  const deprecatedDate = flag.deprecatedDate ? new Date(flag.deprecatedDate).toISOString().slice(0, 10) : undefined;
  const createdDate = flag.creationDate ? new Date(flag.creationDate).toISOString().slice(0, 10) : undefined;

  // Fetch audit log scoped to this flag in production (paginated; LD caps limit at 20)
  const items: AuditEntry[] = [];
  let url: string | undefined = `/api/v2/auditlog?spec=proj/${PROJECT}:env/${ENV_KEY}:flag/${encodeURIComponent(flagKey)}&limit=20`;
  while (url) {
    const page: { items?: AuditEntry[]; _links?: { next?: { href: string } } } = await ldGet(url);
    items.push(...(page.items ?? []));
    url = page._links?.next?.href;
    if (items.length >= 200) break; // hard cap to avoid runaway
  }

  const turnOnEvents = items.filter((e) => relevant(e, 'turned on') || relevant(e, 'turn on the flag') || relevant(e, 'turned the flag on')).map(fmt);
  const turnOffEvents = items.filter((e) => relevant(e, 'turned off') || relevant(e, 'turn off the flag') || relevant(e, 'turned the flag off')).map(fmt);
  const fallthroughChanges = items.filter((e) => relevant(e, 'fallthrough')).map(fmt);

  const wasEverTurnedOn = turnOnEvents.length > 0;

  // Verdict
  let verdict: FlagSummary['verdict'];
  if (isDeprecated) verdict = 'ld-deprecated-tag';
  else if (wasEverTurnedOn) verdict = 'deprecated-by-pattern';
  else if (items.length <= 2) verdict = 'abandoned'; // created + maybe deprecated/archived, nothing else
  else verdict = 'unclear';

  return {
    flagKey,
    createdDate,
    isDeprecated,
    deprecatedDate,
    wasEverTurnedOn,
    turnOnEvents,
    turnOffEvents,
    fallthroughChanges,
    totalEvents: items.length,
    verdict,
  };
}

(async function main() {
  const results: FlagSummary[] = [];
  for (const k of FLAGS) {
    try {
      const r = await checkFlag(k);
      results.push(r);
      console.error(`${k}: verdict=${r.verdict}, events=${r.totalEvents}, ever-on=${r.wasEverTurnedOn}`);
    } catch (err) {
      console.error(`${k}: FAILED — ${(err as Error).message}`);
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, OUTPUT_BASENAME + '.json'), JSON.stringify(results, null, 2));

  const lines: string[] = [];
  lines.push('# ' + HEADING);
  lines.push('');
  lines.push(`Checked ${results.length} flag(s) currently \`off-for-all\` in LD prod.`);
  lines.push('');
  lines.push('Deprecation pattern: roll out → flag on-for-all → flip to off-for-all (kill switch) → remove code → delete from LD.');
  lines.push('A flag that was previously on-for-all and is now off-for-all fits this pattern (verdict: `deprecated-by-pattern`).');
  lines.push('');
  lines.push('## Verdict summary');
  lines.push('');
  const byVerdict: Record<string, FlagSummary[]> = {};
  for (const r of results) (byVerdict[r.verdict] ??= []).push(r);
  for (const [v, list] of Object.entries(byVerdict)) lines.push(`- **${v}**: ${list.length}`);
  lines.push('');

  lines.push('## Per-flag history');
  lines.push('');
  lines.push('| flag | verdict | created | LD-deprecated | total events | ever turned on |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of results) {
    lines.push(
      `| \`${r.flagKey}\` | **${r.verdict}** | ${r.createdDate ?? '?'} | ${r.isDeprecated ? `yes (${r.deprecatedDate ?? '?'})` : 'no'} | ${r.totalEvents} | ${r.wasEverTurnedOn ? `yes (${r.turnOnEvents.length} event(s))` : 'no'} |`,
    );
  }
  lines.push('');

  lines.push('## Detail per flag');
  lines.push('');
  for (const r of results) {
    lines.push(`### \`${r.flagKey}\` — ${r.verdict}`);
    lines.push('');
    lines.push(`- Created: ${r.createdDate ?? 'unknown'}`);
    lines.push(`- LD-deprecated tag: ${r.isDeprecated ? `yes (${r.deprecatedDate ?? 'date unknown'})` : 'no'}`);
    lines.push(`- Total audit events in prod env: ${r.totalEvents}`);
    if (r.turnOnEvents.length > 0) {
      lines.push(`- Turn-on events:`);
      for (const e of r.turnOnEvents) lines.push(`  - ${e.date} — ${e.verb} (${e.who}) — ${e.desc}`);
    } else {
      lines.push(`- Turn-on events: none`);
    }
    if (r.turnOffEvents.length > 0) {
      lines.push(`- Turn-off events:`);
      for (const e of r.turnOffEvents) lines.push(`  - ${e.date} — ${e.verb} (${e.who}) — ${e.desc}`);
    }
    if (r.fallthroughChanges.length > 0) {
      lines.push(`- Fallthrough changes:`);
      for (const e of r.fallthroughChanges.slice(0, 5)) lines.push(`  - ${e.date} — ${e.verb} (${e.who}) — ${e.desc}`);
      if (r.fallthroughChanges.length > 5) lines.push(`  - … +${r.fallthroughChanges.length - 5} more`);
    }
    lines.push('');
  }

  fs.writeFileSync(path.join(OUT_DIR, OUTPUT_BASENAME + '.md'), lines.join('\n'));
  console.error(`\nWrote ${path.join(OUT_DIR, OUTPUT_BASENAME + '.md')}`);
})().catch((err) => { console.error('FAILED:', err); process.exit(1); });
