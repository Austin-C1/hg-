import { Alert, Button, Popconfirm, Spin, Tag, message } from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'

import { api } from '../services/api'
import type { OperationsSummary, RuntimeCleanupPreview } from '../types'
import BrowserBettingPanel from '../components/BrowserBettingPanel'

const runtimeLabels: Record<string, string> = {
  off: '已关闭', armed_waiting: '等待安全预检', running: '运行中', blocked: '已阻断', stopping: '停止中',
}

const batchLabels: Record<string, string> = {
  queued: '排队中', allocating: '分配中', waiting_capacity: '等待容量', submitting: '提交中',
  waiting_result: '等待确认', completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消',
}

const reasonLabels: Record<string, string> = {
  'monitor-account-not-configured': '监控账号未启用或缺少凭据',
  'watcher-stopped': '监控进程未运行',
  'odds-stale': '赔率数据已经过期',
  'odds-missing': '尚未收到实时赔率',
  'monitor-rules-disabled': '没有开启监控的策略规则',
  'real-rules-disabled': '没有允许真实投注的策略规则',
  'monitor-alerts-disabled': '没有开启监控报警',
  'auto-betting-disabled': '没有可执行的投注规则卡片',
  'settings-review-required': '投注规则卡片需要复核',
  'rule-cards-not-ready': '投注规则卡片配置不完整',
  'betting-accounts-paused': '所有投注账号均已暂停',
  'global-real-betting-off': '全局真实投注尚未开启',
  'real-betting-blocked': '真实投注安全预检未通过',
  'safety-preflight-pending': '正在等待安全预检',
  'capability-evidence-not-exact': 'Crown 真实投注协议证据不足，已安全阻断',
}

function timeText(value: string | null) {
  if (!value) return '暂无'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '暂无' : date.toLocaleString('zh-CN', { hour12: false })
}

function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function cleanupErrorText(error: unknown, action: 'preview' | 'run') {
  const code = error instanceof Error ? error.message : ''
  const messages: Record<string, string> = {
    'watcher-active-unmanaged': '监控由其他程序启动。请先运行“停止程序”，再从运行控制台启动监控后重试。',
    'runtime-cleanup-watcher-unmanaged': '监控由其他程序启动。请先运行“停止程序”，再从运行控制台启动监控后重试。',
    'watcher-stop-unsafe': '监控进程未能安全停止。请运行“停止程序”，确认 Watcher 已停止后重试。',
    'runtime-cleanup-watcher-stop-unsafe': '监控进程未能安全停止。请运行“停止程序”，确认 Watcher 已停止后重试。',
    'betting-worker-active': '投注 Worker 仍在运行。请先关闭真实投注并停止 Worker 后重试。',
    'runtime-cleanup-betting-stop-unsafe': '投注 Worker 未能安全停止。真实投注保持关闭，请重启程序后重试。',
    'browser-profile-active': '登录浏览器仍在使用中。请先关闭登录窗口并结束登录操作后重试。',
    'watcher-restart-unhealthy': '运行数据已重置，但监控未恢复。请点击“启动监控”，确认 Watcher 在线后再开始测试。',
    'runtime-cleanup-watcher-restart-unhealthy': '运行数据已重置，但监控未恢复。请点击“启动监控”，确认 Watcher 在线后再开始测试。',
    'runtime-cleanup-files-busy': '缓存文件仍被旧程序占用。请先运行“停止程序”，再重新启动后重试。',
    'runtime-cleanup-partial': '清理过程中发生错误，部分数据可能已经删除。请刷新预览并检查运行控制台。',
  }
  if (messages[code]) return messages[code]
  return action === 'preview'
    ? '无法读取重置预览，请刷新页面后重试。'
    : '重置未完整确认；部分文件或记录可能已清理，请刷新状态后再重试。'
}

function readinessText(item: OperationsSummary['readiness'][keyof OperationsSummary['readiness']] | undefined) {
  if (!item) return '正在读取状态'
  if (item.ready) return '已就绪'
  return reasonLabels[item.reason] || item.reason || '需要检查'
}

const emptyRuleCards = { total: 0, enabled: 0, reviewRequired: 0, ownedLeagues: 0 } as const

function safeRuleCards(value: OperationsSummary['ruleCards']) {
  if (!value) return null
  for (const field of ['total', 'enabled', 'reviewRequired', 'ownedLeagues'] as const) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) return null
  }
  return value
}

