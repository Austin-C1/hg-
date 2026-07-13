import { CheckCircleOutlined, DeleteOutlined, DownOutlined, EditOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons'
import { Button, Empty, Form, Input, InputNumber, Modal, Popconfirm, Space, Spin, Tag, message } from 'antd'
import { useEffect, useMemo, useState } from 'react'

import { api, isDashboardAuthenticationError } from '../services/api'
import type { BetBatch, BetChildOrder, BettingAccount, BettingHistory } from '../types'
import { formatDateTime } from '../utils/formatDateTime'

interface AccountFormValues {
  username: string
  password?: string
  websiteUrl: string
  betOrder?: number
  perBetLimit: string
}

class AccountAmountFieldError extends Error {
  constructor(public field: 'perBetLimit', messageText: string) {
    super(messageText)
  }
}

function normalizeAccountAmount(value: unknown, scale: number, field: 'perBetLimit', label: string) {
  const text = String(value ?? '').trim()
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) return text
  const fraction = match[2] || ''
  if (fraction.length <= scale) return text
  if (/[1-9]/.test(fraction.slice(scale))) {
    throw new AccountAmountFieldError(field, `${label}的小数位不能超过 ${scale} 位`)
  }
  const kept = fraction.slice(0, scale)
  return kept ? `${match[1]}.${kept}` : match[1]
}

function accountSaveErrorText(error: unknown) {
  if (!(error instanceof Error)) return '保存失败'
  if (error.message === 'amount-precision') return '金额小数位与所选金额精度不一致'
  if (error.message === 'amount-positive') return '单笔上限和投注步进必须是有效的非负金额'
  return error.message
}

function formatAmount(value: number) {
  return Number(value || 0).toFixed(2)
}

function accountIdOf(history: BettingHistory) {
  return history.accountId || history.bettingAccountId || ''
}

