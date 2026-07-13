const TRUSTED_UPDATE_KEYS = Object.freeze(Object.create(null))

const GITHUB_RELEASE_SOURCE = Object.freeze({
  owner: 'Austin-C1',
  repository: 'hg-',
  apiUrl: 'https://api.github.com/repos/Austin-C1/hg-/releases',
})

export const RELEASE_CONFIG = Object.freeze({
  schemaVersion: 1,
  appId: 'crown-monitor',
  channel: 'private-beta',
  packageType: 'update',
  updaterVersion: '0.1.0',
  github: GITHUB_RELEASE_SOURCE,
  trustedKeys: TRUSTED_UPDATE_KEYS,
})
