export type Variation = {
  _id?: string;
  value: unknown;
  name?: string;
  description?: string;
};

export type Clause = {
  attribute: string;
  contextKind?: string;
  op: string;
  values: unknown[];
  negate?: boolean;
};

export type Rollout = {
  variations: Array<{ variation: number; weight: number }>;
  bucketBy?: string;
  contextKind?: string;
};

export type VariationOrRollout = {
  variation?: number;
  rollout?: Rollout;
};

export type Rule = VariationOrRollout & {
  _id?: string;
  description?: string;
  clauses: Clause[];
};

export type Target = {
  variation: number;
  values: string[];
  contextKind?: string;
};

export type Prerequisite = {
  key: string;
  variation: number;
};

export type EnvironmentConfig = {
  on: boolean;
  archived?: boolean;
  salt?: string;
  sel?: string;
  lastModified?: number;
  version?: number;
  targets?: Target[];
  contextTargets?: Target[];
  rules?: Rule[];
  fallthrough: VariationOrRollout;
  offVariation?: number;
  prerequisites?: Prerequisite[];
  trackEvents?: boolean;
  trackEventsFallthrough?: boolean;
};

export type Flag = {
  key: string;
  name: string;
  description?: string;
  kind: 'boolean' | 'multivariate' | string;
  variations: Variation[];
  environments: Record<string, EnvironmentConfig>;
  archived?: boolean;
};

export type SegmentRule = {
  _id?: string;
  clauses: Clause[];
  weight?: number;
  bucketBy?: string;
  rolloutContextKind?: string;
};

export type Segment = {
  key: string;
  name?: string;
  included?: string[];
  excluded?: string[];
  includedContexts?: Array<{ contextKind: string; values: string[] }>;
  excludedContexts?: Array<{ contextKind: string; values: string[] }>;
  rules?: SegmentRule[];
  unbounded?: boolean;
};

export type SegmentIndex = Map<string, Segment>;

/** One stored context instance as returned by the contexts search API. */
export type ContextRecord = {
  lastSeen?: string;
  applicationId?: string;
  context: {
    kind: string;
    key: string;
    name?: string;
    [attribute: string]: unknown;
  };
  associatedContexts?: number;
};

/**
 * A customer's identity in ONE environment.
 *
 * `name` is the identity that matters — targeting rules key off `name` /
 * `customerName`. `keyAliases` is a best-effort extra: the same customer shows up
 * under several key shapes depending on which SDK reported it (bare GUID from the
 * server SDKs, `customer-$<guid>` from the JS/.NET clients, `customer-<guid>` from
 * mobile), and individual targets are written against one specific shape. Resolving
 * them turns a handful of otherwise-indeterminate flags into real values. An empty
 * alias set is fine — evaluation degrades to name-only.
 */
export type ResolvedCustomer = {
  name: string;
  /** Canonical name as stored in LD, when it differed from the typed input. */
  canonicalName?: string;
  keyAliases: string[];
  /** The underlying GUID, when all aliases agreed on one. */
  guid?: string;
  /** Human-readable notes about how resolution went — surfaced in the report. */
  notes: string[];
};

/** One side of a comparison: an environment plus the customer to evaluate in it. */
export type Side = {
  label: string;
  env: string;
  customer: ResolvedCustomer;
};

/** The evaluation context handed to the rule walker. */
export type EvalContext = {
  kind: string;
  name: string;
  keyAliases: string[];
};

export type EvalReason =
  // Determinate outcomes
  | { kind: 'archived' }
  | { kind: 'off' }
  | { kind: 'prerequisite_failed'; prerequisiteKey: string }
  | { kind: 'target'; matchedAlias: string }
  | { kind: 'rule'; ruleIndex: number; ruleDescription?: string }
  | { kind: 'fallthrough' }
  // Indeterminate outcomes — the tool refuses to guess
  | { kind: 'env_missing'; env: string }
  | { kind: 'rollout_indeterminate'; from: 'rule' | 'fallthrough'; ruleIndex?: number }
  | { kind: 'segment_indeterminate'; segmentKey: string; ruleIndex: number }
  | { kind: 'rule_indeterminate'; ruleIndex: number; detail: string }
  | { kind: 'key_unresolved'; detail: string }
  | { kind: 'prerequisite_indeterminate'; prerequisiteKey: string; detail: string }
  | { kind: 'prerequisite_missing'; prerequisiteKey: string }
  | { kind: 'depth_exceeded' }
  | { kind: 'error'; message: string };

export type EvalResult =
  | { determinate: true; value: unknown; variationIndex: number; reason: EvalReason }
  | { determinate: false; reason: EvalReason };