function historyTime(history: BettingHistory) {
  return history.betTime || history.createdAt || ''
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function textValue(value: unknown) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function previewFailureDetail(history: BettingHistory) {
  const details = objectValue(history.details)
  const result = objectValue(details?.result)
  const preview = objectValue(result?.preview)
  if (!preview) return ''
  const code = textValue(preview.code)
  const error = textValue(preview.errorMessage || preview.message)
  const fastCheck = textValue(preview.fastCheck)
  const parts = []
  if (code) parts.push(`code=${code}`)
  if (error && error !== code) parts.push(error)
  if (!error && fastCheck) parts.push(`fast_check=${fastCheck}`)
  return parts.length ? ` ${parts.join(' / ')}` : ''
}

function historyStatusText(history: BettingHistory) {
  switch (history.status) {
    case 'accepted': return '已确认'
    case 'pending': return '待确认'
    case 'rejected': return '已拒绝'
    case 'submit-rejected': return '提交失败'
    case 'previewed':
    case 'dry-run-previewed': return '预览成功'
    case 'preview-rejected': return `预览失败${previewFailureDetail(history)}`
    case 'blocked': return '已拦截'
    default: return history.status || '-'
  }
}

function childStatusText(status: string) {
  const labels: Record<string, string> = {
    previewing: '预览中', reserved: '已预留', submit_prepared: '准备提交', submit_dispatched: '已发送',
    accepted: '已接受', rejected: '已拒绝', unknown: '结果未知', cancelled: '已取消',
  }
  return labels[status] || status || '-'
}

function childErrorText(child: BetChildOrder) {
  return [child.errorCode, child.errorMessage].filter(Boolean).join(' / ')
}

function executionStatusText(status: string) {
  const labels: Record<string, string> = { idle: '空闲', reserved: '已预留', submitting: '提交中', unknown: '结果未知' }
  return labels[status] || status || '-'
}

function accessStatusText(status: string) {
  const labels: Record<string, string> = { unchecked: '未检测', available: '可用', failed: '检测失败' }
  return labels[status] || '未检测'
}

function accessErrorText(code: string) {
  const labels: Record<string, string> = {
    'origin-not-allowed': '网址未加入投注账号访问白名单',
    'login-failed': '账号或密码登录失败',
    'network-failed': 'Crown 网络访问失败',
    'access-invalid': 'Crown 足球数据验证失败',
    'configuration-failed': '账号访问配置不完整',
    'access-failed': '账号检测失败',
    'betting-account-limit-required': '单笔上限必须是大于 0 的整数，请先编辑账号',
  }
  return labels[code] || code || ''
}

function normalizeWebsiteUrl(value: string) {
  const text = value.trim()
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  const url = new URL(normalized)
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('网址格式不正确')
  return url.toString().replace(/\/$/, '')
}

function sortHistoryDesc(a: BettingHistory, b: BettingHistory) {
  return new Date(historyTime(b)).getTime() - new Date(historyTime(a)).getTime()
}

function accountOrderValue(account: BettingAccount) {
  const order = Number(account.betOrder || 0)
  return Number.isFinite(order) && order > 0 ? order : Number.POSITIVE_INFINITY
}

function sortAccountsByBetOrder(accounts: BettingAccount[]) {
  return [...accounts].sort((a, b) => accountOrderValue(a) - accountOrderValue(b)
    || new Date(a.createdAt || '').getTime() - new Date(b.createdAt || '').getTime())
}

function accountOrderText(account: BettingAccount) {
  const order = Number(account.betOrder || 0)
  return Number.isFinite(order) && order > 0 ? String(order) : '未设置'
}

export default function BettingAccounts() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getBettingAccountOverview>> | null>(null)
  const [batches, setBatches] = useState<BetBatch[]>([])
  const [childrenByBatch, setChildrenByBatch] = useState<Record<string, BetChildOrder[]>>({})
  const [childrenLoaded, setChildrenLoaded] = useState(false)
  const [childrenLoading, setChildrenLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<BettingAccount | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [checkingId, setCheckingId] = useState('')
  const [allocationActionId, setAllocationActionId] = useState('')
  const [form] = Form.useForm<AccountFormValues>()

  async function load() {
    setLoading(true)
    try {
      const [overview, recent] = await Promise.all([api.getBettingAccountOverview(), api.getBetBatches()])
      setData(overview)
      setBatches(recent.items)
      setChildrenLoading(true)
      try {
        const rows = await Promise.all(recent.items.map(async (batch) => [batch.batchId, (await api.getBetBatchChildren(batch.batchId)).items] as const))
        setChildrenByBatch(Object.fromEntries(rows))
        setChildrenLoaded(true)
      } catch (error) {
        setChildrenByBatch({})
        setChildrenLoaded(false)
        message.error(error instanceof Error ? error.message : '子订单加载失败')
      } finally {
        setChildrenLoading(false)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const historyByAccount = useMemo(() => {
    const map = new Map<string, BettingHistory[]>()
    for (const item of data?.bettingHistory || []) {
      const accountId = accountIdOf(item)
      if (!accountId) continue
      const list = map.get(accountId) || []
      list.push(item)
      map.set(accountId, list)
    }
    for (const list of map.values()) list.sort(sortHistoryDesc)
    return map
  }, [data?.bettingHistory])

  const childrenByAccount = useMemo(() => {
    const map = new Map<string, BetChildOrder[]>()
    for (const child of Object.values(childrenByBatch).flat()) {
      const list = map.get(child.accountId) || []
      list.push(child)
      map.set(child.accountId, list)
    }
    return map
  }, [childrenByBatch])

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setOpen(true)
  }

  function openEdit(account: BettingAccount) {
    setEditing(account)
    form.setFieldsValue({
      username: account.username, websiteUrl: account.websiteUrl, betOrder: account.betOrder || undefined,
      password: '', perBetLimit: account.perBetLimit,
    })
    setOpen(true)
  }

  async function loadChildren() {
    if (childrenLoaded || childrenLoading) return
    setChildrenLoading(true)
    try {
      const rows = await Promise.all(batches.map(async (batch) => [batch.batchId, (await api.getBetBatchChildren(batch.batchId)).items] as const))
      setChildrenByBatch(Object.fromEntries(rows))
      setChildrenLoaded(true)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '子订单加载失败')
    } finally {
      setChildrenLoading(false)
    }
  }

  function toggleAccount(accountId: string) {
    const opening = !expandedIds.has(accountId)
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(accountId)) next.delete(accountId)
      else next.add(accountId)
      return next
    })
    if (opening) void loadChildren()
  }

  async function save(values: AccountFormValues) {
    try {
      const username = values.username.trim()
      const payload: Partial<BettingAccount> & { secret?: string } = {
        label: username,
        username,
        websiteUrl: normalizeWebsiteUrl(values.websiteUrl),
        betOrder: Number(values.betOrder || 0),
        status: editing?.status || 'enabled',
        perBetLimit: normalizeAccountAmount(values.perBetLimit, 0, 'perBetLimit', '单笔上限'),
        currency: 'CNY',
      }
      const password = String(values.password || '')
      if (password) payload.secret = password
      if (editing) await api.updateBettingAccount(editing.id, payload)
      else await api.createBettingAccount({ ...payload, secret: password })
      setOpen(false)
      setEditing(null)
      form.resetFields()
      await load()
    } catch (error) {
      const text = accountSaveErrorText(error)
      if (error instanceof AccountAmountFieldError) form.setFields([{ name: error.field, errors: [text] }])
      message.error(text)
    }
  }

  async function remove(account: BettingAccount) {
    await api.deleteBettingAccount(account.id)
    setExpandedIds((current) => { const next = new Set(current); next.delete(account.id); return next })
    await load()
  }

  async function checkAccess(account: BettingAccount) {
    if (checkingId) return
    setCheckingId(account.id)
    try {
      const response = await api.checkBettingAccountAccess(account.id)
      setData((current) => current ? {
        ...current,
        bettingAccounts: current.bettingAccounts.map((item) => item.id === account.id ? response.item : item),
      } : current)
      if (response.result.ok) message.success(`账号 ${account.username} 登录访问检测成功`)
      else message.error(accessErrorText(response.result.errorCode))
    } catch (error) {
      if (!isDashboardAuthenticationError(error)) {
        message.error(error instanceof Error ? accessErrorText(error.message) : '账号检测失败')
      }
    } finally {
      setCheckingId('')
    }
  }

  function allocationStatusOf(account: BettingAccount) {
    return account.allocationStatus || (account.status === 'enabled' ? 'enabled' : 'paused')
  }

  function allocationStatusText(status: BettingAccount['allocationStatus']) {
    return ({ enabled: '已启用', pause_pending: '暂停中', paused: '已暂停', checking: '检测中' } as const)[status] || '已暂停'
  }

  async function changeAllocation(account: BettingAccount) {
    if (allocationActionId) return
    setAllocationActionId(account.id)
    try {
      const status = allocationStatusOf(account)
      const response = status === 'enabled'
        ? await api.pauseBettingAccount(account.id)
        : await api.enableBettingAccount(account.id)
      setData((current) => current ? {
        ...current,
        bettingAccounts: current.bettingAccounts.map((item) => item.id === account.id ? { ...item, ...response.item } : item),
      } : current)
      if (status !== 'enabled') {
        const enableResponse = response as Awaited<ReturnType<typeof api.enableBettingAccount>>
        if (!enableResponse.result.ok) message.error(accessErrorText(enableResponse.result.errorCode || 'access-failed'))
      }
    } catch (error) {
      if (!isDashboardAuthenticationError(error)) message.error(error instanceof Error ? accessErrorText(error.message) : '账号状态更新失败')
    } finally {
      setAllocationActionId('')
    }
  }

  const accounts = sortAccountsByBetOrder(data?.bettingAccounts || [])

  return (
    <div className="page-stack">
      <div className="page-title"><div><h1>投注账号配置</h1><p>维护账号顺序与单笔上限，启用前会重新验证 Crown 访问和余额。</p></div></div>
      <div className="account-safety-note"><strong>账号启用控制订单分配</strong><span>启用账号只会加入订单分配，不会开启全局真实投注。</span></div>
      <div className="panel">
        <div className="actions-row"><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增投注账号</Button></div>
        <Spin spinning={loading}>
          {loading && !data ? <div className="account-loading-hint">正在读取投注账号…</div> : accounts.length ? <div className="config-card-list">
            {accounts.map((account) => {
              const allocationStatus = allocationStatusOf(account)
              const histories = historyByAccount.get(account.id) || []
              const children = childrenByAccount.get(account.id) || []
              const acceptedTodayCount = Number.isSafeInteger(account.acceptedTodayCount) && account.acceptedTodayCount >= 0
                ? `${account.acceptedTodayCount} 次`
                : '-'
              const acceptedTodayAmount = typeof account.acceptedTodayAmount === 'string' && account.acceptedTodayAmount.length > 0
                ? `${account.acceptedTodayAmount} ${account.currency}`
                : '-'
              const expanded = expandedIds.has(account.id)
              const limitValue = Number(account.perBetLimit)
              const limitReady = Number.isSafeInteger(limitValue) && limitValue > 0
              return <div className="account-card-shell" key={account.id}>
                <div className={`horizontal-config-card account-card${expanded ? ' expanded' : ''}`} role="button" tabIndex={0} aria-label={`账号卡片 ${account.username}`} onClick={() => toggleAccount(account.id)} onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleAccount(account.id) }
                }}>
                  <div className="config-card-main">
                    <div>
                      <div className="config-card-title">{account.username || '未命名账号'} <Tag color={allocationStatus === 'enabled' ? 'green' : allocationStatus === 'pause_pending' || allocationStatus === 'checking' ? 'gold' : 'default'}>{allocationStatusText(allocationStatus)}</Tag></div>
                      <div className="config-card-subtitle">投注顺序：{accountOrderText(account)}</div>
                      <div className="config-card-subtitle">{account.websiteUrl || '-'}</div>
                      <div className="config-card-subtitle">单笔上限：{account.perBetLimit} {account.currency}</div>
                      {!limitReady ? <div className="config-card-subtitle"><Tag color="red">单笔上限必须大于 0，编辑后才能启用</Tag></div> : null}
                      <div className="config-card-subtitle">登录访问：{accessStatusText(account.accessStatus)}{account.accessErrorCode ? `（${accessErrorText(account.accessErrorCode)}）` : ''}</div>
                      <div className="config-card-subtitle">Crown 返回余额：{account.reportedBalance == null ? '未获取' : `${account.reportedBalance} ${account.reportedCurrency || account.currency}`}</div>
                      <div className="config-card-subtitle">分配状态：{allocationStatusText(allocationStatus)} · 执行锁：{executionStatusText(account.executionStatus)}</div>
                    </div>
                    <div className="config-card-metrics">
                      <div className="config-metric"><span>今日 accepted 次数</span><strong>{acceptedTodayCount}</strong></div>
                      <div className="config-metric"><span>今日 accepted 金额</span><strong>{acceptedTodayAmount}</strong></div>
                    </div>
                  </div>
                  <Space className="config-card-actions" onClick={(event) => event.stopPropagation()}>
                    <Button
                      type={allocationStatus === 'enabled' ? 'default' : 'primary'}
                      aria-label={`${allocationStatus === 'enabled' ? '暂停账号' : !limitReady ? '先设置单笔上限' : '启用账号'} ${account.username}`}
                      loading={allocationActionId === account.id}
                      disabled={Boolean(allocationActionId) || allocationStatus === 'pause_pending' || allocationStatus === 'checking' || (allocationStatus !== 'enabled' && !limitReady) || (allocationStatus === 'paused' && account.executionStatus !== 'idle')}
                      onClick={() => void changeAllocation(account)}
                    >{allocationStatus === 'enabled' ? '暂停账号' : allocationStatus === 'pause_pending' ? '暂停中' : allocationStatus === 'checking' ? '检测中' : !limitReady ? '先设置单笔上限' : '启用账号'}</Button>
                    <Button aria-label={`检测账号 ${account.username}`} loading={checkingId === account.id} icon={<CheckCircleOutlined />} onClick={() => void checkAccess(account)}>检测账号</Button>
                    <Button aria-label={expanded ? `收起账号 ${account.username}` : `展开账号 ${account.username}`} icon={expanded ? <DownOutlined /> : <RightOutlined />} onClick={() => toggleAccount(account.id)} />
                    <Button icon={<EditOutlined />} onClick={() => openEdit(account)}>编辑</Button>
                    <Popconfirm title="删除投注账号" description="确定删除该账号？历史投注记录将保留。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => remove(account)}>
                      <Button danger icon={<DeleteOutlined />}>删除</Button>
                    </Popconfirm>
                  </Space>
                </div>
                {expanded && <div className="account-history-panel">
                  <Spin spinning={childrenLoading}>
                    <h3>执行子订单</h3>
                    {children.length ? <div className="history-list">
                      <div className="history-row history-header"><span>子订单</span><span>状态 / 错误</span><span>请求金额</span><span>预览额度</span><span>赔率 / Provider</span><span>结果时间</span></div>
                      {children.map((child) => <div className="history-row" key={child.childOrderId}>
                        <span>{child.childOrderId}</span>
                        <span><span>{childStatusText(child.status)}</span>{childErrorText(child) && <span>{childErrorText(child)}</span>}</span>
                        <span>{child.requestedAmount} {child.currency}</span>
                        <span>
                          <span>最低 {child.previewMinStake} {child.currency}</span>
                          <span>最高 {child.previewMaxStake} {child.currency}</span>
                          <span>余额 {child.previewBalance === null ? '-' : `${child.previewBalance} ${child.currency}`}</span>
                          <span>步进 {child.previewStakeStep} {child.currency}</span>
                        </span>
                        <span><span>{child.previewOdds || '-'}</span><span>{child.providerReference || '-'}</span></span>
                        <span>{formatDateTime(child.resolvedAt || child.createdAt)}</span>
                      </div>)}
                    </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无执行子订单" />}
                  </Spin>
                  <h3>历史投注</h3>
                  {histories.length ? <div className="history-list">
                    <div className="history-row history-header"><span>联赛名字</span><span>比赛队伍</span><span>投注盘口</span><span>状态</span><span>投注金额</span><span>投注时间</span></div>
                    {histories.map((item) => <div className="history-row" key={item.id}>
                      <span>{item.leagueName || '-'}</span><span>{item.teams || '-'}</span><span>{item.market || item.handicap || '-'}</span>
                      <span>{historyStatusText(item)}</span><span>{formatAmount(item.amount)}</span><span>{formatDateTime(historyTime(item))}</span>
                    </div>)}
                  </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无历史投注" />}
                </div>}
              </div>
            })}
          </div> : <Empty description="暂无投注账号" />}
        </Spin>
      </div>

      <Modal title={editing ? '编辑投注账号' : '新增投注账号'} open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="username" label="账号" rules={[{ required: true, whitespace: true, message: '请输入账号' }]}><Input autoComplete="username" /></Form.Item>
          <Form.Item name="password" label="密码" rules={editing ? [] : [{ required: true, whitespace: true, message: '请输入密码' }]}><Input.Password placeholder={editing ? '留空则不修改' : '请输入密码'} autoComplete="new-password" /></Form.Item>
          <Form.Item name="websiteUrl" label="网址" rules={[{ required: true, whitespace: true, message: '请输入网址' }, { validator(_, value) {
            if (!value) return Promise.resolve()
            try { normalizeWebsiteUrl(String(value)); return Promise.resolve() } catch { return Promise.reject(new Error('网址格式不正确')) }
          } }]}><Input placeholder="https://..." /></Form.Item>
          <Form.Item name="betOrder" label="投注顺序" extra="模拟执行只选择已启用且序号大于 0 的账号。"><InputNumber min={0} precision={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="perBetLimit" label="单笔上限（CNY 整数）" rules={[{ required: true, pattern: /^[1-9]\d*$/, message: '请输入正整数金额' }]}><Input inputMode="numeric" /></Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
