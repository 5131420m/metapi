import type { ButtonHTMLAttributes, ReactNode, RefCallback } from 'react';
import type { BrandInfo } from '../../components/BrandIcon.js';
import type { RouteDecision, RouteDecisionCandidate, RouteMode } from '../../../shared/tokenRouteContract.js';
export type { RouteDecision, RouteDecisionCandidate, RouteMode } from '../../../shared/tokenRouteContract.js';

export type RouteSortBy = 'modelPattern' | 'channelCount';
export type RouteSortDir = 'asc' | 'desc';
export type GroupFilter = null | '__all__' | number;
export type RouteRoutingStrategy = 'weighted' | 'round_robin' | 'stable_first';
export type OAuthRouteUnitStrategy = 'round_robin' | 'stick_until_unavailable';
export type RouteRowKind = 'persisted' | 'zero_channel';
export type RouteChannelDraft = {
  accountId: number;
  tokenId: number;
  sourceModel: string;
};

export type RouteChannelRouteUnitMember = {
  accountId: number;
  username: string | null;
  siteName: string | null;
};

export type RouteChannelRouteUnit = {
  id: number | string;
  name: string | null;
  strategy: OAuthRouteUnitStrategy;
  memberCount: number;
  members?: RouteChannelRouteUnitMember[];
};

export type RouteChannelQuality = {
  firstByteEmaMs: number | null;
  firstByteSampleCount: number;
  tpsEma: number | null;
  tpsSampleCount: number;
  recentSuccessCount: number | null;
  recentFailureCount: number | null;
  recentSuccessRate: number | null;
  recentSampleCount: number;
  lastUpdatedAtMs: number | null;
};

// The verdict, sample and question shapes are shared with the server: a new verdict value must
// not be able to compile on one side and fall through the other.
import type {
  CandyProbeExpectation,
  CandyProbeQuestionInfo,
  CandyProbeSampleResult,
  CandyProbeTrigger,
  CandyProbeVerdict,
} from '../../../shared/candyProbe.js';

export type {
  CandyProbeExpectation,
  CandyProbeQuestionInfo,
  CandyProbeSampleResult,
  CandyProbeTrigger,
  CandyProbeVerdict,
};

/**
 * Display-only degrade-check verdict. `fresh` is false once the verdict is older than the
 * freshness TTL; the list payload omits `samples` (fetched on demand for the detail panel).
 *
 * One question, one answer: `score` is 1 or 0 and `total` is always 1. `validSampleCount`
 * is 1 when the answer was readable, 0 when the run could not be scored.
 */
export type CandyProbeSnapshot = {
  channelId: number;
  routeId: number | null;
  model: string;
  fingerprint: string;
  verdict: CandyProbeVerdict;
  score: number;
  total: number;
  endpoint: string | null;
  actualModel: string | null;
  latencyMs: number | null;
  checkedAt: string;
  reason: string | null;
  question: CandyProbeQuestionInfo;
  /** 1 when the answer was readable, 0 when it was not. */
  validSampleCount: number;
  /** What a wrong answer may mean for THIS model; guards the "降智" wording. */
  expectation: CandyProbeExpectation;
  /** What started the run; missing on payloads older than the schedule feature (manual runs). */
  trigger?: CandyProbeTrigger;
  fresh: boolean;
  expiresAt: string;
};

export type CandyProbeResult = Omit<CandyProbeSnapshot, 'fresh' | 'expiresAt'> & {
  samples: CandyProbeSampleResult[];
};

// Model fingerprint (identity) probe: the shapes come straight from the shared contract.
import type {
  IdentityProbeCandidate,
  IdentityProbeResult,
  IdentityProbeSampleSummary,
  IdentityProbeSnapshot,
  IdentityProbeVerdict,
} from '../../../shared/modelIdentityProbe.js';

export type {
  IdentityProbeCandidate,
  IdentityProbeResult,
  IdentityProbeSampleSummary,
  IdentityProbeSnapshot,
  IdentityProbeVerdict,
};

