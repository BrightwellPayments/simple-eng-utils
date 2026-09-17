/**
 * Resolve a customer NAME to the key shapes LaunchDarkly has seen for it in a
 * given environment.
 *
 * Name is the identity that matters — ReadyRemit targeting rules key off `name` /
 * `customerName`, and the name is stable across environments while the customerId
 * is not. Key resolution exists only to sharpen the minority of flags that use
 * individual targeting, so it must never block a run: every failure path warns and
 * returns a name-only customer.
 */

import type { LdClient } from './ldApi.ts';
import type { ContextRecord, ResolvedCustomer } from './types.ts';

/**
 * The same customer appears under several key shapes depending on which SDK
 * reported it. Strip the prefixes to recover the underlying customerId.
 *
 *   bab2cb18-…              server SDKs (NodeJSClient / DotNetClient)
 *   customer-$bab2cb18-…    JS / .NET client SDKs
 *   customer-bab2cb18-…     mobile apps
 */
export function normalizeCustomerKey(key: string): string {
  return key.replace(/^customer-\$/, '').replace(/^customer-/, '');
}

/** Every key shape a given customerId is known to appear under. */
function expandAliases(keys: string[], guid: string): string[] {
  const all = new Set<string>(keys);
  all.add(guid);
  all.add(`customer-${guid}`);
  all.add(`customer-$${guid}`);
  return [...all];
}

function quoteFilterValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function nameOf(c: ContextRecord): string | undefined {
  const n = c.context?.name;
  return typeof n === 'string' ? n : undefined;
}

/**
 * Look the customer up in one environment.
 *
 * `explicitKey` short-circuits the search — use it when the customer is dormant
 * (LD only retains contexts an SDK has seen in roughly the last 30 days) or when
 * the name is ambiguous.
 */
export async function resolveCustomer(
  client: LdClient,
  projectKey: string,
  envKey: string,
  name: string,
  opts: { explicitKey?: string; resolveKeys?: boolean } = {},
): Promise<ResolvedCustomer> {
  const notes: string[] = [];

  if (opts.explicitKey) {
    const guid = normalizeCustomerKey(opts.explicitKey);
    notes.push(`key supplied explicitly (\`${opts.explicitKey}\`)`);
    return { name, keyAliases: expandAliases([opts.explicitKey], guid), guid, notes };
  }

  if (opts.resolveKeys === false) {
    notes.push('key resolution disabled (`--no-resolve-keys`) — name-only evaluation');
    return { name, keyAliases: [], notes };
  }

  let contexts: ContextRecord[];
  try {
    contexts = await client.searchContexts(
      projectKey,
      envKey,
      `kind equals "customer", name equals "${quoteFilterValue(name)}"`,
    );
  } catch (err) {
    notes.push(
      `context search failed (${err instanceof Error ? err.message : String(err)}) — continuing name-only`,
    );
    return { name, keyAliases: [], notes };
  }

  // Exact name match is the happy path. If nothing came back, the name may just be
  // spelled differently — a name-driven tool that silently mistypes a name reports
  // "everything is false" instead of an error, so check before giving up.
  if (contexts.length === 0) {
    const near = await findNearMatch(client, projectKey, envKey, name);
    if (near) {
      notes.push(`name adopted from LD as \`${near.canonicalName}\` (typed: \`${name}\`)`);
      notes.push(...near.resolved.notes);
      return { ...near.resolved, name: near.canonicalName, canonicalName: near.canonicalName, notes };
    }
    notes.push(
      `no customer context named \`${name}\` seen in \`${envKey}\` (LD retains ~30 days) — ` +
        'continuing name-only; pass an explicit key if this customer uses individual targeting',
    );
    return { name, keyAliases: [], notes };
  }

  return fromContexts(name, envKey, contexts, notes);
}

/** Build a ResolvedCustomer from search hits, handling the ambiguous case. */
function fromContexts(
  name: string,
  envKey: string,
  contexts: ContextRecord[],
  notes: string[],
): ResolvedCustomer {
  const keys = contexts.map((c) => c.context.key);
  const byGuid = new Map<string, string[]>();
  for (const k of keys) {
    const guid = normalizeCustomerKey(k);
    byGuid.set(guid, [...(byGuid.get(guid) ?? []), k]);
  }

  if (byGuid.size > 1) {
    const candidates = contexts
      .map((c) => `${c.context.key} (${c.applicationId ?? 'unknown app'}, last seen ${c.lastSeen ?? '?'})`)
      .join('; ');
    notes.push(
      `AMBIGUOUS: \`${name}\` maps to ${byGuid.size} distinct customer ids in \`${envKey}\` — ` +
        `${candidates}. Continuing name-only; pass an explicit key to disambiguate.`,
    );
    return { name, keyAliases: [], notes };
  }

  const [guid, seen] = [...byGuid.entries()][0]!;
  notes.push(`resolved to \`${guid}\` (seen as ${seen.map((s) => `\`${s}\``).join(', ')})`);
  return { name, keyAliases: expandAliases(seen, guid), guid, notes };
}

/**
 * Fuzzy fallback for a name that returned nothing: fetch the customer contexts in
 * the environment and look for one that differs only by case or padding. Anything
 * further off is a genuinely different customer and is left for the human.
 */
async function findNearMatch(
  client: LdClient,
  projectKey: string,
  envKey: string,
  name: string,
): Promise<{ canonicalName: string; resolved: ResolvedCustomer } | undefined> {
  const wanted = name.trim().toLowerCase();
  let all: ContextRecord[];
  try {
    all = await client.searchContexts(projectKey, envKey, 'kind equals "customer"');
  } catch {
    return undefined;
  }
  const hits = all.filter((c) => (nameOf(c) ?? '').trim().toLowerCase() === wanted);
  if (hits.length === 0) return undefined;
  const canonicalName = nameOf(hits[0]!)!;
  return {
    canonicalName,
    resolved: fromContexts(canonicalName, envKey, hits, []),
  };
}

/** Filename-safe slug for report basenames. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
