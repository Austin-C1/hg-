import { Alert, Button, Card, Empty, Form, Input, Modal, Popconfirm, Select, Space, Spin, Switch, Tag } from 'antd'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { APP_CONTRACT_VERSION, CONTRACT_COMPATIBILITY_EVENT, api, isContractCompatible,
  isDashboardAuthenticationError } from '../services/api'
import type { AutoBettingRuleCard, BrowserBettingSummary, RuleCardMutation, TodayBettingLeague } from '../types'
import { DirectionSupport, directionLabel } from '../components/BrowserBettingPanel'

const decimalPattern = /^\d+(?:\.\d+)?$/
const maxSafe = 9007199254740991n
const emptyDraft: RuleCardMutation = {
  name: '', enabled: true, leagueNames: [], targetOddsMin: '', targetOddsMax: '', targetAmountMinor: 0, remark: '',
}

type Draft = Omit<RuleCardMutation, 'targetAmountMinor'> & { targetAmountMinor: string }
type FieldErrors = Partial<Record<keyof Draft, string>>

function exactDecimal(value: string) {
  if (value.length > 128 || !decimalPattern.test(value)) throw new Error('目标水位必须是非负十进制字符串')
  const [rawInteger, rawFraction = ''] = value.split('.')
  const integer = rawInteger.replace(/^0+/, '') || '0'
  const fraction = rawFraction.replace(/0+$/, '')
  if (fraction.length > 18) throw new Error('目标水位最多支持 18 位小数')
  const coefficient = BigInt(`${integer}${fraction}`)
  const scale = fraction.length
  if (coefficient > maxSafe * (10n ** BigInt(scale))) throw new Error('目标水位超出安全范围')
  return { canonical: fraction ? `${integer}.${fraction}` : integer, coefficient, scale }
}

function compareDecimal(left: ReturnType<typeof exactDecimal>, right: ReturnType<typeof exactDecimal>) {
  const scale = Math.max(left.scale, right.scale)
  const l = left.coefficient * (10n ** BigInt(scale - left.scale))
  const r = right.coefficient * (10n ** BigInt(scale - right.scale))
  return l < r ? -1 : l > r ? 1 : 0
}

function canonicalAmount(value: string) {
  if (value.length > 16 || !/^[1-9]\d*$/.test(value)) return null
  const amount = BigInt(value)
  return amount <= maxSafe ? Number(amount) : null
}

function errorText(error: unknown) {
  const payloadError = (error as { payload?: { error?: string } })?.payload?.error
  const code = payloadError || (error instanceof Error ? error.message : '')
  if (isDashboardAuthenticationError(error)) return '请先登录 Dashboard 后再操作。'
  if (code === 'contract-version-mismatch') return '前后端版本不一致，请刷新页面或重启 Dashboard。'
  if (code === 'league-owned-by-another-card') return '所选联赛已被其他规则占用，请重新选择。'
  if (code === 'league-not-available-today') return '所选联赛今日不可用，请重新选择。'
  if (code === 'league-required') return '请至少选择一个联赛'
  if (code === 'migration-review-required') return '该规则需要完成迁移复核后才能启用。'
  if (code === 'rule-deleted' || code === 'auto-betting-card-not-found') return '该规则已被删除，请刷新页面。'
  if ((error as { status?: number })?.status === 409 || code.includes('version-conflict')) return '配置已被其他页面更新，请刷新后重试'
  return code || '操作失败，请稍后重试'
}

function isVersionConflict(error: unknown) {
  const payloadCode = (error as { payload?: { error?: string } })?.payload?.error
  return payloadCode === 'auto-betting-card-version-conflict'
    || String((error as Error)?.message) === 'auto-betting-card-version-conflict'
}

function draftFrom(card: AutoBettingRuleCard | null): Draft {
  return card ? {
    name: card.name, enabled: card.enabled, leagueNames: [...card.leagueNames],
    targetOddsMin: card.targetOddsMin ?? '', targetOddsMax: card.targetOddsMax ?? '',
    targetAmountMinor: card.targetAmountMinor === null ? '' : String(card.targetAmountMinor), remark: card.remark,
  } : { ...emptyDraft, leagueNames: [], targetAmountMinor: '' }
}

