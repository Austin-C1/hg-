export type Mode = 'prematch' | 'live' | 'unknown'
export type AccountStatus = 'enabled' | 'disabled' | 'needs-login' | 'missing-secret'

export interface DataQuality {
  complete: boolean
  reasons: string[]
}

export interface MonitorHealth {
  available: boolean
  reason: string | null
  state: {
    events: { active: number; inactive: number; total: number }
    selections: number
    signals: number
    candidates: number
  }
  deliveries: { pending: number; deadLetter: number; sent: number; total: number }
  lastAuthoritative: {
    scopeKey: string
    batchId: string
    capturedAt: string
    completedAt: string
  } | null
  incompleteData: {
    total: number
    byReason: Record<string, number>
    items?: Array<{
      eventKey: string
      reason: string
      mode: Mode
      league: string
      homeTeam: string
      awayTeam: string
    }>
  }
}

export interface OddsSummary {
  schemaVersion?: number
  readonly: boolean
  source: string
  dataOrigin?: {
    kind: 'monitor-v2' | 'runtime-jsonl' | 'xml-live' | 'dom-fallback' | 'fixture-fallback'
    isRuntime: boolean
    runtime: {
      exists: boolean
      empty: boolean
      lineCount: number
      updatedAt: string | null
    }
    fallback: {
      exists: boolean
      lineCount: number
      updatedAt: string | null
    } | null
  } | null
  dataSource?: {
    kind: string
    label: string
    lastXmlAt: string | null
    xmlResponses: number
    getGameListCount: number
    getGameMoreCount: number
    xmlEvents: number
    normalizedRecords: number
    snapshotWrites: number
    changeWrites: number
    parseErrors: number
    emptyXmlResponses: number
    loginExpiredResponses: number
    lastSnapshotAt: string | null
    eventCount: number
    recordCount: number
    changeCount: number
    oddsIdAvailable: boolean
    oddsIdStatus: 'available' | 'null-not-available'
    bettingExecution: 'disabled-preview-only' | 'not-connected'
  }
  totals: {
    events: number
    leagues: number
    snapshots: number
    changes: number
  }
  lastCapturedAt: string | null
  warnings?: string[]
  monitorHealth?: MonitorHealth
}

export interface OddsSelection {
  selectionKey: string
  side: string | null
  oddsRaw: string | number | null
  odds: number | null
  capturedAt: string | null
}

export interface OddsMarket {
  marketKey: string
  marketType: string | null
  period: string | null
  handicapRaw: string | null
  selections: OddsSelection[]
}

export interface OddsEvent {
  eventKey: string
  league: string
  homeTeam: string
  awayTeam: string
  mode: Mode
  status: string
  recordCount: number
  marketCount: number
  selectionCount: number
  lastCapturedAt: string | null
  startTimeRaw: string | null
  startTimeUtc: string | null
  startTimeBeijing: string | null
  timeQuality: 'high' | 'inferred' | 'invalid' | 'missing'
  timeWarnings: string[]
  markets: OddsMarket[]
  dataQuality?: DataQuality
}

export interface OddsChange {
  type: string
  key: string | null
  capturedAt: string | null
  eventKey: string
  provider: string | null
  mode: Mode | null
  league: string
  homeTeam: string
  awayTeam: string
  marketType: string | null
  period: string | null
  handicapRaw: string | null
  side: string | null
  oldHandicapRaw: string | null
  newHandicapRaw: string | null
  oldOddsRaw: string | number | null
  newOddsRaw: string | number | null
  direction: 'up' | 'down' | 'flat' | 'unknown'
  dataQuality?: DataQuality
}

export interface TrackedMatch {
  eventKey: string
  league: string
  homeTeam: string
  awayTeam: string
  mode: Mode
  sourceStatus: string
  trackingStatus: 'active' | 'inactive'
  updatedAt: string
}

export interface DefaultLeagueRule {
  name: string
  aliases: string[]
  enabled: boolean
  autoTrack: boolean
  modes: Array<'prematch' | 'live'>
}

export interface DefaultLeagueStatus extends DefaultLeagueRule {
  status: 'hit' | 'missing' | 'disabled' | 'mode_disabled'
  hitCount: number
  currentModes: string[]
  matchedLeagues: string[]
}

export interface DefaultLeagueOverview {
  config: {
    version: number
    leagues: DefaultLeagueRule[]
  }
  stats: {
    configuredCount: number
    hitCount: number
    missingCount: number
    disabledCount: number
  }
  items: DefaultLeagueStatus[]
}

