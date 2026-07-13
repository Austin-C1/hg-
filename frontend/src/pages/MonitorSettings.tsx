import { Alert, Button, Card, Checkbox, Collapse, Input, InputNumber, Space, Spin, Switch, Tag } from 'antd'
import { useEffect, useState } from 'react'

import { api, APP_CONTRACT_VERSION, isDashboardAuthenticationError } from '../services/api'
import type { AutoBetMode, LiveMonitorAlertSetting, MonitorAlertSetting, MonitorHealth, PrematchMonitorAlertSetting } from '../types'

const conflictText = '配置已被其他页面更新，请刷新后重试'
const modeText = { prematch: '赛前', live: '滚球' } as const

function errorText(error: unknown) {
  const fields = (error as { payload?: { fields?: Record<string, unknown> } })?.payload?.fields
  if (typeof fields?.waterMoveThreshold === 'string') return '动水阈值不能为空且必须大于等于 0。'
  if (typeof fields?.monitorOddsMin === 'string') return '监控水位下限必须是有效数字。'
  if (typeof fields?.monitorOddsMax === 'string') return '监控水位上限必须是有效数字，且不能小于下限。'
  if (typeof fields?.startMinutesBeforeKickoff === 'string' || typeof fields?.stopMinutesBeforeKickoff === 'string') return '赛前监控时间不完整或顺序无效。'
  if (typeof fields?.liveMinuteFrom === 'string' || typeof fields?.liveMinuteTo === 'string') return '滚球监控分钟不完整或顺序无效。'
  if (typeof fields?.acknowledgeMigrationReview === 'string') return '迁移复核只能通过完整保存确认。'
  if ((error as { status?: number })?.status === 409 || String((error as Error)?.message).includes('version-conflict')) return conflictText
  if (isDashboardAuthenticationError(error)) return '请先登录 Dashboard 后再操作。'
  return error instanceof Error ? error.message : '保存失败，请稍后重试'
}

function validate(item: MonitorAlertSetting) {
  if (item.enabled && !item.asianHandicapEnabled && !item.totalEnabled) return '启用报警时至少选择一个监控盘口。'
  const finiteSafe = (value: number | null) => value === null || (Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER)
  const finite = [item.monitorOddsMin, item.monitorOddsMax, item.waterMoveThreshold].every(finiteSafe)
  if (!finite || item.waterMoveThreshold < 0 || !Number.isSafeInteger(item.cooldownSeconds) || item.cooldownSeconds < 0) return '数值必须有效、在安全范围内，且冷却秒数不得小于 0。'
  if (item.monitorOddsMin !== null && item.monitorOddsMax !== null && item.monitorOddsMin > item.monitorOddsMax) return '监控水位上限不得小于下限。'
  if (item.mode === 'prematch') {
    if (![item.startMinutesBeforeKickoff, item.stopMinutesBeforeKickoff].every((value) => Number.isSafeInteger(value) && value >= 0) || item.startMinutesBeforeKickoff < item.stopMinutesBeforeKickoff) return '赛前监控时间必须为非负整数，开始分钟不得小于停止分钟。'
  } else {
    if (![item.liveMinuteFrom, item.liveMinuteTo].every((value) => Number.isSafeInteger(value) && value >= 0) || item.liveMinuteFrom > item.liveMinuteTo) return '滚球分钟必须为非负整数，起始分钟不得大于结束分钟。'
    if (item.enabled && !item.includeFirstHalf && !item.includeHalfTime && !item.includeSecondHalf) return '启用滚球报警时至少选择一个比赛阶段。'
  }
  return ''
}

function Health({ health }: { health?: MonitorHealth }) {
  if (!health) return null
  const items = health.incompleteData.items || []
  return <section aria-label="监控诊断" className="settings-diagnostics">
    <Collapse items={[{ key: 'health', label: <>监控诊断 <Tag>{health.incompleteData.total} 项数据质量问题</Tag></>, children: <>
      <div className="monitor-health-stats">
        <div><span>待发送告警</span><strong>{health.deliveries.pending}</strong></div>
        <div><span>投递失败</span><strong>{health.deliveries.deadLetter}</strong></div>
        <div><span>活跃事件</span><strong>{health.state.events.active}</strong></div>
        <div><span>最后权威批次</span><strong>{health.lastAuthoritative?.batchId || '无'}</strong></div>
      </div>
      {items.map((item) => <Alert key={`${item.eventKey}:${item.reason}`} type="warning" showIcon message={`${item.league} · ${item.homeTeam} vs ${item.awayTeam}`} description={`${item.eventKey} · ${item.reason}`} />)}
    </> }]} />
  </section>
}

