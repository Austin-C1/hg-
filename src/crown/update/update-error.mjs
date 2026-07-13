const SAFE_CODE = /^update-[a-z0-9]+(?:-[a-z0-9]+)*$/

export class UpdateError extends Error {
  constructor(code, options = {}) {
    if (typeof code !== 'string' || !SAFE_CODE.test(code)) {
      throw new TypeError('update-error-code-invalid')
    }
    super(code, options)
    this.name = 'UpdateError'
    this.code = code
  }
}

export function updateError(code, cause) {
  return new UpdateError(code, cause === undefined ? undefined : { cause })
}

export function stableUpdateError(error, fallbackCode) {
  if (error instanceof UpdateError) return error
  return updateError(fallbackCode, error)
}

export function isUpdateCancellation(error) {
  return error instanceof Error && error.message === 'update-cancelled'
}