export interface LeagueSummary {
  league: string
  prematchEventCount: number
  liveEventCount: number
  totalOddsCount: number
  inDefaultWhitelist: boolean
  defaultAutoTracked: boolean
  tracked: boolean
  trackingSource: 'manual' | 'default' | 'none'
  lastCapturedAt: string | null
  events: OddsEvent[]
}

export type MonitorMode = 'prematch' | 'live'
export type WaterMoveDirection = 'up' | 'down' | 'both'

export interface PrematchMonitorSettings {
  enabled: boolean
  minOdds: number | null
  maxOdds: number | null
  waterMoveThreshold: number
  waterMoveDirection: WaterMoveDirection
  cooldownSeconds: number
  startMinutesBeforeKickoff: number
  stopMinutesBeforeKickoff: number
  remark: string
  lastAlertAt: string | null
  stoppedReason: string
  bettingRuleId: string | null
}

export interface LiveMonitorSettings {
  enabled: boolean
  minOdds: number | null
  maxOdds: number | null
  waterMoveThreshold: number
  waterMoveDirection: WaterMoveDirection
  cooldownSeconds: number
  liveMinuteFrom: number
  liveMinuteTo: number
  includeFirstHalf: boolean
  includeSecondHalf: boolean
  includeHalfTime: boolean
  remark: string
  lastAlertAt: string | null
  stoppedReason: string
  bettingRuleId: string | null
}

export interface MonitorSettingsPayload {
  schemaVersion?: number
  settings: {
    version: number
    prematch: PrematchMonitorSettings
    live: LiveMonitorSettings
  }
  cards: Record<MonitorMode, {
    status: 'running' | 'closed'
    effectiveLeagueCount: number
    trackedEventCount: number
    trackedSelectionCount: number
    lastAlertAt: string | null
    stoppedReason: string
  }>
  monitorHealth?: MonitorHealth
}

export interface TelegramBotSettings {
  enabled: boolean
  botName: string
  botTokenMasked: string
  hasBotToken: boolean
  chatId?: string
  chatIds: string[]
  parseMode: 'HTML' | 'Markdown' | 'plain'
  testMessage: string
}

export interface TelegramSettingsPayload {
  version: number
  oddsAlert: TelegramBotSettings
  betSuccess: TelegramBotSettings
}

export interface MonitorAccount {
  id: string
  label: string
  username: string
  loginUrl: string
  enabled: boolean
  status: AccountStatus
  hasSecret: boolean
  notes: string
  loginStatus: string
  currentMonitorStatus: string
  lastLoginAt: string | null
  lastOnlineCheckAt: string | null
  lastXmlResponseAt: string | null
  lastOddsParsedAt: string | null
  consecutiveFailures: number
  oddsScanIntervalSeconds: number
  autoReloginCount: number
  maxAutoReloginCount: number
  lastLoginResult: LoginResult | null
  lastLoginResultAt: string | null
  lastLoginDiagnosticsPath: string | null
  updatedAt: string
}

export interface LoginResult {
  ok: boolean
  accountId: string
  status: string
  loginMethod: string
  cookieStatus: string
  storageStateStatus: string
  xmlVerified: boolean
  sessionVerified: boolean
  diagnosticPath: string
  debugSnapshot: Record<string, unknown> | null
  startedAt: string
  finishedAt: string
  message: string
}

export interface LoginDiagnostics {
  item: Record<string, unknown> | null
}

export type ManualLoginState = 'idle' | 'opening' | 'awaiting-user' | 'verifying' | 'verified' | 'failed'

export interface ManualLoginStatus {
  challengeId: string
  accountId: string
  status: ManualLoginState
  errorCode: string
  expiresAt: number
}

export interface MonitorRule {
  id: string
  name: string
  enabled: boolean
  leagueFilter: string
  modeFilter: string
  marketFilter: string
  minOddsChange: number
  pollSeconds: number
  alertEnabled: boolean
  updatedAt: string
}

export interface BettingRule {
  id: string
  name: string
  enabled: boolean
  leagueNames: string[]
  targetAmount: string
  currency: string
  amountScale: number
  changedOddsMin: number | null
  changedOddsMax: number | null
  direction: 'up_reverse'
  executionMode: 'preview_only' | 'real_eligible'
  version: number
  /** @deprecated Compatibility-only; new rule execution uses targetAmount. */
  perAccountBetAmount?: number
  /** @deprecated Compatibility-only; not used by new execution. */
  perAccountDailyLimit?: number
  /** @deprecated Compatibility-only; new rule execution uses targetAmount. */
  maxSingleAmount?: number
  /** @deprecated Compatibility-only; not used by new execution. */
  maxEventAmount?: number
  /** @deprecated Compatibility-only; new rule matching uses changedOddsMin. */
  minOdds?: number | null
  /** @deprecated Compatibility-only; new rule matching uses changedOddsMax. */
  maxOdds?: number | null
  /** @deprecated Compatibility-only; direction is fixed to up_reverse. */
  betDirectionMode?: 'auto' | 'follow' | 'reverse'
  notes?: string
  createdAt: string
  updatedAt: string
}

