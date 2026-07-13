const LABELS: Record<string, string> = {
  live: '滚球',
  prematch: '赛前',
  unknown: '未知',
  not_started: '未开赛',
  open: '进行中',
  closed: '已关闭',
  suspended: '暂停',
  asian_handicap: '让球',
  handicap: '让球',
  over_under: '大小球',
  moneyline: '独赢',
  total: '大小球',
  first_half: '上半场',
  second_half: '下半场',
  full_time: '全场',
  full_match: '全场',
  home: '主队',
  away: '客队',
  draw: '和局',
  over: '大',
  under: '小',
  enabled: '已启用',
  disabled: '未启用',
  blocked: '未启用',
  manual_review: '人工复核',
  monitor_only: '只监控',
  future_preview: '未来预览',
  preview_only: '预览模式',
  'preview-only': '预览模式',
  'needs-login': '需要登录',
  'missing-secret': '未保存密钥',
}

function label(value: string | null | undefined) {
  if (value === null || value === undefined || value === '') return '-'
  return LABELS[value] || value
}

export function labelMode(value: string | null | undefined) {
  return label(value)
}

export function labelStatus(value: string | null | undefined) {
  return label(value)
}

export function labelMarketType(value: string | null | undefined) {
  return label(value)
}

export function labelPeriod(value: string | null | undefined) {
  return label(value)
}

export function labelSide(value: string | null | undefined) {
  return label(value)
}

export function labelAccountStatus(value: string | null | undefined) {
  return label(value)
}
