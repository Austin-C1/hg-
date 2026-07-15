import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import AutoBetRules, { RuleCardModal } from './AutoBetRules'
import { CONTRACT_COMPATIBILITY_EVENT, api, isContractCompatible } from '../services/api'
import type { AutoBettingRuleCard, TodayBettingLeague } from '../types'
import { browserBettingSummary } from '../test/browserBettingFixture'

const card: AutoBettingRuleCard = {
  cardId: 'card-premier', name: '英超主规则', enabled: true, leagueNames: ['英超'],
  targetOddsMin: '0.80', targetOddsMax: '1.05', targetAmountMinor: 100,
  currency: 'CNY', amountScale: 0, remark: '主规则', realEligible: false,
  realEligibilityVersion: 2, migrationReviewRequired: false, migrationReviewReason: '',
  version: 3, createdAt: '2026-07-12T00:00:00Z', updatedAt: '2026-07-12T01:00:00Z',
  recentSignal: 'Signal：已命中', recentBatch: '批次：已完成', recentResult: '结果：已接受',
}

const leagues: TodayBettingLeague[] = [
  { leagueName: '英超', source: 'default', todayMatchCount: 3, ownerCardId: 'card-premier', ownerCardName: '英超主规则', selectable: true, availableToday: true },
  { leagueName: '西甲', source: 'manual', todayMatchCount: 2, ownerCardId: 'card-spain', ownerCardName: '西甲规则', selectable: false, availableToday: true },
  { leagueName: '德甲', source: 'both', todayMatchCount: 1, ownerCardId: null, ownerCardName: null, selectable: true, availableToday: true },
]

vi.mock('../services/api', () => ({
  APP_CONTRACT_VERSION: 'dynamic-betting-cards-v1',
  CONTRACT_COMPATIBILITY_EVENT: 'crown:contract-compatibility-changed',
  isContractCompatible: vi.fn(() => true),
  isDashboardAuthenticationError: (error: unknown) => error instanceof Error && error.message === 'authentication-required',
  api: {
    sessionBootstrap: vi.fn(async () => ({ appContractVersion: 'dynamic-betting-cards-v1', schemaVersion: 'dynamic-betting-cards-v1' })),
    getAutoBettingRuleCards: vi.fn(async () => ({ items: [card] })),
    getTodayBettingLeagues: vi.fn(async () => ({ items: leagues })),
    createAutoBettingRuleCard: vi.fn(async (payload) => ({ ...card, ...payload, cardId: 'card-new', version: 1 })),
    updateAutoBettingRuleCard: vi.fn(async (_id, payload) => ({ ...card, ...payload, version: payload.expectedVersion + 1 })),
    deleteAutoBettingRuleCard: vi.fn(async () => ({ ok: true as const })),
    getOperationsSummary: vi.fn(async () => ({ item: { browserBetting: browserBettingSummary } })),
  },
}))

async function openCreate() {
  render(<AutoBetRules />)
  await screen.findByRole('heading', { name: '英超主规则' })
  fireEvent.click(screen.getByRole('button', { name: '新增投注规则' }))
  const dialog = screen.getByRole('dialog', { name: '新增投注规则' })
  await waitFor(() => expect(within(dialog).getByRole('combobox', { name: '联赛' })).not.toBeDisabled())
  return dialog
}