export type AutoBetMode = 'prematch' | 'live'
export interface MonitorAlertSettingCommon {
  mode: AutoBetMode
  enabled: boolean
  asianHandicapEnabled: boolean
  totalEnabled: boolean
  monitorOddsMin: number | null
  monitorOddsMax: number | null
  waterMoveThreshold: number
  cooldownSeconds: number
  remark: string
  migrationReviewRequired: boolean
  migrationReviewReason: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface PrematchMonitorAlertSetting extends MonitorAlertSettingCommon {
  mode: 'prematch'
  startMinutesBeforeKickoff: number
  stopMinutesBeforeKickoff: number
}

export interface LiveMonitorAlertSetting extends MonitorAlertSettingCommon {
  mode: 'live'
  liveMinuteFrom: number
  liveMinuteTo: number
  includeFirstHalf: boolean
  includeHalfTime: boolean
  includeSecondHalf: boolean
}

export type MonitorAlertSetting = PrematchMonitorAlertSetting | LiveMonitorAlertSetting
export type MonitorAlertSettingUpdate = Omit<PrematchMonitorAlertSetting, 'mode' | 'migrationReviewRequired' | 'migrationReviewReason' | 'version' | 'createdAt' | 'updatedAt'> & { expectedVersion: number; acknowledgeMigrationReview: boolean }
  | Omit<LiveMonitorAlertSetting, 'mode' | 'migrationReviewRequired' | 'migrationReviewReason' | 'version' | 'createdAt' | 'updatedAt'> & { expectedVersion: number; acknowledgeMigrationReview: boolean }

export interface MonitorAlertSettingsResponse {
  items: { prematch: PrematchMonitorAlertSetting; live: LiveMonitorAlertSetting }
  summary: { enabledCount: number; enabledModes: AutoBetMode[]; migrationReviewRequiredCount: number }
}

export interface AutoBettingSetting {
  mode: AutoBetMode
  enabled: boolean
  targetOddsMin: string | null
  targetOddsMax: string | null
  targetAmountMinor: number | null
  currency: 'CNY'
  amountScale: 0
  remark: string
  realEligible: boolean
  realEligibilityVersion: number
  realEligibilityUpdatedAt: string | null
  migrationReviewRequired: boolean
  migrationReviewReason: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface AutoBettingSettingUpdate {
  expectedVersion: number
  enabled: boolean
  targetOddsMin: string
  targetOddsMax: string
  targetAmountMinor: number
  currency: 'CNY'
  amountScale: 0
  remark: string
}
export interface AutoBettingSettingsResponse {
  items: { prematch: AutoBettingSetting; live: AutoBettingSetting }
  summary: { enabledCount: number; enabledModes: AutoBetMode[]; realEligibleCount: number; migrationReviewRequiredCount: number }
}

export type AutoBettingRuleCard = {
  cardId: string
  name: string
  enabled: boolean
  leagueNames: string[]
  targetOddsMin: string | null
  targetOddsMax: string | null
  targetAmountMinor: number | null
  currency: 'CNY'
  amountScale: 0
  remark: string
  realEligible: boolean
  realEligibilityVersion: number
  migrationReviewRequired: boolean
  migrationReviewReason: string
  version: number
  createdAt: string
  updatedAt: string
  recentSignal?: string | null
  recentBatch?: string | null
  recentResult?: string | null
}

export type TodayBettingLeague = {
  leagueName: string
  source: 'default' | 'manual' | 'both' | 'stale'
  todayMatchCount: number
  ownerCardId: string | null
  ownerCardName: string | null
  selectable: boolean
  availableToday: boolean
}

export type RuleCardMutation = {
  name: string
  enabled: boolean
  leagueNames: string[]
  targetOddsMin: string
  targetOddsMax: string
  targetAmountMinor: number
  remark: string
}

export type RuleCardUpdate = RuleCardMutation & { expectedVersion: number }

export type RealBettingRuntimeState = 'off' | 'armed_waiting' | 'running' | 'blocked' | 'stopping'

export interface RealBettingStatus {
  requested: boolean
  state: RealBettingRuntimeState
  reasonCode: string
  updatedAt: string
  preflight: Array<{ code: string; ready: boolean }>
  blockingReasons: string[]
}

export interface OperationsSummary {
  serverTime: string
  freshness: { lastOddsAt: string | null; ageMs: number | null; state: 'fresh' | 'stale' | 'missing'; staleAfterMs: number }
  watcher: { active: boolean; unique: boolean; activeCount: number; heartbeatAt: string | null; expiresAt: string | null; fencingToken: number }
  readiness: Record<'monitor' | 'rules' | 'accounts' | 'realBetting', {
    state: 'ready' | 'action-required' | 'blocked' | 'off'; ready: boolean; reason: string
  }>
  runtime: { requested: boolean; state: RealBettingRuntimeState; reasonCode: string; updatedAt: string }
  monitorAlerts: Record<AutoBetMode, { enabled: boolean; reviewRequired: boolean; markets: { asianHandicap: boolean; total: boolean } }>
  ruleCards?: { total: number; enabled: number; reviewRequired: number; ownedLeagues: number }
  rules: { total: number; monitorEnabled: number; realEnabled: number; hitCount: number; recentHitCount: number }
  accounts: { total: number; enabled: number; pausePending: number; paused: number; checking: number; locked: number; unknown: number }
  batches: {
    recentLimit: number; recentCount: number; active: number; completed: number; partial: number
    failed: number; cancelled: number; acceptedAmountMinor: number; unknownAmountMinor: number
  }
  reconciliation: { due: number; manualReview: number; deadLetter: number; open: number }
  notifications: { backlog: number; pending: number; delivering: number; deadLetter: number }
  recentBatches: Array<{
    batchId: string; status: string; acceptedAmountMinor: number; unknownAmountMinor: number; createdAt: string
  }>
}

export interface RuntimeCleanupPreview {
  bytes: number
  files: number
  records: number
  categories: Record<string, number>
  databaseRows?: Record<string, number>
  restartedWatcher?: boolean
  monitorStartReason?: string
  accountsPaused?: number
  cleanedAt?: string
}

export interface BettingAccount {
  id: string
  label: string
  username: string
  websiteUrl: string
  archived: boolean
  betOrder: number
  status: AccountStatus
  allocationStatus: 'enabled' | 'pause_pending' | 'paused' | 'checking'
  perBetLimit: string
  currency: string
  balance: string | null
  balanceUpdatedAt: string | null
  executionStatus: string
  accessStatus: 'unchecked' | 'available' | 'failed'
  accessCheckedAt: string | null
  accessErrorCode: string
  reportedBalance: string | null
  reportedCurrency: string
  reportedBalanceUpdatedAt: string | null
  acceptedTodayCount: number
  acceptedTodayAmount: string
  hasSecret: boolean
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface BetBatch {
  batchId: string
  signalId: string
  ruleId: string
  eventKey: string
  lockedSelectionIdentity: string
  ruleVersion: number
  sourceLeague: string
  sourceOdds: string
  currency: string
  amountScale: number
  targetAmount: string
  reservedAmount: string
  acceptedAmount: string
  unknownAmount: string
  unfilledAmount: string
  status: string
  finishReason: string
  createdAt: string
  finishedAt: string
}

export interface BetChildOrder {
  childOrderId: string
  batchId: string
  accountId: string
  attempt: number
  currency: string
  amountScale: number
  requestedAmount: string
  previewMinStake: string
  previewMaxStake: string
  previewBalance: string | null
  previewStakeStep: string
  previewOdds: string
  providerReference: string | null
  submitAttemptId: string
  status: string
  errorCode: string
  errorMessage: string
  createdAt: string
  submitPreparedAt: string
  submitDispatchedAt: string
  submittedAt: string
  resolvedAt: string
}

export interface BettingHistory {
  id: string
  accountId: string | null
  bettingAccountId: string | null
  leagueName: string
  teams: string
  market: string
  handicap?: string
  betTime: string
  eventKey: string | null
  ruleId: string | null
  status?: string
  amount: number
  oddsRaw?: string
  details?: Record<string, unknown>
  createdAt: string
}

export interface BootstrapPayload {
  appContractVersion?: string
  schemaVersion?: string
  csrfToken?: string
  dashboardAccessMode?: 'local-trust' | 'password-session' | 'readonly'
  trackedMatches: TrackedMatch[]
  monitorAccounts: MonitorAccount[]
  monitorRules: MonitorRule[]
  bettingRules: BettingRule[]
  bettingAccounts: BettingAccount[]
  bettingHistory: BettingHistory[]
  defaultLeagues?: DefaultLeagueOverview
  monitorSettings?: MonitorSettingsPayload['settings']
  oddsSummary: OddsSummary
  events: { items: OddsEvent[]; warnings?: string[] }
  changes: { items: unknown[]; warnings?: string[] }
}
