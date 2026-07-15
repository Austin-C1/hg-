import { Alert, Button, Select, Space, Table, Tag, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import { useEffect, useRef, useState } from 'react'

import { api } from '../services/api'
import type {
  BetTargetHistoryItem,
  BetTargetHistoryMode,
  BetTargetHistoryStatus,
} from '../types'

const statusLabels: Record<string, string> = {
  queued: '排队中', allocating: '分配中', waiting_capacity: '等待容量', submitting: '提交中',
  waiting_result: '等待确认', completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消',
}
const modeLabels: Record<string, string> = { prematch: '赛前', live: '滚球' }
const periodLabels: Record<string, string> = { full_time: '全场', first_half: '上半场' }
const marketLabels: Record<string, string> = { asian_handicap: '让球', total: '大小球' }
const sideLabels: Record<string, string> = { home: '主', away: '客', over: '大', under: '小' }

function timeText(value: string | null) {
  if (!value) return '尚未结束'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间不可用' : date.toLocaleString('zh-CN', { hour12: false })
}

function nonZero(value: string) {
  return !/^0(?:\.0+)?$/.test(value)
}

const columns: TableColumnsType<BetTargetHistoryItem> = [
  {
    title: '比赛', key: 'match', width: 230,
    render: (_, item) => <Space direction="vertical" size={0}>
      <Typography.Text strong>{item.match.leagueName}</Typography.Text>
      <Typography.Text>{item.match.homeTeam} vs {item.match.awayTeam}</Typography.Text>
    </Space>,
  },
  {
    title: '投注方向', key: 'direction', width: 250,
    render: (_, item) => [
      modeLabels[item.direction.mode] || item.direction.mode,
      periodLabels[item.direction.period] || item.direction.period,
      marketLabels[item.direction.marketType] || item.direction.marketType,
      sideLabels[item.direction.side] || item.direction.side,
      item.direction.handicapRaw,
    ].join(' · '),
  },
  {
    title: '成功平均赔率', key: 'averageAcceptedOdds', width: 150,
    render: (_, item) => <Space direction="vertical" size={0}>
      <Typography.Text strong>{item.averageAcceptedOdds ?? '暂无'}</Typography.Text>
      <Typography.Text type="secondary">{item.acceptedBetCount} 笔成功</Typography.Text>
    </Space>,
  },
  {
    title: '已完成投注金额', key: 'amount', width: 210,
    render: (_, item) => <Space direction="vertical" size={0}>
      <Typography.Text>{item.completedAmount} / {item.targetAmount} {item.currency}</Typography.Text>
      {nonZero(item.unknownAmount) ? <Typography.Text type="danger">待确认 {item.unknownAmount} {item.currency}</Typography.Text> : null}
    </Space>,
  },
  {
    title: '状态 / 时间', key: 'status', width: 220,
    render: (_, item) => <Space direction="vertical" size={0}>
      <Tag color={item.status === 'completed' ? 'green' : item.status === 'waiting_result' ? 'orange' : 'default'}>
        {statusLabels[item.status] || item.status}
      </Tag>
      <Typography.Text type="secondary">创建 {timeText(item.createdAt)}</Typography.Text>
      <Typography.Text type="secondary">结束 {timeText(item.finishedAt)}</Typography.Text>
    </Space>,
  },
]

export default function BettingHistory() {
  const [mode, setMode] = useState<BetTargetHistoryMode>('all')
  const [status, setStatus] = useState<BetTargetHistoryStatus>('all')
  const [items, setItems] = useState<BetTargetHistoryItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const requestVersion = useRef(0)

  const load = async (cursor?: string, append = false) => {
    const version = ++requestVersion.current
    setLoading(true)
    setError(false)
    if (!append) {
      setItems([])
      setNextCursor(null)
    }
    try {
      const page = await api.getBetTargetHistory({ limit: 20, cursor, status, mode })
      if (requestVersion.current !== version) return
      setItems((current) => append ? [...current, ...page.items] : page.items)
      setNextCursor(page.nextCursor)
    } catch {
      if (requestVersion.current !== version) return
      setError(true)
      if (!append) setItems([])
    } finally {
      if (requestVersion.current === version) setLoading(false)
    }
  }

  useEffect(() => { void load() }, [mode, status])

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div><Typography.Text type="secondary">真实执行账本</Typography.Text><h1>投注历史</h1><p>每行是一批真实投注目标；Preview 和 dry-run 不会出现在这里。</p></div>
        <Space wrap>
          <Select
            aria-label="比赛模式"
            value={mode}
            onChange={(value) => setMode(value)}
            options={[{ value: 'all', label: '全部模式' }, { value: 'prematch', label: '赛前' }, { value: 'live', label: '滚球' }]}
            style={{ width: 130 }}
          />
          <Select
            aria-label="投注状态"
            value={status}
            onChange={(value) => setStatus(value)}
            options={[
              { value: 'all', label: '全部状态' }, { value: 'active', label: '执行中' },
              { value: 'waiting_result', label: '等待确认' }, { value: 'completed', label: '已完成' },
              { value: 'partial', label: '部分完成' }, { value: 'failed', label: '失败 / 取消' },
            ]}
            style={{ width: 140 }}
          />
        </Space>
      </section>
      {error ? <Alert type="error" showIcon message="投注历史读取失败，请稍后重试。" /> : null}
      <section className="table-panel">
        <Table
          aria-label="投注历史列表"
          rowKey="historyKey"
          columns={columns}
          dataSource={items}
          loading={loading && items.length === 0}
          pagination={false}
          scroll={{ x: 1060 }}
          locale={{ emptyText: loading ? '正在读取投注历史…' : '暂无真实投注历史' }}
        />
        {nextCursor ? <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Button loading={loading} onClick={() => void load(nextCursor, true)}>加载更多</Button>
        </div> : null}
      </section>
    </div>
  )
}