export type RouteChannel = {
  id: number;
  routeId?: number;
  accountId: number;
  tokenId: number | null;
  sourceModel?: string | null;
  priority: number;
  weight: number;
  enabled: boolean;
  manualOverride: boolean;
  successCount: number;
  failCount: number;
  cooldownUntil?: string | null;
  /** Display-only recent quality measured on this channel; null before first traffic. */
  quality?: RouteChannelQuality | null;
  /** Display-only candy-question verdict; null before the first manual probe. */
  candyProbe?: CandyProbeSnapshot | null;
  /** Display-only model fingerprint verdict; null before the first run. */
  identityProbe?: IdentityProbeSnapshot | null;
  /**
   * Whether a probe could succeed at all (false for a non-conversation model). Covers both
   * the candy probe and the fingerprint probe, which share the rule.
   *
   * Computed by the server with the same rule the probe enforces, so the UI never has to
   * duplicate model-family knowledge — and never offers a button that can only come back
   * rejected.
   */
  candyProbeApplicable?: boolean;
  account?: {
    username: string | null;
    accessToken?: string | null;
    extraConfig?: string | null;
    credentialMode?: string | null;
  };
  site?: {
    id: number;
    name: string | null;
    platform: string | null;
  };
  token?: {
    id: number;
    name: string;
    accountId: number;
    enabled: boolean;
    isDefault: boolean;
  } | null;
  oauthRouteUnitId?: number | null;
  routeUnit?: RouteChannelRouteUnit | null;
};

export type RouteRow = {
  id: number;
  modelPattern: string;
  displayName?: string | null;
  displayIcon?: string | null;
  routeMode?: RouteMode | null;
  sourceRouteIds?: number[];
  modelMapping?: string | null;
  routingStrategy?: RouteRoutingStrategy | null;
  decisionSnapshot?: RouteDecision | null;
  decisionRefreshedAt?: string | null;
  enabled: boolean;
  channels: RouteChannel[];
};

export type RouteSummaryRow = {
  id: number;
  modelPattern: string;
  displayName: string | null;
  displayIcon: string | null;
  routeMode?: RouteMode | null;
  sourceRouteIds?: number[];
  modelMapping: string | null;
  routingStrategy?: RouteRoutingStrategy | null;
  enabled: boolean;
  channelCount: number;
  enabledChannelCount: number;
  siteNames: string[];
  decisionSnapshot: RouteDecision | null;
  decisionRefreshedAt: string | null;
  kind?: RouteRowKind;
  readOnly?: boolean;
  isVirtual?: boolean;
};

export type ChannelDecisionState = {
  probability: number;
  showBar: boolean;
  reasonText: string;
  reasonColor: string;
};

export type RouteTokenOption = {
  id: number;
  name: string;
  isDefault: boolean;
  sourceModel?: string;
};

export type RouteIconOption = {
  value: string;
  label: string;
  description?: string;
  iconNode?: ReactNode;
  iconUrl?: string;
  iconText?: string;
};

export type MissingTokenRouteSiteActionItem = {
  key: string;
  siteName: string;
  accountId: number;
  accountLabel: string;
};

export type MissingTokenGroupRouteSiteActionItem = {
  key: string;
  siteName: string;
  accountId: number;
  accountLabel: string;
  missingGroups: string[];
  requiredGroups: string[];
  availableGroups: string[];
  groupCoverageUncertain?: boolean;
};

export type SortableChannelRowProps = {
  channel: RouteChannel;
  displayPriority?: number;
  showPriorityBadge?: boolean;
  dragging?: boolean;
  dragHandleProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  dragHandleRef?: RefCallback<HTMLButtonElement>;
  decisionCandidate?: RouteDecisionCandidate;
  isExactRoute: boolean;
  loadingDecision: boolean;
  isSavingPriority: boolean;
  readOnly?: boolean;
  channelManagementDisabled?: boolean;
  dragInProgress?: boolean;
  mobile?: boolean;
  tokenOptions: RouteTokenOption[];
  activeTokenId: number;
  isUpdatingToken: boolean;
  onTokenDraftChange: (channelId: number, tokenId: number) => void;
  onSaveToken: () => void;
  onDeleteChannel: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onSiteBlockModel?: () => void;
  clearingCooldown?: boolean;
  onClearCooldown?: () => void;
  /** A candy-question probe is currently running for this channel. */
  candyProbeTesting?: boolean;
  onRunCandyProbe?: () => void;
  onOpenCandyProbeDetail?: () => void;
  /** A model fingerprint probe is currently running for this channel. */
  identityProbeTesting?: boolean;
  onRunIdentityProbe?: () => void;
  onOpenIdentityProbeDetail?: () => void;
};

export type GroupRouteItem = {
  id: number;
  title: string;
  icon: { kind: 'auto' } | { kind: 'none' } | { kind: 'text'; value: string } | { kind: 'brand'; value: string };
  brand: BrandInfo | null;
  modelPattern: string;
  channelCount: number;
  sourceRouteCount: number;
};

export type PriorityRailSection = {
  priority: number;
  channelCount: number;
  channelIds: number[];
};

export type PriorityRailDragTarget =
  | {
    kind: 'existing_layer';
    priority: number;
    highlighted: boolean;
  }
  | {
    kind: 'new_layer';
    priority: number;
    highlighted: boolean;
  };
