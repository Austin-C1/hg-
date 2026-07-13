const RETRY_DELAYS_SECONDS = [5, 15, 45]
const SENSITIVE_CODE = /(authorization|cookie|password|secret|session|ticket|token)/i
const SAFE_CODE = /^[a-z0-9][a-z0-9._:-]{0,63}$/

function canonicalNow(value) {
  const text = String(value ?? '').trim()
  const parsed = Date.parse(text)
  if (!text || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new TypeError('now must be a canonical UTC timestamp')
  }
  return text
}

function safeErrorCode(value, fallback = 'delivery-failed') {
  const code = String(value ?? '').trim().toLowerCase()
  if (!SAFE_CODE.test(code) || SENSITIVE_CODE.test(code)) return fallback
  return code
}

function permanentFailure(value) {
  return value?.permanent === true || ['disabled', 'missing-config', 'unsupported-market'].includes(value?.reason)
}

function timeout(promise, milliseconds) {
  let timer
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('delivery sender timed out')
      error.code = 'delivery-timeout'
      reject(error)
    }, milliseconds)
  })
  return Promise.race([Promise.resolve(promise), expired]).finally(() => clearTimeout(timer))
}

export class AlertDispatcher {
  constructor({
    store,
    senders = {},
    pollMs = 250,
    batchSize = 20,
    maxAttempts = 4,
    sendTimeoutMs = 10_000,
    leaseMs = null,
    onError = null,
  } = {}) {
    if (!store || typeof store.claimPendingDeliveries !== 'function' || typeof store.completeDelivery !== 'function') {
      throw new TypeError('dispatcher store is required')
    }
    if (!Number.isInteger(pollMs) || pollMs < 1) throw new TypeError('pollMs must be a positive integer')
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new TypeError('batchSize must be a positive integer')
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer')
    if (!Number.isInteger(sendTimeoutMs) || sendTimeoutMs < 1) throw new TypeError('sendTimeoutMs must be a positive integer')
    this.store = store
    this.senders = { ...senders }
    this.pollMs = pollMs
    this.batchSize = batchSize
    this.maxAttempts = maxAttempts
    this.sendTimeoutMs = sendTimeoutMs
    this.leaseMs = leaseMs ?? Math.max(sendTimeoutMs * 2, 1000)
    this.onError = typeof onError === 'function' ? onError : null
    this.stopped = true
    this.timer = null
    this.running = null
  }

  start() {
    if (!this.stopped) return false
    this.stopped = false
    this.schedule(0)
    return true
  }

  schedule(delay) {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
        .catch((error) => this.onError?.(error))
        .finally(() => this.schedule(this.pollMs))
    }, delay)
    this.timer.unref?.()
  }

  tick(now = new Date().toISOString()) {
    if (this.running) return this.running
    const canonical = canonicalNow(now)
    const work = this.runTick(canonical)
    this.running = work.finally(() => {
      if (this.running === work || this.running === wrapped) this.running = null
    })
    const wrapped = this.running
    return wrapped
  }

  async runTick(now) {
    const deliveries = this.store.claimPendingDeliveries({ now, limit: this.batchSize, leaseMs: this.leaseMs })
    const settled = await Promise.allSettled(deliveries.map((delivery) => this.deliver(delivery, now)))
    return {
      claimed: deliveries.length,
      sent: settled.filter((item) => item.status === 'fulfilled' && item.value?.status === 'sent').length,
      retried: settled.filter((item) => item.status === 'fulfilled' && item.value?.status === 'retry').length,
      deadLettered: settled.filter((item) => item.status === 'fulfilled' && item.value?.status === 'dead-letter').length,
      failedCompletions: settled.filter((item) => item.status === 'rejected').length,
    }
  }

  async deliver(delivery, now) {
    const sender = this.senders[delivery.channel]
    const attempts = delivery.attempts + 1
    if (typeof sender !== 'function') {
      this.store.completeDelivery({
        ...delivery,
        status: 'dead-letter',
        attempts,
        errorCode: 'channel-not-configured',
        nextAttemptAt: now,
        updatedAt: now,
      })
      return { status: 'dead-letter' }
    }

    try {
      const result = await timeout(sender(delivery.signal, { channel: delivery.channel }), this.sendTimeoutMs)
      if (result?.sent === false) {
        const error = new Error('delivery sender declined the Signal')
        error.code = result.reason || 'delivery-failed'
        error.permanent = permanentFailure(result)
        throw error
      }
      this.store.completeDelivery({
        ...delivery,
        status: 'sent',
        attempts,
        errorCode: '',
        nextAttemptAt: now,
        updatedAt: now,
      })
      return { status: 'sent' }
    } catch (error) {
      const exhausted = attempts >= this.maxAttempts
      const permanent = error?.permanent === true
      const status = exhausted || permanent ? 'dead-letter' : 'retry'
      const delaySeconds = RETRY_DELAYS_SECONDS[Math.min(attempts - 1, RETRY_DELAYS_SECONDS.length - 1)]
      const nextAttemptAt = status === 'retry'
        ? new Date(Date.parse(now) + delaySeconds * 1000).toISOString()
        : now
      this.store.completeDelivery({
        ...delivery,
        status,
        attempts,
        errorCode: safeErrorCode(error?.code),
        nextAttemptAt,
        updatedAt: now,
      })
      return { status }
    }
  }

  async stop() {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.running) await this.running
  }
}
