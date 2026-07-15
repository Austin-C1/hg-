import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import { CROWN_BROWSER_TARGETS } from '../betting-protocol/protocol-classifier.mjs'
import { decryptSecret } from '../app/app-secret.mjs'
import {
  CROWN_CAPABILITY_MATRIX_VERSION,
  getCrownCapability,
  listCrownCapabilities,
} from './crown-capability-matrix.mjs'

const SCHEMA_VERSION = 'crown-browser-api-acceptance-v1'
const RUNTIME_STATES = new WeakMap()
const AUTHORITIES = new WeakSet()
const DISPATCH_PERMITS = new WeakSet()
const SETTLEMENT_PERMITS = new WeakSet()
const CANDIDATE_CLAIMS = new WeakMap()
const VALIDATION_DEADLINE_MS = 120_000
const VALIDATION_BACKOFF_SECONDS = [5, 15, 45]

function dbOf(database) {
  const db = database?.db || database
  if (!db?.prepare || !db?.exec) throw new TypeError('acceptance-database-required')
  return db
}

function required(value, code) {
  const text = String(value ?? '').trim()
  if (!text) throw new TypeError(code)
  return text
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function stableJson(value) {
  return JSON.stringify(stable(value))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function manifestHmac(manifest, secretKey) {
  return createHmac('sha256', required(secretKey, 'acceptance-secret-key-required'))
    .update(stableJson(manifest), 'utf8').digest('hex')
}

function sameHmac(left, right) {
  const a = Buffer.from(String(left || ''), 'hex')
  const b = Buffer.from(String(right || ''), 'hex')
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b)
}

function directionShape(value = {}) {
  const side = value.selectionSide ?? value.side
  return {
    id: required(value.id || `${value.mode}-full-time-${value.marketType === 'asian_handicap' ? 'asian-handicap' : value.marketType}-${side}`, 'acceptance-direction-id'),
    mode: required(value.mode, 'acceptance-direction-mode'),
    period: required(value.period, 'acceptance-direction-period'),
    marketType: required(value.marketType, 'acceptance-direction-market'),
    lineVariant: required(value.lineVariant, 'acceptance-direction-line-variant'),
    selectionSide: required(side, 'acceptance-direction-side'),
  }
}

function directionKey(value) {
  const direction = directionShape(value)
  return [direction.mode, direction.period, direction.marketType, direction.lineVariant, direction.selectionSide].join('|')
}

function canonicalCapability(direction) {
  const row = getCrownCapability(directionShape(direction))
  if (!row || row.evidenceStatus !== 'verified' || row.previewAllowed !== true) {
    throw new Error('acceptance-canonical-direction-required')
  }
  return row
}

function acceptanceSubmitCapability(direction) {
  const capability = canonicalCapability(direction)
  const acceptedEvidence = listCrownCapabilities().find((row) => row.submitAllowed === true)
  if (!acceptedEvidence?.mapperEvidence?.wireDefaults?.submit
    || !Array.isArray(acceptedEvidence.submitResponseFieldSet)
    || acceptedEvidence.submitResponseFieldSet.length === 0) {
    throw new Error('acceptance-submit-evidence-unavailable')
  }
  return {
    ...structuredClone(capability),
    mapperEvidence: {
      ...structuredClone(capability.mapperEvidence),
      wireDefaults: {
        ...structuredClone(capability.mapperEvidence?.wireDefaults || {}),
        submit: structuredClone(acceptedEvidence.mapperEvidence.wireDefaults.submit),
      },
    },
    responseFieldSets: {
      ...structuredClone(capability.responseFieldSets || {}),
      submit: structuredClone(acceptedEvidence.submitResponseFieldSet),
    },
    submitResponseFieldSet: structuredClone(acceptedEvidence.submitResponseFieldSet),
    submitResponseFieldSetFingerprint: acceptedEvidence.submitResponseFieldSetFingerprint,
    executionEvidenceSchema: acceptedEvidence.executionEvidenceSchema,
    submitAllowed: true,
  }
}

function assertManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.capabilityVersion !== CROWN_CAPABILITY_MATRIX_VERSION
    || !Array.isArray(value.directions) || value.directions.length !== 8) {
    throw new Error('acceptance-manifest-invalid')
  }
  const ids = new Set()
  const keys = new Set()
  for (const [index, raw] of value.directions.entries()) {
    const direction = directionShape(raw)
    if (raw.ordinal !== index + 1 || ids.has(direction.id) || keys.has(directionKey(direction))) {
      throw new Error('acceptance-manifest-directions')
    }
    ids.add(direction.id)
    keys.add(directionKey(direction))
    const capability = canonicalCapability(direction)
    if (raw.capabilityEvidenceId !== capability.evidenceId
      || raw.protocolEvidenceDigest !== capability.protocolEvidenceDigest) {
      throw new Error('acceptance-manifest-evidence')
    }
  }
  const expected = CROWN_BROWSER_TARGETS.map(directionKey)
  if (stableJson(value.directions.map(directionKey)) !== stableJson(expected)) {
    throw new Error('acceptance-manifest-directions')
  }
  const content = { ...value }
  delete content.campaignId
  if (value.campaignId !== sha256(stableJson(content))) throw new Error('acceptance-manifest-id')
  return value
}

export function createCrownBrowserAcceptanceManifest({
  capabilityVersion = CROWN_CAPABILITY_MATRIX_VERSION,
  directions = CROWN_BROWSER_TARGETS,
} = {}) {
  if (capabilityVersion !== CROWN_CAPABILITY_MATRIX_VERSION) throw new Error('acceptance-capability-version')
  if (!Array.isArray(directions) || directions.length !== 8) throw new Error('acceptance-eight-directions-required')
  const normalized = directions.map((raw, index) => {
    const direction = directionShape(raw)
    const capability = canonicalCapability(direction)
    return {
      ...direction,
      ordinal: index + 1,
      capabilityEvidenceId: capability.evidenceId,
      protocolEvidenceDigest: capability.protocolEvidenceDigest,
    }
  })
  const body = { schemaVersion: SCHEMA_VERSION, capabilityVersion, directions: normalized }
  const manifest = { ...body, campaignId: sha256(stableJson(body)) }
  assertManifest(manifest)
  return manifest
}

