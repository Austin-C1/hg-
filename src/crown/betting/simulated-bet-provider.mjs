function nowIso(now) {
  const value = now()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('simulated-provider-time')
  return date.toISOString()
}

function safeClone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function scriptedError(code) {
  const normalized = String(code || 'simulated-provider-error').trim() || 'simulated-provider-error'
  return Object.assign(new Error(normalized), { code: normalized })
}

export class SimulatedBetProvider {
  constructor({ script = [], now = () => new Date() } = {}) {
    if (!Array.isArray(script)) throw new TypeError('simulated-script')
    if (typeof now !== 'function') throw new TypeError('simulated-now')
    this.script = script.map((entry) => safeClone(entry))
    this.now = now
    this.calls = []
  }

  get networkCallCount() {
    return 0
  }

  assertNextOperations(operations) {
    if (!Array.isArray(operations)) throw new TypeError('simulated-operations')
    if (this.script.length < operations.length) throw scriptedError('simulated-script-exhausted')
    for (let index = 0; index < operations.length; index += 1) {
      if (this.script[index]?.operation !== operations[index]) throw scriptedError('simulated-script-operation')
    }
    return true
  }

  async run(operation, input) {
    const step = this.script[0]
    if (!step) throw scriptedError('simulated-script-exhausted')
    if (step.operation !== operation) throw scriptedError('simulated-script-operation')
    this.script.shift()

    const call = {
      operation,
      input: safeClone(input),
      startedAt: nowIso(this.now),
      finishedAt: '',
      errorCode: '',
    }
    this.calls.push(call)
    try {
      if (step.error) throw scriptedError(step.error)
      return safeClone(step.result)
    } catch (error) {
      call.errorCode = String(error?.code || 'simulated-provider-error')
      throw error
    } finally {
      call.finishedAt = nowIso(this.now)
    }
  }

  preview(input) {
    return this.run('preview', input)
  }

  submit(input) {
    return this.run('submit', input)
  }
}