export default function OperationsConsole() {
  const [data, setData] = useState<OperationsSummary | null>(null)
  const [offline, setOffline] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<'monitor-start' | 'monitor-stop' | 'real-start' | 'real-stop' | ''>('')
  const [receivedAt, setReceivedAt] = useState(0)
  const [cleanup, setCleanup] = useState<RuntimeCleanupPreview | null>(null)
  const [cleanupPending, setCleanupPending] = useState(false)
  const [cleanupError, setCleanupError] = useState('')
  const [clock, setClock] = useState(() => Date.now())
  const refreshRef = useRef<(force?: boolean) => Promise<void>>(async () => undefined)

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    void api.getRuntimeCleanupPreview().then((response) => {
      setCleanup(response.item)
      setCleanupError('')
    }).catch((error: unknown) => setCleanupError(cleanupErrorText(error, 'preview')))
  }, [])

  useEffect(() => {
    let timer = 0
    let controller: AbortController | null = null
    let inFlight: Promise<void> | null = null
    let mounted = true
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => { void load() }, document.visibilityState === 'hidden' ? 30_000 : 5_000)
    }
    const load = (force = false): Promise<void> => {
      if (inFlight && !force) return inFlight
      if (force) controller?.abort()
      controller = new AbortController()
      const ownController = controller
      const request = api.getOperationsSummary(ownController.signal).then((response) => {
        if (!mounted || ownController.signal.aborted) return
        setData(response.item)
        setReceivedAt(Date.now())
        setClock(Date.now())
        setOffline(false)
      }).catch((error: unknown) => {
        if (!mounted || ownController.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return
        setOffline(true)
      }).finally(() => {
        if (inFlight !== request) return
        inFlight = null
        if (mounted) { setLoading(false); schedule() }
      })
      inFlight = request
      return request
    }
    const visibilityChanged = () => {
      window.clearTimeout(timer)
      if (document.visibilityState === 'visible') void load(true)
      else if (!inFlight) schedule()
    }
    refreshRef.current = load
    document.addEventListener('visibilitychange', visibilityChanged)
    void load()
    return () => {
      mounted = false
      window.clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [])

  const stale = useMemo(() => {
    if (!data || data.freshness.state !== 'fresh' || data.freshness.ageMs === null) return true
    return data.freshness.ageMs + Math.max(0, clock - receivedAt) > data.freshness.staleAfterMs
  }, [clock, data, receivedAt])
  const browserCampaign = data?.browserBetting?.campaign
  const browserCampaignUnknownCount = browserCampaign?.unknownCount ?? 0
  const hasBrowserCampaignRisk = Boolean(browserCampaign
    && (browserCampaign.state === 'failed' || browserCampaignUnknownCount > 0))
  const hasBlockingRisk = Boolean(data && (
    data.batches.unknownAmountMinor > 0 || data.accounts.unknown > 0 || data.reconciliation.open > 0
    || hasBrowserCampaignRisk
  ))
  const hasRisk = Boolean(hasBlockingRisk || (data && data.notifications.backlog > 0))
  const verifiedRuleCards = safeRuleCards(data?.ruleCards)
  const ruleCards = verifiedRuleCards || emptyRuleCards
  const startSafe = Boolean(data && !offline && !stale && !hasBlockingRisk
    && verifiedRuleCards && data.readiness.monitor.ready && data.readiness.rules.ready && data.readiness.accounts.ready)
  const realRequested = Boolean(data?.runtime.requested || ['running', 'armed_waiting', 'stopping'].includes(data?.runtime.state || ''))
  const watcherProcess = data?.watcher.process

  async function monitorAction(action: 'start' | 'stop') {
    if (pending) return
    setPending(action === 'start' ? 'monitor-start' : 'monitor-stop')
    try {
      await api.monitorAccountAction(action)
      await refreshRef.current(true)
      message.success(action === 'start' ? '监控启动请求已提交' : '监控已停止')
    } catch {
      message.error(action === 'start' ? '监控启动失败' : '监控停止失败')
    } finally {
      setPending('')
    }
  }

  async function runtimeAction(action: 'start' | 'stop') {
    if (pending || (action === 'start' && !startSafe)) return
    setPending(action === 'start' ? 'real-start' : 'real-stop')
    try {
      const response = action === 'start' ? await api.startRealBetting() : await api.stopRealBetting()
      setData((current) => current ? { ...current, runtime: response.item } : current)
      await refreshRef.current(true)
    } catch {
      message.error(action === 'start' ? '开启请求失败' : '停止请求失败')
    } finally {
      setPending('')
    }
  }

  async function cleanupRuntimeData() {
    if (cleanupPending) return
    setCleanupPending(true)
    setCleanupError('')
    try {
      const response = await api.runRuntimeCleanup()
      setCleanup({ ...response.item, bytes: 0, files: 0, records: 0, categories: {} })
      message.success(response.item.restartedWatcher ? '每日数据已重置，监控已自动启动' : '每日运行数据已完全重置')
      await refreshRef.current(true)
    } catch (error: unknown) {
      const detail = cleanupErrorText(error, 'run')
      setCleanupError(detail)
      message.error(detail)
    } finally {
      setCleanupPending(false)
    }
  }

  const headline = offline ? '控制台连接中断' : data?.readiness.monitor.ready ? '监控已就绪，等待安全开工' : '需要完成开工检查'
  const readinessSteps = data ? [
    { key: 'monitor', title: '赔率监控', detail: `${data.watcher.active ? 'Watcher 在线' : 'Watcher 停止'} · ${data.freshness.state === 'fresh' && !stale ? '赔率新鲜' : '赔率未就绪'}`, href: '/monitor-alerts', link: '监控报警' },
    { key: 'rules', title: '策略规则', detail: verifiedRuleCards ? `${ruleCards.enabled} / ${ruleCards.total} 张卡片已启用` : '动态卡片状态不可用，真实投注保持阻断', href: '/betting-rules', link: '投注规则' },
    { key: 'accounts', title: '投注账号', detail: `${data.accounts.enabled} 个可分配 · ${data.accounts.paused} 个暂停`, href: '/betting-accounts', link: '前往设置' },
    { key: 'realBetting', title: '全局真实投注', detail: runtimeLabels[data.runtime.state] || '状态未知', href: '/operations', link: '前往设置' },
  ] as const : []

  return (
    <div className="page-stack operations-page operations-clean">
      <header className="operations-heading clean-heading">
        <div><p className="eyebrow">OPERATIONS / 本机</p><h1>运行控制台</h1><p>{headline}</p></div>
        <div className="heading-actions">
          <Button onClick={() => void refreshRef.current(true)}>立即刷新</Button>
          {data?.watcher.active ? (
            <Popconfirm title="停止赔率监控？" description="停止后将不再读取新的赔率变化。" okText="确认停止" cancelText="取消" onConfirm={() => monitorAction('stop')}>
              <Button loading={pending === 'monitor-stop'}>停止监控</Button>
            </Popconfirm>
          ) : (
            <Button type="primary" loading={pending === 'monitor-start'} onClick={() => monitorAction('start')}>启动监控</Button>
          )}
        </div>
      </header>

      {offline ? <Alert type="error" showIcon message="连接中断，正在显示最后一次数据" /> : null}
      {!offline && stale && data ? <Alert type="warning" showIcon message="赔率数据未就绪，真实投注保持阻断" /> : null}
      {!offline && watcherProcess?.processState === 'waiting-restart' ? (
        <Alert
          type="warning"
          showIcon
          message={`Watcher 正在等待第 ${watcherProcess.restartAttempt} 次恢复`}
          description={`${watcherProcess.nextRestartAt ? `计划时间：${timeText(watcherProcess.nextRestartAt)}。` : ''}${watcherProcess.lastExit?.stderrSummary || ''}`}
        />
      ) : null}
      {!offline && watcherProcess?.processState === 'stopped-after-retries' ? (
        <Alert
          type="error"
          showIcon
          message="Watcher 连续恢复失败，已停止自动重启"
          description={watcherProcess.lastExit?.stderrSummary || '请检查原因后手工启动监控。'}
        />
      ) : null}

      <section className="readiness-panel" aria-label="下注准备链路">
        <div className="section-header"><div><h2>下注准备链路</h2><p>四层全部就绪后，运维总开关才允许提交真实订单。</p></div></div>
        <div className="readiness-flow">
          {readinessSteps.map((step, index) => {
            const item = data?.readiness[step.key]
            return <div className={`readiness-step state-${item?.state || 'loading'}`} key={step.key}>
              <div className="readiness-index">{index + 1}</div>
              <div><h3>{step.title}</h3><strong>{readinessText(item)}</strong><p>{step.detail}</p><a href={step.href}>{step.link}</a></div>
            </div>
          })}
        </div>
        <div className="real-control-row">
          <div>
            <strong>{realRequested ? '真实投注已请求运行' : '真实投注总开关已关闭'}</strong>
            <p>{startSafe || realRequested ? '账号启用只代表可分配，最终下单仍受规则、总开关和安全预检控制。' : '请按上方提示完成缺失条件。'}</p>
          </div>
          <div className="real-control-actions">
          {!realRequested ? (
            <Popconfirm title="开启真实投注？" description="只有实时安全条件全部满足后才会执行。" okText="确认开启" cancelText="取消" onConfirm={() => runtimeAction('start')}>
              <Button type="primary" disabled={!startSafe} loading={pending === 'real-start'}>开启真实投注</Button>
            </Popconfirm>
          ) : null}
          <Popconfirm title="停止真实投注？" description="新订单会停止，已发出的订单仍会继续对账。" okText="确认停止" cancelText="取消" onConfirm={() => runtimeAction('stop')}>
            <Button danger loading={pending === 'real-stop'}>停止真实投注</Button>
          </Popconfirm>
          </div>
        </div>
      </section>

      {data ? <section className="mode-operation-summary" aria-label="双模式配置状态">
        <div><h2>监控报警</h2>{(['prematch', 'live'] as const).map((mode) => { const label = mode === 'prematch' ? '赛前' : '滚球'; const setting = data.monitorAlerts[mode]; return <div className="mode-summary-item" key={mode}>
          <p>{label}报警：{setting.enabled ? '已启用' : '已关闭'} <Tag>{setting.enabled ? '启用' : '关闭'}</Tag></p>
          <p><span>{label}报警待复核：{setting.reviewRequired ? '是' : '否'}</span> <Tag color={setting.reviewRequired ? 'orange' : 'default'}>{setting.reviewRequired ? '需复核' : '无需复核'}</Tag></p>
          <p>{label}盘口：让球 {setting.markets.asianHandicap ? '已启用' : '已关闭'} · 大小球 {setting.markets.total ? '已启用' : '已关闭'}</p>
        </div> })}</div>
        <div><h2>投注规则卡片</h2><div className="mode-summary-item">
          {!verifiedRuleCards ? <p>动态卡片状态不可用，真实投注保持阻断</p> : null}
          <p>卡片总数：{ruleCards.total} <Tag>{ruleCards.enabled} 张启用</Tag></p>
          <p>待复核：{ruleCards.reviewRequired} <Tag color={ruleCards.reviewRequired ? 'orange' : 'default'}>{ruleCards.reviewRequired ? '需复核' : '无需复核'}</Tag></p>
          <p>已占用联赛：{ruleCards.ownedLeagues}</p>
        </div></div>
      </section> : null}

      {hasRisk ? <section className="risk-ledger compact-risk" aria-label="优先风险">
        <div className="risk-lead" data-testid="unknown-risk">
          <p>最高优先级</p><h2>待确认投注</h2><strong>{data?.batches.unknownAmountMinor ?? 0} CNY</strong>
          <span>{data?.accounts.unknown ?? 0} 个账户仍被 unknown 锁定，不会自动重投。</span>
          {hasBrowserCampaignRisk ? <span>验收 unknown {browserCampaignUnknownCount} · terminal unknown，等待人工恢复。</span> : null}
        </div>
        <div className="risk-queue" data-testid="reconciliation-risk"><div><span>对账队列</span><strong>待处理 {data?.reconciliation.due ?? 0}</strong></div><dl><div><dt>人工复核</dt><dd>{data?.reconciliation.manualReview ?? 0}</dd></div><div><dt>死信</dt><dd>{data?.reconciliation.deadLetter ?? 0}</dd></div><div><dt>全部未关闭</dt><dd>{data?.reconciliation.open ?? 0}</dd></div><div><dt>通知积压</dt><dd>{data?.notifications.backlog ?? 0}</dd></div></dl></div>
      </section> : <section className="risk-clear" aria-label="风险状态"><span className="freshness-dot safe" /><div><strong>当前无待处理风险</strong><p>没有 unknown 锁、对账任务或通知积压。</p></div></section>}

      {data?.browserBetting ? <BrowserBettingPanel summary={data.browserBetting} /> : null}

      <section className="operations-ledger clean-ledger" aria-label="运行摘要">
        <div className="ledger-section"><h2>规则</h2><dl><div><dt>规则总数</dt><dd>{data?.rules.total ?? 0}</dd></div><div><dt>监控开启</dt><dd>{data?.rules.monitorEnabled ?? 0}</dd></div><div><dt>真实允许</dt><dd>{data?.rules.realEnabled ?? 0}</dd></div><div><dt>24h 命中</dt><dd>{data?.rules.recentHitCount ?? 0}</dd></div></dl></div>
        <div className="ledger-section"><h2>账号</h2><dl><div><dt>可分配</dt><dd>{data?.accounts.enabled ?? 0}</dd></div><div><dt>暂停处理中</dt><dd>{data?.accounts.pausePending ?? 0}</dd></div><div><dt>已暂停</dt><dd>{data?.accounts.paused ?? 0}</dd></div><div><dt>执行锁</dt><dd>{data?.accounts.locked ?? 0}</dd></div></dl></div>
        <div className="ledger-section"><h2>最近 {data?.batches.recentLimit ?? 20} 批</h2><dl><div><dt>执行中</dt><dd>{data?.batches.active ?? 0}</dd></div><div><dt>完成</dt><dd>{data?.batches.completed ?? 0}</dd></div><div><dt>部分完成</dt><dd>{data?.batches.partial ?? 0}</dd></div><div><dt>失败 / 取消</dt><dd>{(data?.batches.failed ?? 0) + (data?.batches.cancelled ?? 0)}</dd></div></dl></div>
      </section>

      <section className="recent-operations" aria-label="最近投注批次">
        <div className="section-header"><div><h2>最近投注批次</h2><p>显示最近 8 条安全运行上下文。</p></div><div><a href="/betting-history">查看全部投注历史</a><Tag>{data ? `服务时间 ${timeText(data.serverTime)}` : '读取中'}</Tag></div></div>
        <Spin spinning={loading && !data}><div className="operations-table" role="table" aria-label="最近投注批次"><div className="operations-row operations-table-head" role="row"><span role="columnheader">目标 / 时间</span><span role="columnheader">状态</span><span role="columnheader">已接受</span><span role="columnheader">待确认</span></div>{data?.recentBatches.length ? data.recentBatches.map((batch) => <div className="operations-row" role="row" key={batch.batchId}><span role="cell"><b>真实投注目标</b><small>{timeText(batch.createdAt)}</small></span><span role="cell">{batchLabels[batch.status] || batch.status}</span><span role="cell">已接受 {batch.acceptedAmountMinor} CNY</span><span role="cell" className={batch.unknownAmountMinor ? 'unknown-value' : ''}>待确认 {batch.unknownAmountMinor} CNY</span></div>) : <div className="operations-empty" role="row"><span role="cell">暂无投注批次</span></div>}</div></Spin>
      </section>

      <section className="maintenance-panel" aria-label="每日开工重置">
        <div className="section-header"><div><p className="eyebrow">维护工具</p><h2>每日开工完全重置</h2><p>清除点击前生成的赔率、监控、候选、投注账本、幂等锁、pending/unknown、对账、日志、索引和普通缓存。完成后自动启动监控，投注账号保持暂停，真实投注保持关闭。</p></div><Popconfirm title="完全重置点击前运行数据？" description="此操作不能撤销；账号凭据、登录会话、规则和协议证据会保留。" okText="确认完全重置" cancelText="取消" onConfirm={cleanupRuntimeData}><Button danger loading={cleanupPending} disabled={!cleanup || (cleanup.bytes === 0 && cleanup.records === 0)}>每日开工完全重置</Button></Popconfirm></div>
        {cleanupError ? <Alert type="error" showIcon message={cleanupError} /> : null}
        <Alert type={cleanup?.bytes ? 'info' : 'success'} showIcon message={cleanup && (cleanup.bytes || cleanup.records) ? `可清理 ${sizeText(cleanup.bytes)} / ${cleanup.files} 个文件${cleanup.records ? ` / ${cleanup.records} 条历史记录` : ''}` : '当前没有可清理缓存'} />
      </section>
    </div>
  )
}
