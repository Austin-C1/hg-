import { Button, Drawer, Input, Space, Table, Tag, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { SourceStatusCard } from '../components/SourceStatusCard'
import { api } from '../services/api'
import type { LeagueSummary, OddsChange, OddsEvent, OddsSummary } from '../types'
import { formatDateTime } from '../utils/formatDateTime'
import { labelMarketType, labelMode, labelPeriod, labelSide, labelStatus } from '../utils/crownLabels'

interface EventRow extends OddsEvent {
  leagueTracked: boolean
  leagueTrackingSource: LeagueSummary['trackingSource']
  prematchEventCount: number
  liveEventCount: number
}

const MATCH_REFRESH_MS = 30_000

function trackingText(row: EventRow) {
  if (!row.leagueTracked) return '未追踪'
  if (row.leagueTrackingSource === 'default') return '白名单追踪'
  return '手动追踪'
}

function trackingColor(row: EventRow) {
  if (!row.leagueTracked) return 'default'
  if (row.leagueTrackingSource === 'default') return 'green'
  return 'blue'
}

function changeTypeText(type: string | null | undefined) {
  if (type === 'odds-change') return '赔率变化'
  if (type === 'handicap-change') return '盘值变化'
  return '其他变化'
}

function dataQualityText(reason: string) {
  if (reason === 'start_time_missing') return '数据不完整：缺少开赛时间'
  if (reason === 'live_clock_missing') return '数据不完整：缺少滚球时间'
  return `数据不完整：${reason}`
}

function DataQualityTags({ reasons = [] }: { reasons?: string[] }) {
  if (!reasons.length) return null
  return (
    <div className="data-quality-tags">
      {reasons.map((reason) => <Tag color="orange" key={reason}>{dataQualityText(reason)}</Tag>)}
    </div>
  )
}

function isVisibleChangeMarket(change: OddsChange) {
  return change.marketType === 'asian_handicap' || change.marketType === 'total'
}

function changeSubject(row: OddsChange) {
  return [labelMarketType(row.marketType), labelPeriod(row.period), labelSide(row.side)]
    .filter((item) => item !== '-')
    .join(' / ') || '-'
}

function changeValue(row: OddsChange, side: 'old' | 'new') {
  const handicap = side === 'old' ? row.oldHandicapRaw : row.newHandicapRaw
  const odds = side === 'old' ? row.oldOddsRaw : row.newOddsRaw
  const sideText = labelSide(row.side)
  const oddsText = [sideText === '-' ? null : sideText, odds ?? null].filter(Boolean).join(' ')
  return [handicap ?? row.handicapRaw, oddsText].filter(Boolean).join(' · ') || '-'
}

function changeRowKey(row: OddsChange) {
  return row.key || `${row.eventKey}:${row.type}:${row.capturedAt}:${row.side || ''}`
}

function changeTimeValue(row: OddsChange) {
  const parsed = Date.parse(row.capturedAt || '')
  return Number.isFinite(parsed) ? parsed : 0
}

function mergeChangeLists(existing: OddsChange[] = [], incoming: OddsChange[] = []) {
  const byKey = new Map<string, OddsChange>()
  for (const row of existing) byKey.set(changeRowKey(row), row)
  for (const row of incoming) byKey.set(changeRowKey(row), row)
  return [...byKey.values()].sort((a, b) => changeTimeValue(b) - changeTimeValue(a))
}

function kickoffMilliseconds(event: OddsEvent) {
  const value = Date.parse(event.startTimeUtc || '')
  return Number.isFinite(value) ? value : null
}

function compareKickoffAscending(left: OddsEvent, right: OddsEvent) {
  const leftTime = kickoffMilliseconds(left)
  const rightTime = kickoffMilliseconds(right)
  if (leftTime !== null && rightTime !== null) {
    const difference = leftTime - rightTime
    if (difference) return difference
  } else if (leftTime !== null) {
    return -1
  } else if (rightTime !== null) {
    return 1
  }
  return left.eventKey.localeCompare(right.eventKey)
}

function timeQualityColor(value?: OddsEvent['timeQuality']) {
  if (value === 'high') return 'green'
  if (value === 'inferred') return 'blue'
  if (value === 'invalid') return 'red'
  return 'default'
}

export default function MatchSelection() {
  const [items, setItems] = useState<LeagueSummary[]>([])
  const [eventChangesByKey, setEventChangesByKey] = useState<Record<string, OddsChange[]>>({})
  const [oddsSummary, setOddsSummary] = useState<OddsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [changeLoadingEventKey, setChangeLoadingEventKey] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<EventRow | null>(null)
  const selectedEventKeyRef = useRef<string | null>(null)
  const hasListDataRef = useRef(false)
  const listInFlightRef = useRef<Promise<void> | null>(null)
  const eventChangesByKeyRef = useRef<Record<string, OddsChange[]>>({})
  const eventChangesInFlightRef = useRef(new Map<string, Promise<void>>())

  const load = useCallback(() => {
    if (listInFlightRef.current) return listInFlightRef.current
    const showLoading = !hasListDataRef.current
    if (showLoading) setLoading(true)
    const request = api.getLeagueSummaries().then((payload) => {
      setItems(payload.items)
      setOddsSummary(payload.oddsSummary)
      hasListDataRef.current = true
    }).finally(() => {
      if (listInFlightRef.current === request) listInFlightRef.current = null
      if (showLoading) setLoading(false)
    })
    listInFlightRef.current = request
    return request
  }, [])

  const loadEventChanges = useCallback((eventKey: string) => {
    const inFlight = eventChangesInFlightRef.current.get(eventKey)
    if (inFlight) return inFlight
    const hasCachedChanges = Object.prototype.hasOwnProperty.call(eventChangesByKeyRef.current, eventKey)
    if (!hasCachedChanges) setChangeLoadingEventKey(eventKey)
    const request = api.changes({ eventKey, limit: 1000 }).then((payload) => {
      const next = {
        ...eventChangesByKeyRef.current,
        [eventKey]: mergeChangeLists(eventChangesByKeyRef.current[eventKey], payload.items),
      }
      eventChangesByKeyRef.current = next
      setEventChangesByKey(next)
    }).finally(() => {
      if (eventChangesInFlightRef.current.get(eventKey) === request) {
        eventChangesInFlightRef.current.delete(eventKey)
      }
      if (!hasCachedChanges) {
        setChangeLoadingEventKey((current) => (current === eventKey ? null : current))
      }
    })
    eventChangesInFlightRef.current.set(eventKey, request)
    return request
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      void load()
      const eventKey = selectedEventKeyRef.current
      if (eventKey) void loadEventChanges(eventKey)
    }, MATCH_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load, loadEventChanges])

  useEffect(() => {
    const eventKey = selected?.eventKey ?? null
    selectedEventKeyRef.current = eventKey
    if (eventKey) void loadEventChanges(eventKey)
  }, [loadEventChanges, selected?.eventKey])

  const allEvents = useMemo<EventRow[]>(() => {
    return items.flatMap((league) => league.events.map((event) => ({
      ...event,
      leagueTracked: league.tracked,
      leagueTrackingSource: league.trackingSource,
      prematchEventCount: league.prematchEventCount,
      liveEventCount: league.liveEventCount,
    }))).sort(compareKickoffAscending)
  }, [items])

  const filteredEvents = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return allEvents
    return allEvents.filter((event) => [
      event.league,
      event.homeTeam,
      event.awayTeam,
      event.mode,
    ].some((value) => String(value || '').toLowerCase().includes(keyword)))
  }, [allEvents, search])

  const trackingEvents = filteredEvents.filter((event) => event.leagueTracked)
  const selectedChanges = useMemo(() => {
    if (!selected) return []
    return (eventChangesByKey[selected.eventKey] || []).filter((change) => (
      (change.type === 'odds-change' || change.type === 'handicap-change') &&
      isVisibleChangeMarket(change)
    ))
  }, [eventChangesByKey, selected])

  async function toggleLeague(row: EventRow) {
    try {
      if (row.leagueTracked && row.leagueTrackingSource === 'manual') {
        await api.untrackLeague(row.league)
        message.success('已取消今日追踪')
      } else {
        await api.trackLeague(row.league)
        message.success('已加入今日追踪')
      }
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  const columns: ColumnsType<EventRow> = [
    { title: '联赛', dataIndex: 'league', minWidth: 220 },
    { title: '比赛', minWidth: 220, render: (_, row) => `${row.homeTeam} vs ${row.awayTeam}` },
    { title: '开赛时间（北京时间）', dataIndex: 'startTimeBeijing', width: 190, render: (value) => value || '-' },
    {
      title: '时间质量',
      dataIndex: 'timeQuality',
      width: 100,
      render: (value) => <Tag color={timeQualityColor(value)}>{value || 'missing'}</Tag>,
    },
    {
      title: '时间诊断',
      width: 190,
      render: (_, row) => row.timeWarnings?.length
        ? <div className="data-quality-tags">{row.timeWarnings.map((warning) => <Tag color="orange" key={warning}>{warning}</Tag>)}</div>
        : '-',
    },
    { title: '模式', dataIndex: 'mode', width: 90, render: (value) => <Tag color={value === 'live' ? 'red' : 'blue'}>{labelMode(value)}</Tag> },
    {
      title: '状态',
      dataIndex: 'status',
      minWidth: 210,
      render: (value, row) => <>{labelStatus(value)}<DataQualityTags reasons={row.dataQuality?.reasons} /></>,
    },
    { title: '赔率数', dataIndex: 'selectionCount', width: 90 },
    { title: '追踪状态', width: 130, render: (_, row) => <Tag color={trackingColor(row)}>{trackingText(row)}</Tag> },
    { title: '最近更新', dataIndex: 'lastCapturedAt', width: 190, render: (value) => formatDateTime(value) },
    {
      title: '操作',
      width: 190,
      render: (_, row) => (
        <Space>
          <Button type="link" onClick={() => setSelected(row)}>详情</Button>
          <Button
            type={row.leagueTracked ? 'default' : 'primary'}
            disabled={row.leagueTracked && row.leagueTrackingSource === 'default'}
            onClick={() => toggleLeague(row)}
          >
            {row.leagueTracked ? '取消追踪' : '追踪联赛'}
          </Button>
        </Space>
      ),
    },
  ]

  const changeColumns: ColumnsType<OddsChange> = [
    { title: '变化时间', dataIndex: 'capturedAt', width: 180, render: (value) => formatDateTime(value) },
    { title: '类型', dataIndex: 'type', width: 100, render: (value) => changeTypeText(value) },
    { title: '变化项目', width: 160, render: (_, row) => changeSubject(row) },
    { title: '变化前', width: 180, render: (_, row) => changeValue(row, 'old') },
    { title: '变化后', width: 180, render: (_, row) => changeValue(row, 'new') },
  ]

  return (
    <div className="page-stack">
      <div className="page-title">
        <div>
          <h1>比赛选择</h1>
          <p>上方是今日正在追踪的比赛，下方是今日全部比赛。</p>
        </div>
      </div>

      <SourceStatusCard summary={oddsSummary} />

      <div className="panel filter-bar one">
        <Input.Search placeholder="搜索联赛或球队" allowClear value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>

      <div className="panel">
        <div className="section-header">
          <div>
            <h2>今日追踪比赛</h2>
            <p>由默认联赛白名单和手动追踪联赛共同决定。</p>
          </div>
          <Tag color="blue">{trackingEvents.length} 场</Tag>
        </div>
        <Table rowKey="eventKey" loading={loading} columns={columns} dataSource={trackingEvents} pagination={{ pageSize: 8 }} scroll={{ x: 1700 }} />
      </div>

      <div className="panel">
        <div className="section-header">
          <div>
            <h2>今日全部比赛</h2>
            <p>优先使用 XML live 数据；XML live 没有时才显示 DOM fallback。</p>
          </div>
          <Tag>{filteredEvents.length} 场</Tag>
        </div>
        <Table rowKey="eventKey" loading={loading} columns={columns} dataSource={filteredEvents} pagination={{ pageSize: 10 }} scroll={{ x: 1700 }} />
      </div>

      <Drawer title={selected ? `${selected.homeTeam} vs ${selected.awayTeam}` : '比赛详情'} open={Boolean(selected)} onClose={() => setSelected(null)} width={860}>
        <DataQualityTags reasons={selected?.dataQuality?.reasons} />
        <Table
          rowKey={changeRowKey}
          columns={changeColumns}
          dataSource={selectedChanges}
          loading={Boolean(selected && changeLoadingEventKey === selected.eventKey)}
          pagination={{ pageSize: 12 }}
          scroll={{ x: 800 }}
          locale={{ emptyText: '暂无记录到的赔率变化' }}
        />
      </Drawer>
    </div>
  )
}