function fillRequired(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByLabelText('规则名称'), { target: { value: '德甲规则' } })
  fireEvent.change(within(dialog).getByLabelText('目标水位下限'), { target: { value: '000.800' } })
  fireEvent.change(within(dialog).getByLabelText('目标水位上限'), { target: { value: '01.0500' } })
  fireEvent.change(within(dialog).getByLabelText('目标投注金额（CNY）'), { target: { value: '120' } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('AutoBetRules', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getAutoBettingRuleCards).mockResolvedValue({ items: [card] })
    vi.mocked(api.getTodayBettingLeagues).mockResolvedValue({ items: leagues })
    vi.mocked(api.sessionBootstrap).mockResolvedValue({ appContractVersion: 'dynamic-betting-cards-v1', schemaVersion: 'dynamic-betting-cards-v1' })
    vi.mocked(isContractCompatible).mockReturnValue(true)
  })

  test('closes an open modal and keeps mutation transport at zero when compatibility changes', async () => {
    await openCreate()
    vi.mocked(isContractCompatible).mockReturnValue(false)
    act(() => window.dispatchEvent(new Event(CONTRACT_COMPATIBILITY_EVENT)))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('Dashboard 已升级，请重启')).toBeInTheDocument()
    expect(api.createAutoBettingRuleCard).not.toHaveBeenCalled()
    expect(api.updateAutoBettingRuleCard).not.toHaveBeenCalled()
    expect(api.deleteAutoBettingRuleCard).not.toHaveBeenCalled()
  })

  test.each([
    {},
    { appContractVersion: 'old-v1', schemaVersion: 'dynamic-betting-cards-v1' },
    { appContractVersion: 'dynamic-betting-cards-v1', schemaVersion: 'old-v1' },
  ])('proactively blocks all rule mutations when the page contract is missing or mismatched', async (security) => {
    vi.mocked(api.sessionBootstrap).mockResolvedValueOnce(security)
    render(<AutoBetRules />)
    expect(await screen.findByText('Dashboard 已升级，请重启')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新增投注规则' })).toBeDisabled()
    expect(await screen.findByRole('button', { name: '编辑英超主规则' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '删除英超主规则' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '新增投注规则' }))
    fireEvent.click(screen.getByRole('button', { name: '删除英超主规则' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.createAutoBettingRuleCard).not.toHaveBeenCalled()
    expect(api.updateAutoBettingRuleCard).not.toHaveBeenCalled()
    expect(api.deleteAutoBettingRuleCard).not.toHaveBeenCalled()
  })

  test('renders dynamic summary cards with the exact page copy and recent activity', async () => {
    render(<AutoBetRules />)
    expect(await screen.findByRole('heading', { name: '英超主规则' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '投注规则' })).toBeInTheDocument()
    expect(screen.getByText('报警命中后，按所选联赛独立创建同盘口线对面盘投注任务')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新增投注规则' })).toBeInTheDocument()
    expect(screen.queryByText('赛前投注')).not.toBeInTheDocument()
    expect(screen.queryByText('滚球投注')).not.toBeInTheDocument()
    for (const text of ['英超', '0.80 — 1.05', '100 CNY', '真实执行资格：未具备', '迁移已复核', 'Signal：已命中', '批次：已完成', '结果：已接受']) {
      expect(screen.getByText(text)).toBeInTheDocument()
    }
  })

  test('shows only backend-computed direction support badges and no editable wire fields', async () => {
    render(<AutoBetRules />)
    const support = await screen.findByRole('region', { name: '浏览器方向支持' })
    expect(within(support).getAllByText(/Preview/)).toHaveLength(8)
    expect(within(support).getAllByText(/Submit/)).toHaveLength(8)
    expect(within(support).getByText('赛前 · 让球 · 客')).toBeInTheDocument()
    expect(screen.queryByLabelText(/wire|rtype|wtype|uid|ver/i)).not.toBeInTheDocument()
  })

  test('create modal requires a league and marks another card ownership', async () => {
    const dialog = await openCreate()
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: '联赛' }))
    await screen.findByRole('option', { name: /西甲.*手动.*西甲规则/ })
    expect(screen.getByTitle('西甲 · 手动 · 2 场 · 已被西甲规则使用')).toHaveClass('ant-select-item-option-disabled')
    fillRequired(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: '保存规则' }))
    expect(await within(dialog).findByText('请至少选择一个联赛')).toBeInTheDocument()
    expect(api.createAutoBettingRuleCard).not.toHaveBeenCalled()
  })

  test('creates with exact fields only and canonical decimal values', async () => {
    const dialog = await openCreate()
    fillRequired(dialog)
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: '联赛' }))
    fireEvent.click(await screen.findByText(/德甲.*默认.*手动/))
    fireEvent.click(within(dialog).getByRole('button', { name: '保存规则' }))
    await waitFor(() => expect(api.createAutoBettingRuleCard).toHaveBeenCalledWith({
      name: '德甲规则', enabled: true, leagueNames: ['德甲'], targetOddsMin: '0.8',
      targetOddsMax: '1.05', targetAmountMinor: 120, remark: '',
    }))
  })

  test.each(['1e2', '+100', ' 100 ', '1.0', '00100', '9007199254740992', '9'.repeat(100_000)])('rejects non-canonical amount %s', async (value) => {
    const dialog = await openCreate()
    fillRequired(dialog)
    fireEvent.change(within(dialog).getByLabelText('目标投注金额（CNY）'), { target: { value } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存规则' }))
    expect(await within(dialog).findByText('目标投注金额必须是大于 0 的 CNY 正整数')).toBeInTheDocument()
    expect(api.createAutoBettingRuleCard).not.toHaveBeenCalled()
  })

  test('keeps own stale league editable and labels it unavailable today', async () => {
    vi.mocked(api.getTodayBettingLeagues).mockResolvedValueOnce({ items: [
      { ...leagues[0], source: 'stale', availableToday: false, todayMatchCount: 0, selectable: true },
      leagues[1],
    ] })
    render(<AutoBetRules />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑英超主规则' }))
    const dialog = screen.getByRole('dialog', { name: '编辑投注规则' })
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: '联赛' })).not.toBeDisabled())
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: '联赛' }))
    await screen.findByRole('option', { name: /英超.*今日不可用/ })
    expect(screen.getByTitle('英超 · 历史保留 · 今日不可用')).not.toHaveClass('ant-select-item-option-disabled')
    expect(within(dialog).getByRole('combobox', { name: '联赛' })).toHaveAttribute('aria-expanded', 'true')
  })

  test('rolls the edit draft back on CAS conflict', async () => {
    vi.mocked(api.updateAutoBettingRuleCard).mockRejectedValueOnce(Object.assign(new Error('auto-betting-card-version-conflict'), { status: 409 }))
    render(<AutoBetRules />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑英超主规则' }))
    const dialog = screen.getByRole('dialog', { name: '编辑投注规则' })
    fireEvent.change(within(dialog).getByLabelText('规则名称'), { target: { value: '错误草稿' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存规则' }))
    expect(await within(dialog).findByText('配置已被其他页面更新，请刷新后重试')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('规则名称')).toHaveValue('英超主规则')
    expect(api.updateAutoBettingRuleCard).toHaveBeenCalledWith('card-premier', expect.objectContaining({ expectedVersion: 3 }))
  })

  test('reloads the current server card and leagues after CAS conflict', async () => {
    const latest = { ...card, name: '服务端最新规则', targetAmountMinor: 260, version: 4 }
    vi.mocked(api.updateAutoBettingRuleCard).mockRejectedValueOnce(Object.assign(new Error('auto-betting-card-version-conflict'), { status: 409 }))
    vi.mocked(api.getAutoBettingRuleCards).mockResolvedValueOnce({ items: [card] }).mockResolvedValueOnce({ items: [latest] })
    render(<AutoBetRules />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑英超主规则' }))
    const dialog = screen.getByRole('dialog', { name: '编辑投注规则' })
    fireEvent.change(within(dialog).getByLabelText('规则名称'), { target: { value: '本地旧草稿' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存规则' }))
    expect(await within(dialog).findByDisplayValue('服务端最新规则')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('目标投注金额（CNY）')).toHaveValue('260')
    expect(api.getTodayBettingLeagues).toHaveBeenLastCalledWith('card-premier')
    fireEvent.click(within(dialog).getByRole('button', { name: '保存规则' }))
    await waitFor(() => expect(api.updateAutoBettingRuleCard).toHaveBeenLastCalledWith('card-premier', expect.objectContaining({ expectedVersion: 4 })))
  })

  test('closes the modal and refreshes when a CAS card was deleted', async () => {
    vi.mocked(api.updateAutoBettingRuleCard).mockRejectedValueOnce(Object.assign(new Error('auto-betting-card-version-conflict'), { status: 409 }))
    vi.mocked(api.getAutoBettingRuleCards).mockResolvedValueOnce({ items: [card] }).mockResolvedValueOnce({ items: [] })
    render(<AutoBetRules />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑英超主规则' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '编辑投注规则' })).getByRole('button', { name: '保存规则' }))
    expect(await screen.findByText('该规则已被删除，请刷新页面。')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '编辑投注规则' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '英超主规则' })).not.toBeInTheDocument()
  })

  test('projects league ownership conflicts to the league field', async () => {
    vi.mocked(api.updateAutoBettingRuleCard).mockRejectedValueOnce(Object.assign(new Error('配置已被其他页面更新，请刷新后重试'), {
      status: 409,
      payload: { error: 'league-owned-by-another-card', fields: { leagueNames: ['英超'], ownerName: '并发规则' } },
    }))
    render(<AutoBetRules />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑英超主规则' }))
    const dialog = screen.getByRole('dialog', { name: '编辑投注规则' })
    fireEvent.change(within(dialog).getByLabelText('规则名称'), { target: { value: '保留本地草稿' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存规则' }))
    expect(await within(dialog).findByText('所选联赛已被其他规则占用，请重新选择。')).toBeInTheDocument()
    expect(within(dialog).getByText(/英超.*并发规则/)).toBeInTheDocument()
    expect(within(dialog).getByLabelText('规则名称')).toHaveValue('保留本地草稿')
    expect(api.getAutoBettingRuleCards).toHaveBeenCalledTimes(1)
  })

  test.each([
    [new Error('authentication-required'), '请先登录 Dashboard 后再操作。'],
    [new Error('contract-version-mismatch'), '前后端版本不一致，请刷新页面或重启 Dashboard。'],
    [new Error('reload-network-failed'), 'reload-network-failed'],
  ])('keeps the draft usable when CAS reload fails: %s', async (reloadFailure, expected) => {
    vi.mocked(api.updateAutoBettingRuleCard).mockRejectedValueOnce(Object.assign(new Error('auto-betting-card-version-conflict'), { status: 409 }))
    vi.mocked(api.getAutoBettingRuleCards).mockResolvedValueOnce({ items: [card] }).mockRejectedValueOnce(reloadFailure)
    render(<AutoBetRules />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑英超主规则' }))
    const dialog = screen.getByRole('dialog', { name: '编辑投注规则' })
    fireEvent.change(within(dialog).getByLabelText('规则名称'), { target: { value: '未丢失草稿' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存规则' }))
    expect(await within(dialog).findByText(expected)).toBeInTheDocument()
    expect(within(dialog).getByLabelText('规则名称')).toHaveValue('未丢失草稿')
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: '联赛' })).not.toBeDisabled())
  })

  test('closes and refreshes on an actual card not-found response', async () => {
    vi.mocked(api.updateAutoBettingRuleCard).mockRejectedValueOnce(Object.assign(new Error('auto-betting-card-not-found'), {
      status: 404, payload: { error: 'auto-betting-card-not-found' },
    }))
    vi.mocked(api.getAutoBettingRuleCards).mockResolvedValueOnce({ items: [card] }).mockResolvedValueOnce({ items: [] })
    render(<AutoBetRules />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑英超主规则' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '编辑投注规则' })).getByRole('button', { name: '保存规则' }))
    expect(await screen.findByText('该规则已被删除，请刷新页面。')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '编辑投注规则' })).not.toBeInTheDocument()
    await waitFor(() => expect(api.getAutoBettingRuleCards).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('heading', { name: '英超主规则' })).not.toBeInTheDocument()
  })

  test('clears old league options while a new modal scope loads and ignores stale responses', async () => {
    const late = deferred<{ items: TodayBettingLeague[] }>()
    vi.mocked(api.getTodayBettingLeagues)
      .mockResolvedValueOnce({ items: leagues })
      .mockImplementationOnce(() => late.promise)
      .mockResolvedValueOnce({ items: [{ ...leagues[0], source: 'stale', availableToday: false, todayMatchCount: 0 }] })
    render(<AutoBetRules />)
    fireEvent.click(await screen.findByRole('button', { name: '新增投注规则' }))
    const create = screen.getByRole('dialog', { name: '新增投注规则' })
    fireEvent.click(within(create).getByRole('button', { name: /取.*消/ }))
    fireEvent.click(screen.getByRole('button', { name: '编辑英超主规则' }))
    const edit = screen.getByRole('dialog', { name: '编辑投注规则' })
    const select = within(edit).getByRole('combobox', { name: '联赛' })
    expect(select).toBeDisabled()
    expect(screen.queryByTitle('西甲 · 手动 · 2 场 · 已被西甲规则使用')).not.toBeInTheDocument()
    fireEvent.click(within(edit).getByRole('button', { name: /取.*消/ }))
    fireEvent.click(screen.getByRole('button', { name: '编辑英超主规则' }))
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: '编辑投注规则' })).getByRole('combobox', { name: '联赛' })).not.toBeDisabled())
    await act(async () => late.resolve({ items: leagues }))
    fireEvent.mouseDown(within(screen.getByRole('dialog', { name: '编辑投注规则' })).getByRole('combobox', { name: '联赛' }))
    expect(await screen.findByRole('option', { name: /英超.*今日不可用/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /西甲/ })).not.toBeInTheDocument()
  })

  test('allows only one save in flight and locks modal dismissal', async () => {
    const pending = deferred<AutoBettingRuleCard>()
    vi.mocked(api.updateAutoBettingRuleCard).mockImplementationOnce(() => pending.promise)
    render(<AutoBetRules />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑英超主规则' }))
    const dialog = screen.getByRole('dialog', { name: '编辑投注规则' })
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: '联赛' })).not.toBeDisabled())
    const save = within(dialog).getByRole('button', { name: '保存规则' })
    fireEvent.click(save); fireEvent.click(save)
    await waitFor(() => expect(api.updateAutoBettingRuleCard).toHaveBeenCalledTimes(1))
    expect(within(dialog).getByRole('button', { name: /取.*消/ })).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    await act(async () => pending.resolve({ ...card, version: 4 }))
  })

  test('ignores an old save response after the modal scope closes and reopens', async () => {
    const pending = deferred<AutoBettingRuleCard>()
    vi.mocked(api.updateAutoBettingRuleCard).mockImplementationOnce(() => pending.promise)
    const onSaved = vi.fn()
    const props = { onClose: vi.fn(), onSaved, onConflictReload: vi.fn(), onConflictDeleted: vi.fn() }
    const { rerender } = render(<RuleCardModal {...props} editing={card} open />)
    const edit = await screen.findByRole('dialog', { name: '编辑投注规则' })
    await waitFor(() => expect(within(edit).getByRole('combobox', { name: '联赛' })).not.toBeDisabled())
    fireEvent.click(within(edit).getByRole('button', { name: '保存规则' }))
    await waitFor(() => expect(api.updateAutoBettingRuleCard).toHaveBeenCalledTimes(1))
    rerender(<RuleCardModal {...props} editing={null} open={false} />)
    rerender(<RuleCardModal {...props} editing={null} open />)
    expect(await screen.findByRole('dialog', { name: '新增投注规则' })).toBeInTheDocument()
    await act(async () => pending.resolve({ ...card, version: 4 }))
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '新增投注规则' })).toBeInTheDocument()
  })

  test('drops a selected league that is now owned by another card', async () => {
    vi.mocked(api.getTodayBettingLeagues).mockResolvedValueOnce({ items: [{ ...leagues[0], selectable: false, ownerCardId: 'other', ownerCardName: '并发规则' }] })
    render(<AutoBetRules />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑英超主规则' }))
    const dialog = screen.getByRole('dialog', { name: '编辑投注规则' })
    expect(await within(dialog).findByText(/英超.*并发规则/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '保存规则' }))
    expect(api.updateAutoBettingRuleCard).not.toHaveBeenCalled()
  })

  test('submits by Enter and focuses the first invalid field', async () => {
    const dialog = await openCreate()
    fireEvent.keyDown(within(dialog).getByLabelText('规则名称'), { key: 'Enter', code: 'Enter' })
    expect(await within(dialog).findByText('请输入规则名称')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('规则名称')).toHaveFocus()
    expect(within(dialog).getByLabelText('规则名称')).toHaveAttribute('aria-invalid', 'true')
    for (const [label, errorId] of [
      ['目标水位下限', 'rule-odds-min-error'],
      ['目标水位上限', 'rule-odds-max-error'],
      ['目标投注金额（CNY）', 'rule-amount-error'],
    ]) {
      expect(within(dialog).getByLabelText(label)).toHaveAttribute('aria-describedby', errorId)
      expect(document.getElementById(errorId)).toBeInTheDocument()
    }
  })

  test('submits an exact edit payload through the form', async () => {
    render(<AutoBetRules />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑英超主规则' }))
    const dialog = screen.getByRole('dialog', { name: '编辑投注规则' })
    fireEvent.submit(dialog.querySelector('form')!)
    await waitFor(() => expect(api.updateAutoBettingRuleCard).toHaveBeenCalledWith('card-premier', {
      expectedVersion: 3, name: '英超主规则', enabled: true, leagueNames: ['英超'],
      targetOddsMin: '0.8', targetOddsMax: '1.05', targetAmountMinor: 100, remark: '主规则',
    }))
  })

  test('maps migration review errors to Chinese', async () => {
    vi.mocked(api.updateAutoBettingRuleCard).mockRejectedValueOnce(new Error('migration-review-required'))
    render(<AutoBetRules />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑英超主规则' }))
    const dialog = screen.getByRole('dialog', { name: '编辑投注规则' })
    fireEvent.submit(dialog.querySelector('form')!)
    expect(await within(dialog).findByText('该规则需要完成迁移复核后才能启用。')).toBeInTheDocument()
  })

  test('physically deletes after confirmation and releases its league option', async () => {
    let deleted = false
    vi.mocked(api.deleteAutoBettingRuleCard).mockImplementationOnce(async () => { deleted = true; return { ok: true } })
    vi.mocked(api.getTodayBettingLeagues).mockImplementation(async () => ({ items: deleted ? [
      { ...leagues[0], ownerCardId: null, ownerCardName: null, selectable: true },
    ] : leagues }))
    render(<AutoBetRules />)
    fireEvent.click(await screen.findByRole('button', { name: '删除英超主规则' }))
    expect(screen.getByText('确定删除该规则？')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确 定' }))
    await waitFor(() => expect(api.deleteAutoBettingRuleCard).toHaveBeenCalledWith('card-premier', 3))
    expect(screen.queryByRole('heading', { name: '英超主规则' })).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '新增投注规则' })[0])
    expect(api.getTodayBettingLeagues).toHaveBeenLastCalledWith()
    const dialog = screen.getByRole('dialog', { name: '新增投注规则' })
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: '联赛' })).not.toBeDisabled())
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: '联赛' }))
    expect(await screen.findByTitle('英超 · 默认 · 3 场')).not.toHaveClass('ant-select-item-option-disabled')
  })

  test.each([
    [new Error('authentication-required'), '请先登录 Dashboard 后再操作。'],
    [new Error('contract-version-mismatch'), '前后端版本不一致，请刷新页面或重启 Dashboard。'],
  ])('shows safe mutation error %s', async (failure, expected) => {
    vi.mocked(api.deleteAutoBettingRuleCard).mockRejectedValueOnce(failure)
    render(<AutoBetRules />)
    fireEvent.click(await screen.findByRole('button', { name: '删除英超主规则' }))
    fireEvent.click(screen.getByRole('button', { name: '确 定' }))
    expect(await screen.findByText(expected)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '英超主规则' })).toBeInTheDocument()
  })

  test('renders loading, error and empty states', async () => {
    vi.mocked(api.getAutoBettingRuleCards).mockRejectedValueOnce(new Error('load-failed'))
    const { rerender } = render(<AutoBetRules />)
    expect(screen.getByLabelText('正在加载投注规则')).toBeInTheDocument()
    expect(await screen.findByText('load-failed')).toBeInTheDocument()
    vi.mocked(api.getAutoBettingRuleCards).mockResolvedValueOnce({ items: [] })
    rerender(<AutoBetRules key="empty" />)
    expect(await screen.findByText('暂无投注规则')).toBeInTheDocument()
  })

})
