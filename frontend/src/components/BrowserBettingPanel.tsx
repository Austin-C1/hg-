import { Tag } from 'antd'

import type { BrowserBettingSummary } from '../types'

const sessionLabels: Record<BrowserBettingSummary['sessions'][number]['state'], string> = {
  stopped: '已停止',
  starting: '启动中',
  login_required: '需要人工登录',
  ready: '就绪',
  stale: '会话已过期，已阻断',
  blocked: '已阻断',
  error: '会话错误',
}

const acceptanceLabels: Record<NonNullable<BrowserBettingSummary['directions'][number]['acceptanceState']>, string> = {
  pending: '待预览',
  previewing: '预览已固化',
  dispatched: '已提交，等待结果',
  accepted: '已接受',
  rejected: '已拒绝',
  unknown: '结果未知',
}

const blockedReasonLabels: Record<string, string> = {
  'crown-submit-direct-acceptance-missing': 'Submit 缺少直接 accepted 证据',
  'crown-reconciliation-evidence-missing': 'Reconciliation 缺少结果查询证据',
  'crown-capability-version-mismatch': 'Capability drift（能力版本不一致）',
  'crown-capability-evidence-mismatch': 'Capability drift（能力证据不一致）',
  'crown-capability-metadata-mismatch': 'Capability drift（能力元数据不一致）',
  'capability-drift': 'Capability drift（能力证据已漂移）',
}

const nonBlockingEvidenceReasons = new Set([
  'crown-submit-direct-acceptance-missing',
  'crown-reconciliation-evidence-missing',
])

function blockedReasonText(reason: string) {
  return `阻断原因：${blockedReasonLabels[reason] || reason}`
}

export function directionLabel(key: string) {
  const [mode, , market, , side] = key.split('|')
  const modeText = mode === 'prematch' ? '赛前' : mode === 'live' ? '滚球' : mode
  const marketText = market === 'asian_handicap' ? '让球' : market === 'total' ? '大小球' : market
  const sideText = ({ home: '主', away: '客', over: '大', under: '小' } as Record<string, string>)[side] || side
  return `${modeText} · ${marketText} · ${sideText}`
}

export function DirectionSupport({ direction }: { direction: BrowserBettingSummary['directions'][number] }) {
  return <div className="browser-direction-support" aria-label={`${directionLabel(direction.key)}能力`}>
    <Tag color={direction.previewAllowed ? 'green' : 'default'}>
      {direction.previewAllowed ? 'Preview 已验证' : 'Preview 已阻断'}
    </Tag>
    <Tag color={direction.submitAllowed ? 'green' : 'default'}>
      {direction.submitAllowed ? 'Submit 已验证' : 'Submit 证据未固化'}
    </Tag>
    <Tag color={direction.reconciliationAllowed ? 'green' : 'default'}>
      {direction.reconciliationAllowed ? 'Reconcile 已验证' : 'Reconcile 证据未固化'}
    </Tag>
  </div>
}

function timeText(value: string | null) {
  if (!value) return '暂无'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '暂无' : date.toLocaleString('zh-CN', { hour12: false })
}

export default function BrowserBettingPanel({ summary }: { summary: BrowserBettingSummary }) {
  return <section className="browser-betting-panel" aria-labelledby="browser-betting-title">
    <header className="browser-betting-heading">
      <div>
        <p className="eyebrow">BROWSER TRANSPORT</p>
        <h2 id="browser-betting-title">浏览器内 API</h2>
      </div>
      <Tag color="blue">{summary.transportKind}</Tag>
    </header>

    <div className="browser-execution-mode" aria-label="执行模式">
      <span>执行模式</span>
      <strong>页面上下文内 fetch</strong>
      <small>{summary.protocolLibraryVersion || '协议能力版本不可用'}</small>
    </div>

    <div className="browser-betting-layer">
      <div className="browser-layer-heading"><h3>八方向能力</h3><span>{summary.directions.length} / 8</span></div>
      <ul className="browser-direction-grid" aria-label="八方向能力矩阵">
        {summary.directions.map((direction) => <li key={direction.key}>
          <strong>{directionLabel(direction.key)}</strong>
          <DirectionSupport direction={direction} />
          {direction.blockedReason && !nonBlockingEvidenceReasons.has(direction.blockedReason) ? <span className="browser-blocked-reason">
            {blockedReasonText(direction.blockedReason)}
          </span> : null}
          {direction.acceptanceState ? <span className={`acceptance-state state-${direction.acceptanceState}`}>
            {acceptanceLabels[direction.acceptanceState]}
          </span> : null}
        </li>)}
      </ul>
    </div>

    <div className="browser-betting-layer">
      <div className="browser-layer-heading"><h3>账号会话</h3><span>{summary.sessions.length}</span></div>
      {summary.sessions.length ? <ul className="browser-session-list">
        {summary.sessions.map((session) => <li key={session.accountId}>
          <div><strong>{session.accountId}</strong><span>{sessionLabels[session.state]}</span></div>
          <div className="browser-session-facts">
            <span>Generation {session.sessionGeneration}</span>
            <span>心跳 {timeText(session.lastHeartbeatAt)}</span>
            <span>最近 API 成功 {timeText(session.lastApiSuccessAt)}</span>
          </div>
        </li>)}
      </ul> : <p className="browser-empty-state">当前没有浏览器会话</p>}
    </div>

    <div className="browser-betting-layer browser-campaign-layer">
      <div className="browser-layer-heading"><h3>验收 campaign</h3></div>
      {summary.campaign ? <div className={`browser-campaign state-${summary.campaign.state}`}>
        <div><strong>已接受 {summary.campaign.acceptedCount} / {summary.campaign.targetCount}</strong>
          <span>累计金额 {summary.campaign.totalAcceptedAmountMinor} CNY</span></div>
        <div><span>队列 {summary.campaign.queueDepth} · 在途 {summary.campaign.inFlightCount}</span>
          <span>Unknown {summary.campaign.unknownCount}</span></div>
        {summary.campaign.state === 'failed' ? <p>terminal unknown，验收已停止</p>
          : summary.campaign.state === 'completed' ? <p>八方向验收完成</p>
            : <p>验收进行中</p>}
      </div> : <p className="browser-empty-state">当前没有验收 campaign</p>}
    </div>
  </section>
}
