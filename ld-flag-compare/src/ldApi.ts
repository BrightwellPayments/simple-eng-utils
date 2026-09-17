import type { Flag, Segment, ContextRecord } from './types.ts';

const BASE = 'https://app.launchdarkly.com';

type FlagListResponse = {
  items: Flag[];
  totalCount?: number;
  _links?: { next?: { href: string } };
};

type SegmentListResponse = {
  items: Segment[];
  _links?: { next?: { href: string } };
};

type ContextSearchResponse = {
  items: ContextRecord[];
  totalCount?: number;
  continuationToken?: string;
};

export class LdClient {
  constructor(private token: string) {}

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = path.startsWith('http') ? path : `${BASE}${path}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: this.token,
          'LD-API-Version': '20240415',
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.status === 429 && attempt === 0) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '2');
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LD API ${res.status} ${res.statusText} for ${url}: ${text.slice(0, 300)}`);
      }
      return (await res.json()) as T;
    }
    throw new Error(`LD API rate-limited twice for ${url}`);
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /**
   * Fetch every flag with its environment config for one or two environments.
   * LD accepts repeated `env` params and returns only those envs' configs, so a
   * cross-env compare costs the same number of calls as a same-env compare.
   */
  async listAllFlags(projectKey: string, envLeft: string, envRight: string): Promise<Flag[]> {
    const envs = envLeft === envRight ? [envLeft] : [envLeft, envRight];
    const envParams = envs.map((e) => `env=${encodeURIComponent(e)}`).join('&');
    const out: Flag[] = [];
    let next: string | undefined =
      `/api/v2/flags/${encodeURIComponent(projectKey)}?${envParams}&summary=0&limit=50`;
    while (next) {
      const page: FlagListResponse = await this.get<FlagListResponse>(next);
      out.push(...(page.items ?? []));
      next = page._links?.next?.href;
    }
    return out;
  }

  async listSegments(projectKey: string, envKey: string): Promise<Segment[]> {
    const out: Segment[] = [];
    let next: string | undefined =
      `/api/v2/segments/${encodeURIComponent(projectKey)}/${encodeURIComponent(envKey)}?limit=50`;
    while (next) {
      const page: SegmentListResponse = await this.get<SegmentListResponse>(next);
      out.push(...(page.items ?? []));
      next = page._links?.next?.href;
    }
    return out;
  }

  /**
   * Search stored context instances in one environment.
   *
   * `filter` uses LD's clause syntax — `field operator value`, comma-separated for
   * AND. Example: `kind equals "customer", name equals "Dash Solutions"`.
   *
   * NOTE: LD only retains contexts an SDK has seen recently (roughly 30 days), so
   * an empty result means "not seen lately", NOT "does not exist".
   */
  async searchContexts(
    projectKey: string,
    envKey: string,
    filter: string,
    limit = 50,
  ): Promise<ContextRecord[]> {
    const path = `/api/v2/projects/${encodeURIComponent(projectKey)}/environments/${encodeURIComponent(
      envKey,
    )}/contexts/search`;
    const out: ContextRecord[] = [];
    let continuationToken: string | undefined;
    // Bounded: a single customer name should never span more than a few pages.
    for (let page = 0; page < 10; page++) {
      const body: Record<string, unknown> = { filter, sort: '-ts', limit };
      if (continuationToken) body.continuationToken = continuationToken;
      const res: ContextSearchResponse = await this.request<ContextSearchResponse>(
        'POST',
        path,
        body,
      );
      const items = res.items ?? [];
      out.push(...items);
      continuationToken = res.continuationToken;
      // LD returns a continuationToken even on the final page, so stop on an empty
      // page or once totalCount is satisfied rather than trusting the token alone.
      if (!continuationToken || items.length === 0) break;
      if (res.totalCount !== undefined && out.length >= res.totalCount) break;
    }
    return out;
  }

  async getProject(projectKey: string): Promise<{ key: string; name: string }> {
    return this.get(`/api/v2/projects/${encodeURIComponent(projectKey)}`);
  }
}