function memoryState(state) {
  assertManifest(state)
  let runtime = RUNTIME_STATES.get(state)
  if (!runtime) {
    runtime = {
      status: 'active',
      claims: new Map(),
      cases: new Map(state.directions.map((direction) => [direction.id, []])),
    }
    RUNTIME_STATES.set(state, runtime)
  }
  return runtime
}

function exactDirection(state, direction) {
  const input = directionShape(direction)
  const expected = state.directions.find((item) => item.id === input.id)
  if (!expected || directionKey(expected) !== directionKey(input)) throw new Error('acceptance-direction-not-in-manifest')
  return expected
}

export function claimAcceptanceDirection(state, direction) {
  const runtime = memoryState(state)
  if (runtime.status === 'terminal_unknown') throw new Error('acceptance-terminal-unknown')
  if (runtime.status === 'completed') throw new Error('acceptance-completed')
  const expected = exactDirection(state, direction)
  const cases = runtime.cases.get(expected.id)
  if (cases.some((entry) => entry.kind === 'accepted')) throw new Error('acceptance-direction-already-accepted')
  if ([...runtime.claims.values()].some((entry) => entry.directionId === expected.id && !entry.settled)) {
    throw new Error('acceptance-direction-in-flight')
  }
  const claim = { claimId: randomUUID(), directionId: expected.id, settled: false }
  runtime.claims.set(claim.claimId, claim)
  return { claimId: claim.claimId, direction: { ...expected } }
}

export function settleAcceptanceDirection(state, result = {}) {
  const runtime = memoryState(state)
  const claim = runtime.claims.get(required(result.claimId, 'acceptance-claim-id'))
  if (!claim) throw new Error('acceptance-claim-not-found')
  if (claim.settled) throw new Error('acceptance-claim-settled')
  const direction = exactDirection(state, result.direction)
  if (direction.id !== claim.directionId) throw new Error('acceptance-claim-direction')
  const kind = required(result.kind, 'acceptance-outcome')
  if (!['accepted', 'rejected', 'unknown', 'pre-dispatch-cancelled'].includes(kind)) {
    throw new Error('acceptance-outcome')
  }
  const amountMinor = Number(result.amountMinor)
  if (kind === 'pre-dispatch-cancelled') {
    if (amountMinor !== 0) throw new Error('acceptance-pre-dispatch-amount')
  } else if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) {
    throw new Error('acceptance-amount')
  }
  claim.settled = true
  runtime.cases.get(direction.id).push({ kind, amountMinor, claimId: claim.claimId })
  if (kind === 'unknown') runtime.status = 'terminal_unknown'
  else if (state.directions.every((item) => runtime.cases.get(item.id).some((entry) => entry.kind === 'accepted'))) {
    runtime.status = 'completed'
  }
  return inspectAcceptanceState(state)
}

export function inspectAcceptanceState(state) {
  const runtime = memoryState(state)
  const all = [...runtime.cases.values()].flat()
  const accepted = all.filter((entry) => entry.kind === 'accepted')
  return {
    status: runtime.status,
    acceptedCount: accepted.length,
    uniqueDirectionCount: [...runtime.cases.values()].filter((entries) => entries.some((entry) => entry.kind === 'accepted')).length,
    submitDispatchCount: all.filter((entry) => entry.kind !== 'pre-dispatch-cancelled').length,
    rejectedCount: all.filter((entry) => entry.kind === 'rejected').length,
    unknownCount: all.filter((entry) => entry.kind === 'unknown').length,
    duplicateAttemptCount: Math.max(0, accepted.length - new Set(accepted.map((entry) => entry.claimId)).size),
    authorizedMinimumTotalMinor: accepted.reduce((sum, entry) => sum + entry.amountMinor, 0),
  }
}

function campaignRow(db, campaignId) {
  return db.prepare('SELECT * FROM crown_browser_acceptance_campaigns WHERE campaign_id=?').get(campaignId)
}

function verifyStoredCampaign(db, manifest, secretKey) {
  assertManifest(manifest)
  const row = campaignRow(db, manifest.campaignId)
  if (!row) throw new Error('acceptance-campaign-not-found')
  let stored
  try { stored = JSON.parse(row.manifest_json) } catch { throw new Error('acceptance-manifest-hmac') }
  const expected = manifestHmac(stored, secretKey)
  if (!sameHmac(row.manifest_hmac, expected) || stableJson(stored) !== stableJson(manifest)) {
    throw new Error('acceptance-manifest-hmac')
  }
  return row
}