function activityText(value: string | null | undefined) { return value || '暂无' }

function sourceText(item: TodayBettingLeague) {
  const source = { default: '默认', manual: '手动', both: '默认 + 手动', stale: '历史保留' }[item.source]
  const availability = item.availableToday ? `${item.todayMatchCount} 场` : '今日不可用'
  const owner = item.ownerCardName && !item.selectable ? ` · 已被${item.ownerCardName}使用` : ''
  return `${item.leagueName} · ${source} · ${availability}${owner}`
}

function RuleSummaryCard({ card, onEdit, onDelete, readOnly }: {
  card: AutoBettingRuleCard
  onEdit: (card: AutoBettingRuleCard) => void
  onDelete: (card: AutoBettingRuleCard) => Promise<void>
  readOnly: boolean
}) {
  return <Card className={`rule-summary-card ${card.enabled ? 'is-enabled' : 'is-disabled'}`} role="article" aria-label={card.name}>
    <div className="rule-card-heading">
      <div><h2>{card.name}</h2><span>版本 {card.version}</span></div>
      <Tag color={card.enabled ? 'green' : 'default'}>{card.enabled ? '已启用' : '已停用'}</Tag>
    </div>
    <div className="rule-league-tags">{card.leagueNames.map((name) => <Tag key={name}>{name}</Tag>)}</div>
    <dl className="rule-card-facts">
      <div><dt>目标水位</dt><dd>{card.targetOddsMin ?? '—'} — {card.targetOddsMax ?? '—'}</dd></div>
      <div><dt>目标金额</dt><dd>{card.targetAmountMinor ?? '—'} CNY</dd></div>
    </dl>
    <div className="rule-state-line">
      <Tag color={card.realEligible ? 'green' : 'default'}>{card.realEligible ? '真实执行资格：已具备' : '真实执行资格：未具备'}</Tag>
      <Tag color={card.migrationReviewRequired ? 'orange' : 'default'}>{card.migrationReviewRequired ? '迁移待复核' : '迁移已复核'}</Tag>
    </div>
    <dl className="rule-card-activity">
      <div><dt>最近 Signal</dt><dd>{activityText(card.recentSignal)}</dd></div>
      <div><dt>最近批次</dt><dd>{activityText(card.recentBatch)}</dd></div>
      <div><dt>最近结果</dt><dd>{activityText(card.recentResult)}</dd></div>
    </dl>
    <div className="rule-card-actions">
      <Button disabled={readOnly} aria-label={`编辑${card.name}`} onClick={() => onEdit(card)}>编辑</Button>
      <Popconfirm disabled={readOnly} title="确定删除该规则？" description="删除后，该规则占用的联赛将立即释放。" okText="确定" cancelText="取消" onConfirm={() => onDelete(card)}>
        <Button disabled={readOnly} danger aria-label={`删除${card.name}`}>删除</Button>
      </Popconfirm>
    </div>
  </Card>
}