function ModeCard({ server, blocked, onSaved }: { server: MonitorAlertSetting; blocked: boolean; onSaved: (item: MonitorAlertSetting) => void }) {
  const [draft, setDraft] = useState(server)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => setDraft(server), [server])
  const set = (patch: Partial<MonitorAlertSetting>) => setDraft((current) => ({ ...current, ...patch } as MonitorAlertSetting))
  const save = async () => {
    if (blocked) return
    const validation = validate(draft)
    if (validation) { setError(validation); return }
    setSaving(true); setError('')
    const common = { expectedVersion: server.version, acknowledgeMigrationReview: server.migrationReviewRequired, enabled: draft.enabled, asianHandicapEnabled: draft.asianHandicapEnabled, totalEnabled: draft.totalEnabled, monitorOddsMin: draft.monitorOddsMin, monitorOddsMax: draft.monitorOddsMax, waterMoveThreshold: draft.waterMoveThreshold, cooldownSeconds: draft.cooldownSeconds, remark: draft.remark }
    const payload = draft.mode === 'prematch'
      ? { ...common, startMinutesBeforeKickoff: draft.startMinutesBeforeKickoff, stopMinutesBeforeKickoff: draft.stopMinutesBeforeKickoff }
      : { ...common, liveMinuteFrom: draft.liveMinuteFrom, liveMinuteTo: draft.liveMinuteTo, includeFirstHalf: draft.includeFirstHalf, includeHalfTime: draft.includeHalfTime, includeSecondHalf: draft.includeSecondHalf }
    try { onSaved(await api.updateMonitorAlertSetting(draft.mode, payload)) }
    catch (caught) { setDraft(server); setError(errorText(caught)) }
    finally { setSaving(false) }
  }
  const prefix = modeText[draft.mode]
  return <Card className="mode-settings-card" role="region" aria-label={`${prefix}报警`} title={<h2>{prefix}报警</h2>} extra={<Switch aria-label={`启用${prefix}报警`} checked={draft.enabled} disabled={saving || blocked} onChange={(enabled) => set({ enabled })} />}>
    <Spin spinning={saving}>
      {error ? <Alert className="card-alert" type="error" showIcon message={error} /> : null}
      {server.migrationReviewRequired ? <Alert className="card-alert" type="warning" showIcon message="该配置需要迁移复核" description={server.migrationReviewReason || undefined} /> : null}
      <div className="settings-form-grid">
        <div className="form-span checkbox-field"><span>监控盘口</span><Checkbox.Group value={[draft.asianHandicapEnabled ? 'handicap' : '', draft.totalEnabled ? 'total' : ''].filter(Boolean)} onChange={(values) => set({ asianHandicapEnabled: values.includes('handicap'), totalEnabled: values.includes('total') })}><Checkbox value="handicap">让球</Checkbox><Checkbox value="total">大小球</Checkbox></Checkbox.Group></div>
        <label><span>监控水位下限</span><InputNumber aria-label="监控水位下限" value={draft.monitorOddsMin} onChange={(value) => set({ monitorOddsMin: value })} /></label>
        <label><span>监控水位上限</span><InputNumber aria-label="监控水位上限" value={draft.monitorOddsMax} onChange={(value) => set({ monitorOddsMax: value })} /></label>
        <label><span>动水阈值</span><InputNumber aria-label="动水阈值" min={0} value={draft.waterMoveThreshold} onChange={(value) => set({ waterMoveThreshold: value ?? 0 })} /><small>上涨、下降达到阈值都会报警</small></label>
        <label><span>冷却秒数</span><InputNumber aria-label="冷却秒数" min={0} precision={0} value={draft.cooldownSeconds} onChange={(value) => set({ cooldownSeconds: value ?? 0 })} /></label>
        {draft.mode === 'prematch' ? <>
          <label><span>开始监控（开赛前分钟）</span><InputNumber aria-label="开始监控（开赛前分钟）" min={0} precision={0} value={draft.startMinutesBeforeKickoff} onChange={(value) => set({ startMinutesBeforeKickoff: value ?? 0 })} /></label>
          <label><span>停止监控（开赛前分钟）</span><InputNumber aria-label="停止监控（开赛前分钟）" min={0} precision={0} value={draft.stopMinutesBeforeKickoff} onChange={(value) => set({ stopMinutesBeforeKickoff: value ?? 0 })} /></label>
        </> : <>
          <label><span>滚球起始分钟</span><InputNumber aria-label="滚球起始分钟" min={0} precision={0} value={draft.liveMinuteFrom} onChange={(value) => set({ liveMinuteFrom: value ?? 0 })} /></label>
          <label><span>滚球结束分钟</span><InputNumber aria-label="滚球结束分钟" min={0} precision={0} value={draft.liveMinuteTo} onChange={(value) => set({ liveMinuteTo: value ?? 0 })} /></label>
          <div className="form-span checkbox-field"><span>比赛阶段</span><Checkbox.Group value={[draft.includeFirstHalf ? 'first' : '', draft.includeHalfTime ? 'half' : '', draft.includeSecondHalf ? 'second' : ''].filter(Boolean)} onChange={(values) => set({ includeFirstHalf: values.includes('first'), includeHalfTime: values.includes('half'), includeSecondHalf: values.includes('second') })}><Checkbox value="first">上半场</Checkbox><Checkbox value="half">半场</Checkbox><Checkbox value="second">下半场</Checkbox></Checkbox.Group></div>
        </>}
        <label className="form-span"><span>备注</span><Input.TextArea aria-label={`${prefix}报警备注`} value={draft.remark} onChange={(event) => set({ remark: event.target.value })} autoSize={{ minRows: 2, maxRows: 4 }} /></label>
      </div>
      <Space className="settings-card-footer"><span>版本 {server.version} · 更新 {server.updatedAt || '无'}</span><Button type="primary" loading={saving} disabled={blocked} onClick={() => void save()}>保存{prefix}报警</Button></Space>
    </Spin>
  </Card>
}

