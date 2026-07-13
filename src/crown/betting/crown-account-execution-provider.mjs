import {
  CROWN_CAPABILITY_MATRIX_VERSION,
  assertCrownCapability,
  getCrownCapability,
} from './crown-capability-matrix.mjs'

function identityOf(input = {}) {
  const identity = input.currentIdentity || input.lockedIdentity
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new TypeError('crown-submit-identity-required')
  }
  return identity
}

export class CrownAccountExecutionProvider {
  constructor(options = {}) {
    if (Object.keys(options).length > 0) throw new Error('crown-submit-provider-injection-forbidden')
  }

  async submit(input = {}) {
    if (Object.hasOwn(input, 'capability') || Object.hasOwn(input, 'capabilityResolver')) {
      throw new Error('crown-submit-capability-caller-forbidden')
    }
    if (String(input.capabilityVersion || '') !== CROWN_CAPABILITY_MATRIX_VERSION) {
      throw new Error('crown-capability-version-mismatch')
    }
    const identity = identityOf(input)
    const capability = getCrownCapability({
      mode: identity.mode,
      period: identity.period,
      marketType: identity.marketType,
      lineVariant: identity.lineVariant || 'main',
    })
    assertCrownCapability(capability, { operation: 'submit' })
    throw new Error('crown-submit-transport-unavailable')
  }
}

export default CrownAccountExecutionProvider