export function RuleCardModal({ editing, open, onClose, onSaved, onConflictReload, onConflictDeleted, readOnly = false }: {
  editing: AutoBettingRuleCard | null
  open: boolean
  onClose: () => void
  onSaved: (card: AutoBettingRuleCard) => void
  onConflictReload: (cardId: string) => Promise<AutoBettingRuleCard | null>
  onConflictDeleted: (refresh?: boolean) => void
  readOnly?: boolean
}) {
  const [server, setServer] = useState<AutoBettingRuleCard | null>(editing)
  const [draft, setDraft] = useState<Draft>(() => draftFrom(editing))
  const [leagues, setLeagues] = useState<TodayBettingLeague[]>([])
  const [leagueLoading, setLeagueLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const generationRef = useRef(0)
  const inFlightRef = useRef(false)

  function reconcileLeagues(items: TodayBettingLeague[]) {
    setLeagues(items)
    setDraft((current) => {
      const invalid = current.leagueNames.filter((name) => !items.some((item) => item.leagueName === name && item.selectable))
      if (!invalid.length) return current
      const owners = invalid.map((name) => items.find((item) => item.leagueName === name)?.ownerCardName).filter(Boolean)
      setFieldErrors((errors) => ({ ...errors, leagueNames: owners.length
        ? `${invalid.join('、')} 已被${owners.join('、')}使用`
        : `${invalid.join('、')} 今日不可用，已从选择中移除` }))
      return { ...current, leagueNames: current.leagueNames.filter((name) => !invalid.includes(name)) }
    })
  }

  async function loadLeagues(cardId: string | undefined, generation: number) {
    setLeagues([]); setLeagueLoading(true)
    try {
      const response = cardId ? await api.getTodayBettingLeagues(cardId) : await api.getTodayBettingLeagues()
      if (generationRef.current === generation) reconcileLeagues(response.items)
    } catch (caught) {
      if (generationRef.current === generation) { setLeagues([]); setError(errorText(caught)) }
    } finally {
      if (generationRef.current === generation) setLeagueLoading(false)
    }
  }

  useLayoutEffect(() => {
    const generation = ++generationRef.current
    inFlightRef.current = false
    setServer(editing); setDraft(draftFrom(editing)); setLeagues([])
    setError(''); setFieldErrors({}); setLeagueLoading(open); setSaving(false)
    if (open) void loadLeagues(editing?.cardId, generation)
    return () => { if (generationRef.current === generation) generationRef.current += 1 }
  }, [editing?.cardId, open])

  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [field]: value }))
    setFieldErrors((current) => ({ ...current, [field]: undefined }))
  }

  function focusFirst(errors: FieldErrors) {
    const first = (['name', 'leagueNames', 'targetOddsMin', 'targetOddsMax', 'targetAmountMinor'] as const).find((field) => errors[field])
    if (!first) return
    queueMicrotask(() => {
      const target = document.getElementById('rule-card-form')?.querySelector<HTMLElement>(`[aria-label="${({ name: '规则名称', leagueNames: '联赛', targetOddsMin: '目标水位下限', targetOddsMax: '目标水位上限', targetAmountMinor: '目标投注金额（CNY）' } as const)[first]}"]`)
      target?.focus()
      target?.scrollIntoView?.({ block: 'nearest' })
    })
  }

  async function save() {
    if (inFlightRef.current || readOnly) return
    const errors: FieldErrors = {}
    if (!draft.name.trim()) errors.name = '请输入规则名称'
    if (leagueLoading) errors.leagueNames = '联赛选项正在加载，请稍候'
    else if (!draft.leagueNames.length) errors.leagueNames = '请至少选择一个联赛'
    else {
      const invalid = draft.leagueNames.filter((name) => !leagues.some((item) => item.leagueName === name && item.selectable))
      if (invalid.length) errors.leagueNames = `${invalid.join('、')} 已不可选，请重新选择`
    }
    const amount = canonicalAmount(draft.targetAmountMinor)
    if (amount === null) errors.targetAmountMinor = '目标投注金额必须是大于 0 的 CNY 正整数'
    let min: ReturnType<typeof exactDecimal> | null = null
    let max: ReturnType<typeof exactDecimal> | null = null
    try { min = exactDecimal(draft.targetOddsMin) } catch (caught) { errors.targetOddsMin = (caught as Error).message }
    try { max = exactDecimal(draft.targetOddsMax) } catch (caught) { errors.targetOddsMax = (caught as Error).message }
    if (min && max && compareDecimal(min, max) > 0) errors.targetOddsMax = '目标水位上限不得小于下限'
    setFieldErrors(errors)
    if (Object.keys(errors).length || amount === null || !min || !max) { focusFirst(errors); return }

    const payload: RuleCardMutation = {
      name: draft.name.trim(), enabled: draft.enabled, leagueNames: draft.leagueNames,
      targetOddsMin: min.canonical, targetOddsMax: max.canonical,
      targetAmountMinor: amount, remark: draft.remark,
    }
    const generation = generationRef.current
    inFlightRef.current = true
    setSaving(true); setError('')
    try {
      const result = server
        ? await api.updateAutoBettingRuleCard(server.cardId, { ...payload, expectedVersion: server.version })
        : await api.createAutoBettingRuleCard(payload)
      if (generationRef.current !== generation) return
      onSaved(result)
      onClose()
    } catch (caught) {
      if (generationRef.current !== generation) return
      const caughtCode = (caught as { payload?: { error?: string } })?.payload?.error || String((caught as Error)?.message || '')
      if (server && (caughtCode === 'auto-betting-card-not-found' || caughtCode === 'rule-deleted')) {
        onConflictDeleted(true)
        return
      }
      if (server && isVersionConflict(caught)) {
        const conflictFields = (caught as { payload?: { fields?: Record<string, unknown> } })?.payload?.fields
        setLeagues([]); setLeagueLoading(true); setFieldErrors({})
        let latest: AutoBettingRuleCard | null
        try { latest = await onConflictReload(server.cardId) }
        catch (reloadError) {
          if (generationRef.current === generation) { setError(errorText(reloadError)); setLeagueLoading(false) }
          return
        }
        if (generationRef.current !== generation) return
        if (!latest) { onConflictDeleted(false); return }
        setServer(latest); setDraft(draftFrom(latest)); setError(errorText(caught))
        await loadLeagues(latest.cardId, generation)
        if (generationRef.current === generation && Array.isArray(conflictFields?.leagueNames)) {
          const names = conflictFields.leagueNames.filter((value): value is string => typeof value === 'string')
          const owner = typeof conflictFields.ownerName === 'string' ? conflictFields.ownerName : ''
          setFieldErrors((current) => ({ ...current, leagueNames: owner ? `${names.join('、')} 已被${owner}使用` : names.join('、') }))
        }
        return
      }
      const fields = (caught as { payload?: { fields?: Record<string, unknown> } })?.payload?.fields
      if (fields) {
        const projected: FieldErrors = {}
        for (const field of Object.keys(fields) as Array<keyof Draft>) if (field in draft) projected[field] = String(fields[field])
        if (Array.isArray(fields.leagueNames)) {
          const names = fields.leagueNames.filter((value): value is string => typeof value === 'string')
          const owner = typeof fields.ownerName === 'string' ? fields.ownerName : ''
          projected.leagueNames = owner ? `${names.join('、')} 已被${owner}使用` : names.join('、')
        }
        setFieldErrors(projected)
      }
      setError(errorText(caught))
    } finally {
      if (generationRef.current === generation) { inFlightRef.current = false; setSaving(false) }
    }
  }

  function guardedClose() { if (!inFlightRef.current) onClose() }

  const options = leagues.map((item) => ({
    value: item.leagueName,
    label: sourceText(item),
    disabled: !item.selectable,
    title: sourceText(item),
  }))

  return <Modal
    className="rule-card-modal"
    title={server ? '编辑投注规则' : '新增投注规则'}
    aria-label={server ? '编辑投注规则' : '新增投注规则'}
    open={open}
    width={620}
    onCancel={guardedClose}
    footer={[
      <Button key="cancel" disabled={saving} onClick={guardedClose}>取消</Button>,
      <Button key="save" disabled={readOnly} type="primary" htmlType="submit" form="rule-card-form" loading={saving}>保存规则</Button>,
    ]}
    destroyOnHidden
    maskClosable={!saving}
    closable={!saving}
    keyboard={!saving}
  >
    {error ? <Alert className="card-alert" type="error" showIcon message={error} /> : null}
    <Form id="rule-card-form" layout="vertical" requiredMark={false} className="rule-card-form" onFinish={() => void save()} onKeyDown={(event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || event.target instanceof HTMLTextAreaElement) return
      event.preventDefault()
      event.currentTarget.requestSubmit()
    }}>
      <Form.Item label="规则名称" validateStatus={fieldErrors.name ? 'error' : undefined} help={fieldErrors.name ? <span id="rule-name-error">{fieldErrors.name}</span> : undefined}>
        <Input aria-label="规则名称" aria-invalid={Boolean(fieldErrors.name)} aria-describedby={fieldErrors.name ? 'rule-name-error' : undefined} maxLength={80} value={draft.name} onChange={(event) => set('name', event.target.value)} />
      </Form.Item>
      <Form.Item label="启用状态">
        <Switch aria-label="启用规则" checked={draft.enabled} onChange={(value) => set('enabled', value)} checkedChildren="启用" unCheckedChildren="停用" />
      </Form.Item>
      <Form.Item label="联赛" validateStatus={fieldErrors.leagueNames ? 'error' : undefined} help={fieldErrors.leagueNames ? <span id="rule-leagues-error">{fieldErrors.leagueNames}</span> : undefined}>
        <Select aria-label="联赛" aria-invalid={Boolean(fieldErrors.leagueNames)} aria-describedby={fieldErrors.leagueNames ? 'rule-leagues-error' : undefined} disabled={leagueLoading} mode="multiple" loading={leagueLoading} value={draft.leagueNames} options={options} optionFilterProp="label" maxTagCount="responsive" onChange={(value) => set('leagueNames', value)} />
      </Form.Item>
      <div className="rule-card-form-grid">
        <Form.Item label="目标水位下限" validateStatus={fieldErrors.targetOddsMin ? 'error' : undefined} help={fieldErrors.targetOddsMin ? <span id="rule-odds-min-error">{fieldErrors.targetOddsMin}</span> : undefined}>
          <Input aria-label="目标水位下限" aria-invalid={Boolean(fieldErrors.targetOddsMin)} aria-describedby={fieldErrors.targetOddsMin ? 'rule-odds-min-error' : undefined} inputMode="decimal" value={draft.targetOddsMin} onChange={(event) => set('targetOddsMin', event.target.value)} />
        </Form.Item>
        <Form.Item label="目标水位上限" validateStatus={fieldErrors.targetOddsMax ? 'error' : undefined} help={fieldErrors.targetOddsMax ? <span id="rule-odds-max-error">{fieldErrors.targetOddsMax}</span> : undefined}>
          <Input aria-label="目标水位上限" aria-invalid={Boolean(fieldErrors.targetOddsMax)} aria-describedby={fieldErrors.targetOddsMax ? 'rule-odds-max-error' : undefined} inputMode="decimal" value={draft.targetOddsMax} onChange={(event) => set('targetOddsMax', event.target.value)} />
        </Form.Item>
      </div>
      <Form.Item label="目标投注金额（CNY）" validateStatus={fieldErrors.targetAmountMinor ? 'error' : undefined} help={fieldErrors.targetAmountMinor ? <span id="rule-amount-error">{fieldErrors.targetAmountMinor}</span> : undefined}>
        <Input aria-label="目标投注金额（CNY）" aria-invalid={Boolean(fieldErrors.targetAmountMinor)} aria-describedby={fieldErrors.targetAmountMinor ? 'rule-amount-error' : undefined} inputMode="numeric" value={draft.targetAmountMinor} onChange={(event) => set('targetAmountMinor', event.target.value)} />
      </Form.Item>
      <Form.Item label="备注">
        <Input.TextArea aria-label="备注" value={draft.remark} maxLength={500} rows={3} onChange={(event) => set('remark', event.target.value)} />
      </Form.Item>
    </Form>
  </Modal>
}