export default function MonitorSettings() {
  const [items, setItems] = useState<{ prematch: PrematchMonitorAlertSetting; live: LiveMonitorAlertSetting } | null>(null)
  const [health, setHealth] = useState<MonitorHealth>()
  const [loadError, setLoadError] = useState('')
  const [contractMismatch, setContractMismatch] = useState(false)
  useEffect(() => {
    void Promise.all([api.sessionBootstrap(), api.getMonitorAlertSettings(), api.getMonitorSettings?.().catch(() => null)]).then(([security, payload, legacy]) => {
      setContractMismatch(security.appContractVersion !== APP_CONTRACT_VERSION || security.schemaVersion !== APP_CONTRACT_VERSION)
      setItems(payload.items)
      setHealth(legacy?.monitorHealth)
    }).catch((error) => setLoadError(errorText(error)))
  }, [])
  const update = (mode: AutoBetMode, item: MonitorAlertSetting) => setItems((current) => current ? { ...current, [mode]: item } as typeof current : current)
  return <div className="page-stack mode-settings-page">
    <header className="page-title"><div><h1>监控报警</h1><p>赛前与滚球报警分别保存，可同时启用。</p></div></header>
    {loadError ? <Alert type="error" showIcon message={loadError} /> : null}
    {contractMismatch ? <Alert type="error" showIcon message="Dashboard 已升级，请重启" description="前后端或数据库契约版本不一致，所有保存操作已阻止。" /> : null}
    {!items ? <Spin /> : <div className="mode-settings-grid"><ModeCard server={items.prematch} blocked={contractMismatch} onSaved={(item) => update('prematch', item)} /><ModeCard server={items.live} blocked={contractMismatch} onSaved={(item) => update('live', item)} /></div>}
    <Health health={health} />
  </div>
}
