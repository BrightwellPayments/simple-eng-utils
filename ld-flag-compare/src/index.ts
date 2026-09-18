/**
 * ld-flag-compare — compare how LaunchDarkly flags resolve for two customer/
 * environment pairs.
 *
 *   # same customer, two environments
 *   npm run compare -- --customer "Dash Solutions" --left-env production --right-env uat
 *
 *   # two customers, one environment
 *   npm run compare -- --env production \
 *     --left-customer "MidAtlantic Federal Credit Union" --right-customer "Brightwell LLC"
 *
 * Both are the same operation: compare side A against side B, where a side is an
 * (environment, customer) pair. `--env` / `--customer` set both sides; the
 * `--left-*` / `--right-*` forms override one side.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';
import { LdClient } from './ldApi.ts';
import { resolveCustomer } from './customer.ts';
import { buildRows } from './diff.ts';
import { outputBasename, renderJson, renderMarkdown } from './report.ts';
import type { Flag, Segment, Side } from './types.ts';

dotenv.config();

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = path.resolve(SCRIPT_DIR, '..', '..', 'Plans');

const USAGE = `
Compare LaunchDarkly flag values across two (environment, customer) sides.

  --customer <name>        customer name for BOTH sides
  --env <key>              environment for BOTH sides
  --left-customer <name>   override the left side's customer
  --right-customer <name>  override the right side's customer
  --left-env <key>         override the left side's environment
  --right-env <key>        override the right side's environment
  --left-key <key>         skip auto-resolution, use this context key on the left
  --right-key <key>        skip auto-resolution, use this context key on the right
  --no-resolve-keys        never look up context keys; evaluate on name alone
  --project <key>          LD project key (default: $LD_PROJECT_KEY or ready-remit)
  --out <dir>              output directory (default: $OUT_DIR or ../../Plans)
  --full [left|right|<env>]  also print/write every flag, including identical ones;
                             optionally limit the full list to one side, by "left"/"right"
                             or by that side's environment name (e.g. --full production)
  -h, --help               this text

Environments in the ReadyRemit project: qa, staging, sandbox, uat, dev, production.

Examples
  npm run compare -- --customer "Dash Solutions" --left-env production --right-env uat
  npm run compare -- --env production --left-customer "Cape Cod Five" --right-customer "Brightwell LLC"
`.trim();

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--') && a !== '-h') continue;
    const name = a === '-h' ? 'help' : a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = next;
      i++;
    }
  }
  return args;
}

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

function fail(message: string): never {
  console.error(`\nERROR: ${message}\n`);
  console.error(USAGE);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const token = process.env.LD_API_TOKEN;
  if (!token) fail('LD_API_TOKEN missing — copy .env.example to .env and paste a reader-scope token.');

  const project = str(args, 'project') ?? process.env.LD_PROJECT_KEY ?? 'ready-remit';
  const outDir = str(args, 'out') ?? process.env.OUT_DIR ?? DEFAULT_OUT_DIR;

  const sharedCustomer = str(args, 'customer') ?? process.env.CUSTOMER_NAME;
  const sharedEnv = str(args, 'env');

  const leftName = str(args, 'left-customer') ?? sharedCustomer;
  const rightName = str(args, 'right-customer') ?? sharedCustomer;
  const leftEnv = str(args, 'left-env') ?? sharedEnv ?? process.env.LD_ENV_LEFT;
  const rightEnv = str(args, 'right-env') ?? sharedEnv ?? process.env.LD_ENV_RIGHT;

  if (!leftName || !rightName) {
    fail('customer name required — pass --customer, or --left-customer and --right-customer.');
  }
  if (!leftEnv || !rightEnv) {
    fail('environment required — pass --env, or --left-env and --right-env.');
  }
  if (leftEnv === rightEnv && leftName === rightName) {
    fail(
      `both sides are "${leftName}" in "${leftEnv}" — vary the customer (--left-customer/--right-customer) ` +
        'or the environment (--left-env/--right-env).',
    );
  }

  const resolveKeys = args['no-resolve-keys'] !== true;
  const fullArg = args['full'];
  let full = false;
  let fullSide: 'left' | 'right' | undefined;
  if (fullArg === true) {
    full = true;
  } else if (typeof fullArg === 'string') {
    full = true;
    const v = fullArg.toLowerCase();
    if (v === 'left' || v === 'right') {
      fullSide = v;
    } else if (v === leftEnv.toLowerCase()) {
      fullSide = 'left';
    } else if (v === rightEnv.toLowerCase()) {
      fullSide = 'right';
    } else {
      fail(
        `--full value "${fullArg}" doesn't match "left", "right", or either environment ` +
          `(${leftEnv}, ${rightEnv}).`,
      );
    }
  }
  const client = new LdClient(token);

  console.error(`Resolving customers in ${leftEnv} / ${rightEnv}…`);
  const [leftCustomer, rightCustomer] = await Promise.all([
    resolveCustomer(client, project, leftEnv, leftName, {
      explicitKey: str(args, 'left-key'),
      resolveKeys,
    }),
    resolveCustomer(client, project, rightEnv, rightName, {
      explicitKey: str(args, 'right-key'),
      resolveKeys,
    }),
  ]);

  for (const [label, c] of [
    ['left', leftCustomer],
    ['right', rightCustomer],
  ] as const) {
    for (const note of c.notes) console.error(`  [${label}] ${note}`);
  }

  const left: Side = { label: 'left', env: leftEnv, customer: leftCustomer };
  const right: Side = { label: 'right', env: rightEnv, customer: rightCustomer };

  console.error(`Fetching flags for project=${project}…`);
  const flags: Flag[] = await client.listAllFlags(project, leftEnv, rightEnv);

  // Segments are environment-scoped, so each side needs its own index.
  const [leftSegs, rightSegs] =
    leftEnv === rightEnv
      ? await client.listSegments(project, leftEnv).then((s) => [s, s] as [Segment[], Segment[]])
      : await Promise.all([
          client.listSegments(project, leftEnv),
          client.listSegments(project, rightEnv),
        ]);

  const leftSegIndex = new Map(leftSegs.map((s) => [s.key, s]));
  const rightSegIndex = new Map(rightSegs.map((s) => [s.key, s]));
  const flagsByKey = new Map(flags.map((f) => [f.key, f]));
  console.error(
    `Got ${flags.length} flags, ${leftSegs.length}/${rightSegs.length} segments (left/right).`,
  );

  const rows = buildRows(
    flags,
    { side: left, segIndex: leftSegIndex },
    { side: right, segIndex: rightSegIndex },
    flagsByKey,
  );

  const generatedAt = new Date().toISOString();
  const markdown = renderMarkdown(rows, left, right, project, generatedAt, full, fullSide);
  const json = renderJson(rows, left, right, project, generatedAt, full);

  const base = outputBasename(left, right);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${base}.md`), markdown);
  fs.writeFileSync(path.join(outDir, `${base}.json`), json);
  console.error(`Wrote ${path.join(outDir, base)}.{md,json}`);

  console.log(markdown);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