export default function AutoBetRules() {
  const [items, setItems] = useState<AutoBettingRuleCard[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<AutoBettingRuleCard | null>(null)
  const [contractCompatible, setContractCompatible] = useState<boolean | null>(null)
  const [browserBetting, setBrowserBetting] = useState<BrowserBettingSummary | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setLoadError('')
    const [cards, security, operations] = await Promise.allSettled([
      api.getAutoBettingRuleCards(), api.sessionBootstrap(), api.getOperationsSummary(),
    ])
    if (cards.status === 'fulfilled') setItems(cards.value.items)
    else setLoadError(errorText(cards.reason))
    setContractCompatible(security.status === 'fulfilled'
      && security.value.appContractVersion === APP_CONTRACT_VERSION
      && security.value.schemaVersion === APP_CONTRACT_VERSION)
    setBrowserBetting(operations.status === 'fulfilled' ? operations.value.item.browserBetting : null)
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const changed = () => {
      const compatible = isContractCompatible()
      setContractCompatible(compatible)
      if (!compatible) { setEditing(null); setModalOpen(false) }
    }
    window.addEventListener(CONTRACT_COMPATIBILITY_EVENT, changed)
    return () => window.removeEventListener(CONTRACT_COMPATIBILITY_EVENT, changed)
  }, [])

  function openCreate() { if (contractCompatible !== true) return; setEditing(null); setActionError(''); setModalOpen(true) }
  function openEdit(card: AutoBettingRuleCard) { if (contractCompatible !== true) return; setEditing(card); setActionError(''); setModalOpen(true) }
  function saved(card: AutoBettingRuleCard) {
    setItems((current) => current.some((item) => item.cardId === card.cardId)
      ? current.map((item) => item.cardId === card.cardId ? card : item)
      : [card, ...current])
  }
  async function remove(card: AutoBettingRuleCard) {
    if (contractCompatible !== true) return
    setActionError('')
    try {
      await api.deleteAutoBettingRuleCard(card.cardId, card.version)
      setItems((current) => current.filter((item) => item.cardId !== card.cardId))
    } catch (caught) { setActionError(errorText(caught)) }
  }

  async function reloadConflict(cardId: string) {
    const response = await api.getAutoBettingRuleCards()
    setItems(response.items)
    const latest = response.items.find((item) => item.cardId === cardId) || null
    return latest
  }

  function conflictDeleted(refresh = true) {
    setActionError('该规则已被删除，请刷新页面。')
    setEditing(null)
    setModalOpen(false)
    if (refresh) void load()
  }

  return <div className="page-stack rule-cards-page">
    <header className="page-title rule-page-title">
      <div><h1>投注规则</h1><p>报警命中后，按所选联赛独立创建同盘口线对面盘投注任务</p></div>
      <Button disabled={contractCompatible !== true} type="primary" onClick={openCreate}>新增投注规则</Button>
    </header>
    {contractCompatible === false ? <Alert type="error" showIcon message="Dashboard 已升级，请重启" description="前后端或数据库契约版本不一致，所有新增、编辑和删除操作已阻止。" /> : null}
    {loadError ? <Alert type="error" showIcon message={loadError} action={<Button size="small" onClick={() => void load()}>重新加载</Button>} /> : null}
    {actionError ? <Alert type="error" showIcon closable message={actionError} onClose={() => setActionError('')} /> : null}
    {browserBetting ? <section className="rule-browser-support" aria-label="浏览器方向支持">
      <div className="browser-layer-heading"><div><h2>浏览器方向支持</h2><p>能力由后端协议证据计算，只读展示。</p></div><span>{browserBetting.directions.length} / 8</span></div>
      <ul className="rule-browser-direction-list">
        {browserBetting.directions.map((direction) => <li key={direction.key}>
          <strong>{directionLabel(direction.key)}</strong>
          <DirectionSupport direction={direction} />
        </li>)}
      </ul>
    </section> : null}
    {loading ? <div className="rule-loading" aria-label="正在加载投注规则"><Spin /></div> : null}
    {!loading && !loadError && !items.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无投注规则"><Button disabled={contractCompatible !== true} type="primary" onClick={openCreate}>新增投注规则</Button></Empty> : null}
    {!loading && items.length ? <div className="rule-card-grid">{items.map((card) => <RuleSummaryCard key={card.cardId} card={card} onEdit={openEdit} onDelete={remove} readOnly={contractCompatible !== true} />)}</div> : null}
    <RuleCardModal editing={editing} open={modalOpen} readOnly={contractCompatible !== true} onClose={() => setModalOpen(false)} onSaved={saved} onConflictReload={reloadConflict} onConflictDeleted={conflictDeleted} />
  </div>
}
