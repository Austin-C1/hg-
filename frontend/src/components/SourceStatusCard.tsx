import { Alert } from 'antd'

import type { OddsSummary } from '../types'
import { formatDateTime } from '../utils/formatDateTime'

const XML_LIVE_STALE_MS = 2 * 60 * 1000

function latestTimestamp(values: Array<string | null | undefined>) {
  let latest: string | null = null
  let latestMs = -Infinity
  for (const value of values) {
    const parsed = Date.parse(value || '')
    if (!Number.isFinite(parsed) || parsed <= latestMs) continue
    latest = value || null
    latestMs = parsed
  }
  return latest
}

function liveTimestamp(summary: OddsSummary) {
  return latestTimestamp([
    summary.dataSource?.lastXmlAt,
    summary.dataSource?.lastSnapshotAt,
    summary.lastCapturedAt,
    summary.dataOrigin?.runtime?.updatedAt,
  ])
}

function isStaleLiveTimestamp(value: string | null | undefined) {
  if (!value) return true
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return true
  return Date.now() - timestamp > XML_LIVE_STALE_MS
}

function status(summary: OddsSummary) {
  const dataSource = summary.dataSource
  const eventCount = dataSource?.eventCount ?? summary.totals.events ?? 0
  const timestamp = liveTimestamp(summary)
  const lastUpdated = formatDateTime(timestamp)

  if (
    dataSource?.kind === 'xml-live' ||
    dataSource?.kind === 'monitor-v2' ||
    dataSource?.label === 'XML live' ||
    summary.source === 'monitor-v2'
  ) {
    if (isStaleLiveTimestamp(timestamp)) {
      return {
        type: 'error' as const,
        message: '赔率更新异常',
        description: `最近更新：${lastUpdated}｜超过 2 分钟未更新｜今日比赛：${eventCount} 场`,
      }
    }

    return {
      type: 'success' as const,
      message: '实时赔率正常',
      description: `最近更新：${lastUpdated}｜今日比赛：${eventCount} 场`,
    }
  }

  if (dataSource?.kind === 'dom-fallback' || dataSource?.label === 'DOM fallback') {
    return {
      type: 'warning' as const,
      message: '使用备用数据',
      description: `XML 暂无稳定响应，当前使用页面 DOM 备份数据｜今日比赛：${eventCount} 场`,
    }
  }

  return {
    type: 'warning' as const,
    message: '离线样本',
    description: `当前不是实时数据，仅用于调试展示｜今日比赛：${eventCount} 场`,
  }
}

export function SourceStatusCard({ summary }: { summary: OddsSummary | null }) {
  if (!summary) return null
  const next = status(summary)
  return <Alert type={next.type} showIcon message={next.message} description={next.description} />
}