export function initializeCrownBrowserAcceptanceCampaign(database, {
  manifest = createCrownBrowserAcceptanceManifest(),
  secretKey,
  now = () => new Date(),
} = {}) {
  const db = dbOf(database)
  assertManifest(manifest)
  const nowValue = now()
  const at = (nowValue instanceof Date ? nowValue : new Date(nowValue)).toISOString()
  const hmac = manifestHmac(manifest, secretKey)
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = campaignRow(db, manifest.campaignId)
    if (existing) {
      verifyStoredCampaign(db, manifest, secretKey)
    } else {
      const active = db.prepare("SELECT campaign_id FROM crown_browser_acceptance_campaigns WHERE status='active'").get()
      if (active) throw new Error('acceptance-campaign-already-active')
      db.prepare(`INSERT INTO crown_browser_acceptance_campaigns (
        campaign_id,schema_version,capability_version,manifest_json,manifest_hmac,status,created_at,updated_at
      ) VALUES (?,?,?,?,?,'active',?,?)`).run(
        manifest.campaignId, manifest.schemaVersion, manifest.capabilityVersion,
        stableJson(manifest), hmac, at, at,
      )
      const insert = db.prepare(`INSERT INTO crown_browser_acceptance_cases (
        campaign_id,direction_id,case_version,ordinal,mode,period,market_type,line_variant,
        selection_side,protocol_evidence_digest,capability_evidence_id,state,created_at,updated_at
      ) VALUES (?,?,1,?,?,?,?,?,?,?,?,'pending',?,?)`)
      for (const direction of manifest.directions) {
        insert.run(
          manifest.campaignId, direction.id, direction.ordinal, direction.mode, direction.period,
          direction.marketType, direction.lineVariant, direction.selectionSide,
          direction.protocolEvidenceDigest, direction.capabilityEvidenceId, at, at,
        )
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
  return inspectCrownBrowserAcceptanceCampaign(db, { manifest, secretKey })
}

export function inspectCrownBrowserAcceptanceCampaign(database, { manifest, secretKey } = {}) {
  const db = dbOf(database)
  const row = verifyStoredCampaign(db, manifest, secretKey)
  const cases = db.prepare(`SELECT direction_id,case_version,ordinal,state,authorized_min_minor,
    dispatch_count,outcome,child_order_id,submit_attempt_id,execution_candidate_digest,
    validation_poll_count,validation_next_poll_at,validation_deadline_at,result_evidence_digest
    FROM crown_browser_acceptance_cases WHERE campaign_id=? ORDER BY ordinal,case_version`).all(manifest.campaignId)
  const accepted = cases.filter((item) => item.state === 'accepted')
  return {
    schemaVersion: row.schema_version,
    campaignId: row.campaign_id,
    status: row.status,
    acceptedCount: accepted.length,
    uniqueDirectionCount: new Set(accepted.map((item) => item.direction_id)).size,
    submitDispatchCount: cases.reduce((sum, item) => sum + Number(item.dispatch_count), 0),
    rejectedCount: cases.filter((item) => item.state === 'rejected').length,
    unknownCount: cases.filter((item) => item.state === 'unknown').length,
    duplicateAttemptCount: cases.filter((item) => item.submit_attempt_id).length
      - new Set(cases.filter((item) => item.submit_attempt_id).map((item) => item.submit_attempt_id)).size,
    authorizedMinimumTotalMinor: accepted.reduce((sum, item) => sum + Number(item.authorized_min_minor), 0),
    cases,
  }
}

function assertCatalog(candidateCatalog) {
  if (!Array.isArray(candidateCatalog) || candidateCatalog.length !== 8) throw new Error('acceptance-candidate-catalog')
  const canonical = listCrownCapabilities()
  for (const row of canonical) {
    const candidate = candidateCatalog.find((item) => item.key === row.key)
    if (!candidate || candidate.evidenceId !== row.evidenceId
      || candidate.protocolEvidenceDigest !== row.protocolEvidenceDigest) {
      throw new Error('acceptance-candidate-catalog')
    }
  }
}

function latestCase(db, campaignId, directionId) {
  return db.prepare(`SELECT * FROM crown_browser_acceptance_cases
    WHERE campaign_id=? AND direction_id=? ORDER BY case_version DESC LIMIT 1`).get(campaignId, directionId)
}

function nextPendingCase(db, campaignId) {
  return db.prepare(`SELECT current.* FROM crown_browser_acceptance_cases current
    WHERE current.campaign_id=?
      AND current.case_version=(SELECT MAX(versioned.case_version)
        FROM crown_browser_acceptance_cases versioned
        WHERE versioned.campaign_id=current.campaign_id AND versioned.direction_id=current.direction_id)
      AND NOT EXISTS (SELECT 1 FROM crown_browser_acceptance_cases accepted
        WHERE accepted.campaign_id=current.campaign_id
          AND accepted.direction_id=current.direction_id AND accepted.state='accepted')
    ORDER BY current.ordinal LIMIT 1`).get(campaignId)
}

function candidateOwnership(authority, manifest, claim, direction = null) {
  const ownership = CANDIDATE_CLAIMS.get(claim)
  if (!ownership || ownership.authority !== authority
    || ownership.campaignId !== manifest.campaignId
    || (direction && ownership.directionId !== direction.id)) {
    throw new Error('acceptance-candidate-claim-required')
  }
  return ownership
}

function acceptancePreviewSnapshot(raw = {}) {
  const preview = raw.executionPreview
  if (!preview || typeof preview !== 'object') throw new Error('acceptance-preview-contract')
  const lockedIdentity = raw.lockedIdentity
  if (!lockedIdentity || typeof lockedIdentity !== 'object') throw new Error('acceptance-preview-contract')
  return stable({
    accountId: required(raw.accountId, 'acceptance-preview-account'),
    contextGeneration: required(raw.browserSession?.contextGeneration, 'acceptance-preview-context-generation'),
    capabilityEvidenceId: required(raw.capabilityEvidenceId, 'acceptance-preview-capability'),
    capabilityVersion: required(raw.capabilityVersion, 'acceptance-preview-capability-version'),
    lockedIdentity,
    preview: {
      minStakeMinor: preview.minStakeMinor,
      maxStakeMinor: preview.maxStakeMinor,
      stakeStepMinor: preview.stakeStepMinor ?? null,
      odds: String(preview.odds ?? ''),
      line: String(preview.line ?? ''),
      submitCon: String(preview.submitCon ?? ''),
      submitRatio: String(preview.submitRatio ?? ''),
      currency: String(preview.currency ?? ''),
      amountScale: preview.amountScale,
    },
  })
}

function rotatePendingPreviewCase(db, manifest, ownership) {
  const at = new Date().toISOString()
  db.exec('BEGIN IMMEDIATE')
  try {
    const cancelled = db.prepare(`UPDATE crown_browser_acceptance_cases
      SET state='cancelled',outcome='pre-dispatch-cancelled',updated_at=?
      WHERE campaign_id=? AND direction_id=? AND case_version=? AND state='pending'
        AND dispatch_count=0 AND submit_attempt_id=''`).run(
      at, manifest.campaignId, ownership.directionId, ownership.caseVersion,
    )
    if (cancelled.changes !== 1) throw new Error('acceptance-preview-drift-race')
    db.prepare(`INSERT INTO crown_browser_acceptance_cases (
      campaign_id,direction_id,case_version,ordinal,mode,period,market_type,line_variant,
      selection_side,protocol_evidence_digest,capability_evidence_id,state,
      frozen_preview_json,context_generation,created_at,updated_at
    ) SELECT campaign_id,direction_id,case_version+1,ordinal,mode,period,market_type,line_variant,
      selection_side,protocol_evidence_digest,capability_evidence_id,'pending','{}','',?,?
      FROM crown_browser_acceptance_cases
      WHERE campaign_id=? AND direction_id=? AND case_version=?`).run(
      at, at, manifest.campaignId, ownership.directionId, ownership.caseVersion,
    )
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
}

function exactManifestDirection(manifest, input) {
  const direction = directionShape(input)
  const expected = manifest.directions.find((item) => item.id === direction.id)
  if (!expected || directionKey(expected) !== directionKey(direction)) throw new Error('acceptance-direction-not-in-manifest')
  return expected
}

export function claimAcceptanceDispatchInTransaction(database, input = {}) {
  if (!DISPATCH_PERMITS.has(input)) throw new Error('acceptance-worker-authority-required')
  const db = dbOf(database)
  const direction = input.direction
  const row = latestCase(db, input.campaignId, direction.id)
  if (!row || row.state !== 'pending' || Number(row.dispatch_count) !== 0) throw new Error('acceptance-direction-permit-unavailable')
  const attempt = db.prepare(`SELECT attempt.child_order_id,attempt.amount_minor,attempt.capability_version,
    attempt.capability_evidence_id,attempt.execution_candidate_digest,attempt.status,child.account_id
    ,attempt.preview_snapshot_json
    FROM bet_submit_attempts attempt
    JOIN bet_child_orders child ON child.child_order_id=attempt.child_order_id
    WHERE attempt.submit_attempt_id=?`).get(input.submitAttemptId)
  if (!attempt || attempt.child_order_id !== input.childOrderId || attempt.status !== 'submit_prepared'
    || Number(attempt.amount_minor) !== input.amountMinor
    || attempt.capability_version !== input.capabilityVersion
    || attempt.capability_evidence_id !== input.capabilityEvidenceId
    || attempt.execution_candidate_digest !== input.executionCandidateDigest) {
    throw new Error('acceptance-attempt-binding-mismatch')
  }
  let preview
  try { preview = JSON.parse(attempt.preview_snapshot_json) } catch { throw new Error('acceptance-preview-binding-mismatch') }
  if (!Number.isSafeInteger(preview?.minStakeMinor)
    || Number(preview.minStakeMinor) !== input.amountMinor) {
    throw new Error('acceptance-minimum-only')
  }
  if (input.capabilityVersion !== input.manifest.capabilityVersion
    || input.capabilityEvidenceId !== direction.capabilityEvidenceId
    || !/^[a-f0-9]{64}$/.test(String(input.executionCandidateDigest || ''))
    || !Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1) {
    throw new Error('acceptance-permit-mismatch')
  }
  const changed = db.prepare(`UPDATE crown_browser_acceptance_cases SET
    execution_candidate_digest=?,state='dispatched',child_order_id=?,account_id=?,submit_attempt_id=?,
    authorized_min_minor=?,dispatch_count=1,updated_at=?
    WHERE campaign_id=? AND direction_id=? AND case_version=? AND state='pending' AND dispatch_count=0`).run(
    input.executionCandidateDigest, input.childOrderId, attempt.account_id, input.submitAttemptId, input.amountMinor,
    new Date().toISOString(), input.campaignId, direction.id, row.case_version,
  )
  if (changed.changes !== 1) throw new Error('acceptance-direction-permit-race')
  return { campaignId: input.campaignId, directionId: direction.id, caseVersion: Number(row.case_version) }
}

function settleDispatchInTransaction(database, input = {}) {
  if (!SETTLEMENT_PERMITS.has(input)) throw new Error('acceptance-worker-authority-required')
  const db = dbOf(database)
  const kind = ['accepted', 'rejected'].includes(input.kind) ? input.kind : 'unknown'
  const row = db.prepare(`SELECT * FROM crown_browser_acceptance_cases
    WHERE campaign_id=? AND submit_attempt_id=?`).get(input.campaignId, input.submitAttemptId)
  if (!row || row.child_order_id !== input.childOrderId || row.state !== 'dispatched') {
    throw new Error('acceptance-settlement-binding-mismatch')
  }
  const observedAt = new Date(input.observedAt || Date.now()).toISOString()
  const state = kind === 'accepted' ? 'validating' : kind
  const validationDeadline = kind === 'accepted'
    ? new Date(Date.parse(observedAt) + VALIDATION_DEADLINE_MS).toISOString()
    : ''
  db.prepare(`UPDATE crown_browser_acceptance_cases SET state=?,outcome=?,sealed_provider_reference=?,
    validation_poll_count=0,validation_next_poll_at=?,validation_deadline_at=?,result_evidence_digest='',updated_at=?
    WHERE campaign_id=? AND direction_id=? AND case_version=? AND state='dispatched'`).run(
    state, kind, String(input.sealedProviderReference || ''), observedAt, validationDeadline, observedAt,
    input.campaignId, row.direction_id, row.case_version,
  )
  if (kind === 'unknown') {
    db.prepare("UPDATE crown_browser_acceptance_campaigns SET status='terminal_unknown',updated_at=? WHERE campaign_id=? AND status='active'")
      .run(observedAt, input.campaignId)
  } else if (kind === 'rejected') {
    db.prepare(`INSERT INTO crown_browser_acceptance_cases (
      campaign_id,direction_id,case_version,ordinal,mode,period,market_type,line_variant,
      selection_side,protocol_evidence_digest,capability_evidence_id,state,created_at,updated_at
    ) SELECT campaign_id,direction_id,case_version+1,ordinal,mode,period,market_type,line_variant,
      selection_side,protocol_evidence_digest,capability_evidence_id,'pending',?,?
      FROM crown_browser_acceptance_cases
      WHERE campaign_id=? AND direction_id=? AND case_version=?`).run(
      observedAt, observedAt, input.campaignId, row.direction_id, row.case_version,
    )
  }
}

function parseObject(value, code) {
  let parsed
  try { parsed = JSON.parse(String(value || '')) } catch { throw new Error(code) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(code)
  return parsed
}

function expectedResultIdentity(row, direction) {
  const frozen = parseObject(row.frozen_preview_json, 'acceptance-reconciliation-identity-unverified')
  const locked = frozen.lockedIdentity
  const preview = frozen.preview
  const capability = acceptanceSubmitCapability(direction)
  const sideWire = capability.mapperEvidence?.submitWireBySide?.[direction.selectionSide]
  const defaults = capability.mapperEvidence?.wireDefaults?.submit
  if (!locked || typeof locked !== 'object' || !preview || typeof preview !== 'object'
    || frozen.accountId !== row.account_id
    || frozen.capabilityVersion !== CROWN_CAPABILITY_MATRIX_VERSION
    || frozen.capabilityEvidenceId !== row.capability_evidence_id
    || locked.mode !== direction.mode || locked.period !== direction.period
    || locked.market !== direction.marketType || locked.lineVariant !== direction.lineVariant
    || locked.side !== direction.selectionSide
    || preview.currency !== 'CNY' || Number(preview.amountScale) !== 0
    || Number(preview.minStakeMinor) !== Number(row.authorized_min_minor)
    || !sideWire || sideWire.gtype !== 'FT'
    || !defaults || defaults.autoOdd !== 'Y') {
    throw new Error('acceptance-reconciliation-identity-unverified')
  }
  return Object.freeze({
    gid: required(locked.gid, 'acceptance-reconciliation-identity-unverified'),
    bet_gtype: required(sideWire.gtype, 'acceptance-reconciliation-identity-unverified'),
    bet_wtype: required(sideWire.wtype, 'acceptance-reconciliation-identity-unverified'),
    type: required(sideWire.chose_team, 'acceptance-reconciliation-identity-unverified'),
    ioratio: required(preview.odds, 'acceptance-reconciliation-identity-unverified'),
    gold: String(Number(row.authorized_min_minor)),
    concede: required(preview.submitCon, 'acceptance-reconciliation-identity-unverified'),
  })
}

function latestUnacceptedCount(db, campaignId) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM crown_browser_acceptance_cases current
    WHERE current.campaign_id=?
      AND current.case_version=(SELECT MAX(versioned.case_version)
        FROM crown_browser_acceptance_cases versioned
        WHERE versioned.campaign_id=current.campaign_id AND versioned.direction_id=current.direction_id)
      AND current.state<>'accepted'`).get(campaignId).count)
}

function recordValidationInTransaction(db, manifest, raw = {}) {
  const submitAttemptId = required(raw.submitAttemptId, 'acceptance-submit-attempt-id')
  const decision = required(raw.decision, 'acceptance-validation-decision')
  if (!['pending', 'accepted', 'unknown'].includes(decision)) throw new Error('acceptance-validation-decision')
  const observedAt = new Date(raw.observedAt || Date.now()).toISOString()
  const evidenceDigest = String(raw.evidenceDigest || '')
  if (evidenceDigest && !/^[a-f0-9]{64}$/.test(evidenceDigest)) throw new Error('acceptance-validation-evidence-digest')
  const row = db.prepare(`SELECT * FROM crown_browser_acceptance_cases
    WHERE campaign_id=? AND submit_attempt_id=?`).get(manifest.campaignId, submitAttemptId)
  if (!row) throw new Error('acceptance-reconciliation-binding-mismatch')
  if (row.state === 'accepted') return { status: 'accepted', decision: 'accepted' }
  if (row.state === 'unknown') return { status: 'terminal_unknown', decision: 'unknown' }
  if (row.state !== 'validating' || !row.validation_deadline_at) {
    throw new Error('acceptance-validation-binding-mismatch')
  }
  const expired = Date.parse(observedAt) >= Date.parse(row.validation_deadline_at)
  const finalDecision = expired ? 'unknown' : decision
  const pollCount = Number(row.validation_poll_count) + 1
  if (finalDecision === 'pending') {
    const delay = VALIDATION_BACKOFF_SECONDS[Math.min(pollCount - 1, VALIDATION_BACKOFF_SECONDS.length - 1)]
    const nextPollAt = new Date(Math.min(
      Date.parse(observedAt) + delay * 1_000,
      Date.parse(row.validation_deadline_at),
    )).toISOString()
    const changed = db.prepare(`UPDATE crown_browser_acceptance_cases SET
      validation_poll_count=?,validation_next_poll_at=?,result_evidence_digest=?,updated_at=?
      WHERE campaign_id=? AND direction_id=? AND case_version=? AND state='validating'`).run(
      pollCount, nextPollAt, evidenceDigest || row.result_evidence_digest, observedAt,
      manifest.campaignId, row.direction_id, row.case_version,
    )
    if (changed.changes !== 1) throw new Error('acceptance-validation-race')
    return { status: 'waiting_validation', pollCount, nextPollAt }
  }
  if (finalDecision === 'accepted') {
    if (!evidenceDigest) throw new Error('acceptance-validation-evidence-digest')
    const changed = db.prepare(`UPDATE crown_browser_acceptance_cases SET
      state='accepted',validation_poll_count=?,validation_next_poll_at='',result_evidence_digest=?,updated_at=?
      WHERE campaign_id=? AND direction_id=? AND case_version=? AND state='validating'`).run(
      pollCount, evidenceDigest, observedAt, manifest.campaignId, row.direction_id, row.case_version,
    )
    if (changed.changes !== 1) throw new Error('acceptance-validation-race')
    if (latestUnacceptedCount(db, manifest.campaignId) === 0) {
      db.prepare("UPDATE crown_browser_acceptance_campaigns SET status='completed',updated_at=? WHERE campaign_id=? AND status='active'")
        .run(observedAt, manifest.campaignId)
    }
    return { status: 'accepted', decision: 'accepted' }
  }
  const changed = db.prepare(`UPDATE crown_browser_acceptance_cases SET
    state='unknown',outcome='unknown',validation_poll_count=?,validation_next_poll_at='',
    result_evidence_digest=?,updated_at=?
    WHERE campaign_id=? AND direction_id=? AND case_version=? AND state='validating'`).run(
    pollCount, evidenceDigest || row.result_evidence_digest, observedAt,
    manifest.campaignId, row.direction_id, row.case_version,
  )
  if (changed.changes !== 1) throw new Error('acceptance-validation-race')
  db.prepare("UPDATE crown_browser_acceptance_campaigns SET status='terminal_unknown',updated_at=? WHERE campaign_id=? AND status='active'")
    .run(observedAt, manifest.campaignId)
  return { status: 'terminal_unknown', decision: 'unknown' }
}

function recordReconciledOutcomeInTransaction(db, manifest, raw = {}) {
  const submitAttemptId = required(raw.submitAttemptId, 'acceptance-submit-attempt-id')
  const childOrderId = required(raw.childOrderId, 'acceptance-child-order-id')
  const decision = required(raw.decision, 'acceptance-reconciliation-decision')
  if (!['accepted', 'rejected'].includes(decision)) throw new Error('acceptance-reconciliation-decision')
  const evidenceDigest = required(raw.evidenceDigest, 'acceptance-reconciliation-evidence-digest')
  if (!/^[a-f0-9]{64}$/.test(evidenceDigest)) throw new Error('acceptance-reconciliation-evidence-digest')
  const observedAt = new Date(raw.observedAt || Date.now()).toISOString()
  const row = db.prepare(`SELECT * FROM crown_browser_acceptance_cases
    WHERE campaign_id=? AND submit_attempt_id=?`).get(manifest.campaignId, submitAttemptId)
  if (!row || row.child_order_id !== childOrderId || row.state !== 'unknown') {
    throw new Error('acceptance-reconciliation-binding-mismatch')
  }
  const changed = db.prepare(`UPDATE crown_browser_acceptance_cases SET
    state=?,result_evidence_digest=?,validation_next_poll_at='',updated_at=?
    WHERE campaign_id=? AND direction_id=? AND case_version=? AND state='unknown'`).run(
    decision, evidenceDigest, observedAt,
    manifest.campaignId, row.direction_id, row.case_version,
  )
  if (changed.changes !== 1) throw new Error('acceptance-reconciliation-race')
  if (decision === 'rejected') {
    db.prepare(`INSERT INTO crown_browser_acceptance_cases (
      campaign_id,direction_id,case_version,ordinal,mode,period,market_type,line_variant,
      selection_side,protocol_evidence_digest,capability_evidence_id,state,created_at,updated_at
    ) SELECT campaign_id,direction_id,case_version+1,ordinal,mode,period,market_type,line_variant,
      selection_side,protocol_evidence_digest,capability_evidence_id,'pending',?,?
      FROM crown_browser_acceptance_cases
      WHERE campaign_id=? AND direction_id=? AND case_version=?`).run(
      observedAt, observedAt, manifest.campaignId, row.direction_id, row.case_version,
    )
  }
  const status = latestUnacceptedCount(db, manifest.campaignId) === 0 ? 'completed' : 'active'
  db.prepare(`UPDATE crown_browser_acceptance_campaigns SET status=?,updated_at=?
    WHERE campaign_id=? AND status='terminal_unknown'`).run(status, observedAt, manifest.campaignId)
  return { status: decision, decision }
}

export function resolveAcceptanceReconciliation({
  campaignId,
  direction,
  submitAttemptId,
  sealedProviderReference,
} = {}) {
  return {
    campaignId: required(campaignId, 'acceptance-campaign-id'),
    direction: directionShape(direction),
    submitAttemptId: required(submitAttemptId, 'acceptance-submit-attempt-id'),
    sealedProviderReference: required(sealedProviderReference, 'acceptance-sealed-provider-reference'),
  }
}

export function createCrownAcceptanceCapabilityAuthority({
  database,
  manifest,
  secretKey,
  candidateCatalog,
} = {}) {
  const db = dbOf(database)
  assertCatalog(candidateCatalog)
  verifyStoredCampaign(db, manifest, secretKey)
  const authority = Object.freeze({
    claimNextCandidate() {
      verifyStoredCampaign(db, manifest, secretKey)
      const current = nextPendingCase(db, manifest.campaignId)
      const campaign = campaignRow(db, manifest.campaignId)
      if (!current || campaign.status !== 'active') return null
      if (current.state === 'validating') {
        return Object.freeze({
          validationRequired: true,
          submitAttemptId: current.submit_attempt_id,
          ordinal: Number(current.ordinal),
          caseVersion: Number(current.case_version),
        })
      }
      const direction = manifest.directions.find((item) => item.id === current.direction_id)
      if (!direction) throw new Error('acceptance-manifest-directions')
      const candidateClaim = authority.claimCandidate(direction)
      return Object.freeze({
        direction: Object.freeze(structuredClone(direction)),
        candidateClaim,
        caseVersion: Number(current.case_version),
      })
    },
    claimCandidate(direction) {
      verifyStoredCampaign(db, manifest, secretKey)
      const expected = exactManifestDirection(manifest, direction)
      const campaign = campaignRow(db, manifest.campaignId)
      const current = nextPendingCase(db, manifest.campaignId)
      if (campaign.status !== 'active' || !current || current.state !== 'pending') {
        throw new Error('acceptance-direction-permit-unavailable')
      }
      if (current.direction_id !== expected.id) throw new Error('acceptance-ordinal-mismatch')
      const claim = Object.freeze(Object.create(null))
      CANDIDATE_CLAIMS.set(claim, {
        authority,
        campaignId: manifest.campaignId,
        directionId: expected.id,
        caseVersion: Number(current.case_version),
      })
      return claim
    },
    resolveCapability({ operation, direction, candidateClaim } = {}) {
      verifyStoredCampaign(db, manifest, secretKey)
      const expected = exactManifestDirection(manifest, direction)
      const ownership = CANDIDATE_CLAIMS.get(candidateClaim)
      if (!ownership || ownership.authority !== authority
        || ownership.campaignId !== manifest.campaignId
        || ownership.directionId !== expected.id) throw new Error('acceptance-candidate-claim-required')
      const campaign = campaignRow(db, manifest.campaignId)
      const current = latestCase(db, manifest.campaignId, expected.id)
      if (!current || campaign.status !== 'active') throw new Error('acceptance-direction-permit-unavailable')
      if (current.state !== 'pending' || Number(current.case_version) !== ownership.caseVersion) {
        throw new Error('acceptance-direction-permit-unavailable')
      }
      if (!['preview', 'submit', 'reconciliation'].includes(operation)) throw new Error('acceptance-operation')
      const capability = operation === 'submit'
        ? acceptanceSubmitCapability(expected)
        : canonicalCapability(expected)
      return Object.freeze({
        ...structuredClone(capability),
        ...(['preview', 'submit'].includes(operation) ? { submitAllowed: true } : {}),
        ...(operation === 'reconciliation' ? { reconciliationAllowed: true } : {}),
        acceptanceOnly: true,
        acceptanceCampaignId: manifest.campaignId,
      })
    },
    freezePreview(candidateClaim, raw = {}) {
      verifyStoredCampaign(db, manifest, secretKey)
      const ownership = candidateOwnership(authority, manifest, candidateClaim)
      const snapshot = acceptancePreviewSnapshot(raw)
      const changed = db.prepare(`UPDATE crown_browser_acceptance_cases
        SET frozen_preview_json=?,context_generation=?,updated_at=?
        WHERE campaign_id=? AND direction_id=? AND case_version=? AND state='pending'
          AND frozen_preview_json='{}'`).run(
        stableJson(snapshot), snapshot.contextGeneration, new Date().toISOString(),
        manifest.campaignId, ownership.directionId, ownership.caseVersion,
      )
      if (changed.changes !== 1) throw new Error('acceptance-preview-already-frozen')
      return snapshot
    },
    cancelPreviewCycle(candidateClaim) {
      verifyStoredCampaign(db, manifest, secretKey)
      const ownership = candidateOwnership(authority, manifest, candidateClaim)
      rotatePendingPreviewCase(db, manifest, ownership)
      return true
    },
    confirmPreview(candidateClaim, raw = {}) {
      verifyStoredCampaign(db, manifest, secretKey)
      const ownership = candidateOwnership(authority, manifest, candidateClaim)
      const snapshot = acceptancePreviewSnapshot(raw)
      const row = latestCase(db, manifest.campaignId, ownership.directionId)
      if (!row || Number(row.case_version) !== ownership.caseVersion || row.state !== 'pending') {
        throw new Error('acceptance-direction-permit-unavailable')
      }
      if (row.frozen_preview_json === stableJson(snapshot)) return snapshot
      rotatePendingPreviewCase(db, manifest, ownership)
      throw Object.assign(new Error('acceptance-preview-drift'), { code: 'acceptance-preview-drift' })
    },
    claimDispatchInTransaction(targetDb, raw = {}) {
      if (dbOf(targetDb) !== db) throw new Error('acceptance-database-mismatch')
      const direction = exactManifestDirection(manifest, raw.direction)
      candidateOwnership(authority, manifest, raw.candidateClaim, direction)
      const input = { ...raw, direction, campaignId: manifest.campaignId, manifest }
      DISPATCH_PERMITS.add(input)
      return claimAcceptanceDispatchInTransaction(db, input)
    },
    settleDispatchInTransaction(targetDb, raw = {}) {
      if (dbOf(targetDb) !== db) throw new Error('acceptance-database-mismatch')
      const input = { ...raw, campaignId: manifest.campaignId }
      SETTLEMENT_PERMITS.add(input)
      return settleDispatchInTransaction(db, input)
    },
    recordValidationInTransaction(targetDb, raw = {}) {
      if (dbOf(targetDb) !== db) throw new Error('acceptance-database-mismatch')
      verifyStoredCampaign(db, manifest, secretKey)
      return recordValidationInTransaction(db, manifest, raw)
    },
    recordReconciledOutcomeInTransaction(targetDb, raw = {}) {
      if (dbOf(targetDb) !== db) throw new Error('acceptance-database-mismatch')
      verifyStoredCampaign(db, manifest, secretKey)
      return recordReconciledOutcomeInTransaction(db, manifest, raw)
    },
    isDispatchBoundInTransaction(targetDb, raw = {}) {
      if (dbOf(targetDb) !== db) throw new Error('acceptance-database-mismatch')
      const submitAttemptId = required(raw.submitAttemptId, 'acceptance-submit-attempt-id')
      const row = db.prepare(`SELECT child_order_id,state FROM crown_browser_acceptance_cases
        WHERE campaign_id=? AND submit_attempt_id=?`).get(manifest.campaignId, submitAttemptId)
      if (!row) return false
      if (row.child_order_id !== required(raw.childOrderId, 'acceptance-child-order-id')) {
        throw new Error('acceptance-settlement-binding-mismatch')
      }
      return row.state === 'dispatched'
    },
    recoverUnknownInTransaction(targetDb, raw = {}) {
      if (dbOf(targetDb) !== db) throw new Error('acceptance-database-mismatch')
      const submitAttemptId = required(raw.submitAttemptId, 'acceptance-submit-attempt-id')
      const row = db.prepare(`SELECT * FROM crown_browser_acceptance_cases
        WHERE campaign_id=? AND submit_attempt_id=?`).get(manifest.campaignId, submitAttemptId)
      if (!row) return false
      if (row.child_order_id !== required(raw.childOrderId, 'acceptance-child-order-id')) {
        throw new Error('acceptance-recovery-binding-mismatch')
      }
      if (row.state === 'unknown') return true
      if (row.state !== 'dispatched') throw new Error('acceptance-recovery-binding-mismatch')
      const sealed = String(raw.sealedProviderReference || row.sealed_provider_reference || '')
      const changed = db.prepare(`UPDATE crown_browser_acceptance_cases
        SET state='unknown',outcome='unknown',sealed_provider_reference=?,updated_at=?
        WHERE campaign_id=? AND direction_id=? AND case_version=? AND state='dispatched'`).run(
        sealed, new Date().toISOString(), manifest.campaignId, row.direction_id, row.case_version,
      )
      if (changed.changes !== 1) throw new Error('acceptance-recovery-race')
      db.prepare(`UPDATE crown_browser_acceptance_campaigns
        SET status='terminal_unknown',updated_at=? WHERE campaign_id=? AND status='active'`).run(
        new Date().toISOString(), manifest.campaignId,
      )
      return true
    },
    resolveReconciliation(raw = {}) {
      verifyStoredCampaign(db, manifest, secretKey)
      const submitAttemptId = required(raw.submitAttemptId, 'acceptance-submit-attempt-id')
      const row = db.prepare(`SELECT * FROM crown_browser_acceptance_cases
        WHERE campaign_id=? AND submit_attempt_id=?`).get(manifest.campaignId, submitAttemptId)
      const expected = row ? manifest.directions.find((item) => item.id === row.direction_id) : null
      const input = raw.direction || raw.sealedProviderReference
        ? resolveAcceptanceReconciliation({
            ...raw,
            campaignId: manifest.campaignId,
            direction: raw.direction || expected,
            sealedProviderReference: raw.sealedProviderReference || row?.sealed_provider_reference,
          })
        : {
            campaignId: manifest.campaignId,
            direction: expected,
            submitAttemptId,
            sealedProviderReference: row?.sealed_provider_reference,
          }
      if (!row || !['validating', 'accepted', 'unknown'].includes(row.state)
        || !expected
        || row.sealed_provider_reference !== input.sealedProviderReference) {
        throw new Error('acceptance-reconciliation-binding-mismatch')
      }
      return {
        ...input,
        direction: expected,
        outcome: row.outcome,
        state: row.state,
        childOrderId: row.child_order_id,
        accountId: row.account_id,
        expectedResultIdentity: expectedResultIdentity(row, expected),
        validationPollCount: Number(row.validation_poll_count),
        validationNextPollAt: row.validation_next_poll_at,
        validationDeadlineAt: row.validation_deadline_at,
        resultEvidenceDigest: row.result_evidence_digest,
      }
    },
    matchesReconciliationReference(rawReference, raw = {}) {
      const binding = authority.resolveReconciliation(raw)
      let expected
      try {
        expected = decryptSecret(binding.sealedProviderReference, {
          secretKey,
          context: {
            purpose: 'crown-provider-reference',
            childOrderId: binding.childOrderId,
            submitAttemptId: binding.submitAttemptId,
          },
        })
      } catch {
        return false
      }
      const left = Buffer.from(String(rawReference || ''), 'utf8')
      const right = Buffer.from(String(expected || ''), 'utf8')
      return left.length > 0 && left.length === right.length && timingSafeEqual(left, right)
    },
    inspect() {
      return inspectCrownBrowserAcceptanceCampaign(db, { manifest, secretKey })
    },
  })
  AUTHORITIES.add(authority)
  return authority
}

export function isCrownAcceptanceCapabilityAuthority(value) {
  return AUTHORITIES.has(value)
}

export function createCrownAcceptanceWorkerConsumer({
  authority,
  findCandidate,
  executeDirection,
  validateDirection = null,
} = {}) {
  if (!isCrownAcceptanceCapabilityAuthority(authority)) throw new TypeError('acceptance-worker-authority-required')
  if (typeof findCandidate !== 'function') throw new TypeError('acceptance-worker-candidate-finder')
  if (typeof executeDirection !== 'function') throw new TypeError('acceptance-worker-executor')
  if (validateDirection !== null && typeof validateDirection !== 'function') throw new TypeError('acceptance-worker-validator')
  return Object.freeze({
    async runOnce() {
      const before = authority.inspect()
      if (before.status === 'terminal_unknown') return { status: 'terminal_unknown', processed: 0, stop: true }
      if (before.status === 'completed') return { status: 'completed', processed: 0, stop: true }
      const claimed = authority.claimNextCandidate()
      if (!claimed) return { status: 'inactive', processed: 0 }
      if (claimed.validationRequired) {
        if (!validateDirection) return {
          status: 'waiting_validation', processed: 0, ordinal: claimed.ordinal, stop: false,
        }
        const result = await validateDirection({ submitAttemptId: claimed.submitAttemptId })
        const after = authority.inspect()
        return {
          ...result,
          status: after.status === 'terminal_unknown'
            ? 'terminal_unknown'
            : String(result?.status || 'waiting_validation'),
          processed: 1,
          ordinal: claimed.ordinal,
          stop: after.status === 'terminal_unknown',
        }
      }
      const candidate = await findCandidate(claimed.direction)
      if (!candidate) return {
        status: 'waiting_candidate', processed: 0, ordinal: claimed.direction.ordinal,
      }
      const result = await executeDirection({ ...claimed, candidate })
      const after = authority.inspect()
      const current = [...after.cases].reverse().find((item) => Number(item.ordinal) === claimed.direction.ordinal)
      const status = after.status === 'terminal_unknown'
        ? 'terminal_unknown'
        : current?.state === 'validating'
          ? 'waiting_validation'
        : String(result?.status || 'unknown')
      return {
        ...result,
        status,
        processed: 1,
        ordinal: claimed.direction.ordinal,
        stop: after.status === 'terminal_unknown',
      }
    },
  })
}

export function loadActiveCrownAcceptanceCapabilityAuthority({ database, secretKey } = {}) {
  const db = dbOf(database)
  const row = db.prepare(`SELECT manifest_json FROM crown_browser_acceptance_campaigns
    WHERE status IN ('active','terminal_unknown')
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,updated_at DESC LIMIT 1`).get()
  if (!row) return null
  let manifest
  try { manifest = JSON.parse(row.manifest_json) } catch { throw new Error('acceptance-manifest-hmac') }
  return createCrownAcceptanceCapabilityAuthority({
    database: db,
    manifest,
    secretKey,
    candidateCatalog: listCrownCapabilities(),
  })
}
