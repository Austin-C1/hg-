import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const css = fs.readFileSync(new URL('../frontend/src/styles/index.css', import.meta.url), 'utf8')

function stripCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function findClosingBrace(source, openingBrace) {
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) return index
  }
  throw new Error('Unbalanced CSS braces')
}

function splitSelectorList(selectorList) {
  const selectors = []
  let start = 0
  let parentheses = 0
  let brackets = 0
  let quote = null
  let escaped = false
  for (let index = 0; index < selectorList.length; index += 1) {
    const character = selectorList[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') parentheses += 1
    else if (character === ')') parentheses -= 1
    else if (character === '[') brackets += 1
    else if (character === ']') brackets -= 1
    else if (character === ',' && parentheses === 0 && brackets === 0) {
      selectors.push(selectorList.slice(start, index))
      start = index + 1
    }
  }
  selectors.push(selectorList.slice(start))
  return selectors
    .map((selector) => selector.trim().replace(/\s+/g, ' ').replace(/\s*([>+~])\s*/g, ' $1 '))
    .filter(Boolean)
}

function parseCssRules(source) {
  const rules = []

  function nextDelimiter(block, start) {
    let parentheses = 0
    let brackets = 0
    let quote = null
    let escaped = false
    for (let index = start; index < block.length; index += 1) {
      const character = block[index]
      if (quote) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === quote) quote = null
        continue
      }
      if (character === '"' || character === "'") quote = character
      else if (character === '(') parentheses += 1
      else if (character === ')') parentheses -= 1
      else if (character === '[') brackets += 1
      else if (character === ']') brackets -= 1
      else if (parentheses === 0 && brackets === 0 && (character === ';' || character === '{')) {
        return { character, index }
      }
    }
    return null
  }

  function visit(block) {
    let cursor = 0
    while (cursor < block.length) {
      const delimiter = nextDelimiter(block, cursor)
      if (!delimiter) return
      if (delimiter.character === ';') {
        cursor = delimiter.index + 1
        continue
      }
      const header = block.slice(cursor, delimiter.index).trim()
      const closingBrace = findClosingBrace(block, delimiter.index)
      const body = block.slice(delimiter.index + 1, closingBrace)
      if (header.startsWith('@')) visit(body)
      else if (header) {
        rules.push({ selectors: splitSelectorList(header), body })
      }
      cursor = closingBrace + 1
    }
  }

  visit(stripCssComments(source))
  return rules
}

function declarations(body) {
  const result = new Map()
  for (const match of body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;}]*)/gi)) {
    result.set(match[1].toLowerCase(), match[2].trim())
  }
  return result
}

function hasSettingsLabelRule(source) {
  return parseCssRules(source).some((rule) => {
    if (!rule.selectors.includes('.settings-form-grid > label')) return false
    const properties = declarations(rule.body)
    return properties.get('display') === 'grid'
      && properties.get('gap') === '6px'
      && properties.get('color') === '#475467'
      && properties.get('font-size') === '12px'
  })
}

function hasBroadSettingsLabelRule(source) {
  return parseCssRules(source).some((rule) => rule.selectors.includes('.settings-form-grid label'))
}

function findClosingPair(source, openingIndex, opening, closing) {
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === opening) depth += 1
    else if (character === closing && --depth === 0) return index
  }
  return source.length - 1
}

function subjectCompound(selector) {
  let start = 0
  let parentheses = 0
  let brackets = 0
  let quote = null
  let escaped = false
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') parentheses += 1
    else if (character === ')') parentheses -= 1
    else if (character === '[') brackets += 1
    else if (character === ']') brackets -= 1
    else if (parentheses === 0 && brackets === 0 && /[>+~]/.test(character)) start = index + 1
    else if (parentheses === 0 && brackets === 0 && /\s/.test(character)) {
      let next = index
      while (next < selector.length && /\s/.test(selector[next])) next += 1
      const previous = selector.slice(0, index).trimEnd().at(-1)
      const following = selector[next]
      if (previous && following && !/[>+~]/.test(previous) && !/[>+~]/.test(following)) start = next
      index = next - 1
    }
  }
  return selector.slice(start).trim()
}

function selectorTargetsCheckboxInner(selector) {
  const subject = subjectCompound(selector)
  for (let index = 0; index < subject.length; index += 1) {
    const character = subject[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '[') {
      index = findClosingPair(subject, index, '[', ']')
      continue
    }
    if (character === ':' && /[a-z-]/i.test(subject[index + 1] ?? '')) {
      const nameStart = index + 1
      let nameEnd = nameStart
      while (/[a-z-]/i.test(subject[nameEnd] ?? '')) nameEnd += 1
      if (subject[nameEnd] === '(') {
        const closing = findClosingPair(subject, nameEnd, '(', ')')
        if (/^(?:is|where)$/i.test(subject.slice(nameStart, nameEnd))) {
          const argumentsList = subject.slice(nameEnd + 1, closing)
          if (splitSelectorList(argumentsList).some(selectorTargetsCheckboxInner)) return true
        }
        index = closing
        continue
      }
    }
    if (subject.startsWith('.ant-checkbox-inner', index)
      && !/[\w-]/.test(subject[index + '.ant-checkbox-inner'.length] ?? '')) return true
  }
  return false
}

function checkboxInnerRules(source) {
  return parseCssRules(source)
    .filter((rule) => rule.selectors.some(selectorTargetsCheckboxInner))
    .map((rule) => `${rule.selectors.join(', ')} {${rule.body}}`)
}

function checkboxInnerForbiddenProperties(source) {
  const forbidden = /^(?:transform|position|(?:min-|max-)?(?:width|height|inline-size|block-size))$/
  return checkboxInnerRules(source).flatMap((rule) => [...declarations(rule.slice(rule.indexOf('{') + 1)).keys()]
    .filter((property) => forbidden.test(property)))
}

test('checkbox selector matching checks the subject compound only', () => {
  for (const selector of [
    '.ant-checkbox-inner .icon',
    '.panel:has(.ant-checkbox-inner)',
    ':not(.ant-checkbox-inner)',
    '[data-value=".ant-checkbox-inner"]',
  ]) {
    assert.equal(selectorTargetsCheckboxInner(selector), false, selector)
  }

  for (const selector of [
    '.theme .ant-checkbox-inner:hover',
    '.foo:is(.ant-checkbox-inner)',
    ':is(.other, .ant-checkbox-inner:focus-visible)',
    '.dense.ant-checkbox-inner[data-state="checked"]',
  ]) {
    assert.equal(selectorTargetsCheckboxInner(selector), true, selector)
  }
})

test('checkbox contract rejects logical size declarations', () => {
  const logicalSizes = [
    'inline-size', 'block-size', 'min-inline-size', 'max-inline-size', 'min-block-size', 'max-block-size',
  ]
  const fixture = logicalSizes
    .map((property, index) => `.scope-${index} .ant-checkbox-inner:hover { ${property}: 12px; }`)
    .join('\n')
  assert.deepEqual(checkboxInnerForbiddenProperties(fixture), logicalSizes)
})

test('CSS rule parsing resets after statement at-rules and scans every block at-rule', () => {
  const fixture = `
    @charset "UTF-8";
    @import url("theme.css");
    .settings-form-grid > label { display: grid; gap: 6px; color: #475467; font-size: 12px; }
    @starting-style {
      .theme .ant-checkbox-inner:hover { position: relative; }
    }
  `
  assert.equal(hasSettingsLabelRule(fixture), true)
  assert.deepEqual(checkboxInnerForbiddenProperties(fixture), ['position'])
})

test('settings label selector matching ignores comments and compound lookalikes', () => {
  const deceptiveCss = `
    /* .settings-form-grid > label { display: grid; gap: 6px; color: #475467; font-size: 12px; } */
    .foo.settings-form-grid > label { display: grid; gap: 6px; color: #475467; font-size: 12px; }
    /* .settings-form-grid label { display: grid; } */
  `
  assert.equal(hasSettingsLabelRule(deceptiveCss), false)
  assert.equal(hasBroadSettingsLabelRule(deceptiveCss), false)

  const groupedCss = `.settings-form-grid>label, .other-label {
    display: grid; gap: 6px; color: #475467; font-size: 12px;
  }`
  assert.equal(hasSettingsLabelRule(groupedCss), true)
  assert.equal(hasBroadSettingsLabelRule(`.other-label, .settings-form-grid   label { display: grid; }`), true)
})

test('checkbox selector matching covers contextual, grouped, compound, and pseudo rules', () => {
  const maliciousCss = `@media (min-width: 1px) {
    /* .ant-checkbox-inner { width: 1px; } */
    .scope .ant-checkbox-inner:hover { transform: translateY(1px); }
    .ant-checkbox-inner, .safe-position { position: relative; }
    .ant-checkbox-inner.compact { width: 12px; }
    .settings .ant-checkbox-inner:focus { height: 12px; }
    [data-form] > .ant-checkbox-inner { min-width: 12px; }
    :is(.ant-checkbox-inner, .other-inner) { max-width: 12px; }
    .dense.ant-checkbox-inner { min-height: 12px; }
    .safe-height, .ant-checkbox-inner:focus-visible { max-height: 12px; }
  }`
  const rules = checkboxInnerRules(maliciousCss)
  assert.equal(rules.length, 8)
  assert.deepEqual(checkboxInnerForbiddenProperties(maliciousCss), [
    'transform', 'position', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  ])
})

test('operations grids fit the 768-1199 content width after the sider is deducted', () => {
  const start = css.indexOf('@media (min-width: 768px) and (max-width: 1199px)')
  const end = css.indexOf('@media (max-width: 767px)', start)
  const tablet = css.slice(start, end)
  assert.match(tablet, /\.compact-risk,\s*\.operations-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
})

test('mode settings and operations remain single-column at 767px and below', () => {
  const mobile = css.slice(css.indexOf('@media (max-width: 767px)'))
  assert.match(mobile, /\.mode-settings-grid[^\{]*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  assert.match(mobile, /\.operations-row[^\{]*\{[^}]*grid-template-columns:\s*1fr/)
})

test('settings labels do not restyle Ant Design checkbox wrappers', () => {
  assert.equal(hasSettingsLabelRule(css), true)
  assert.equal(hasBroadSettingsLabelRule(css), false)
  assert.deepEqual(checkboxInnerForbiddenProperties(css), [])
})

test('dynamic rule page mobile actions keep a 44px touch target', () => {
  const mobile = css.slice(css.indexOf('@media (max-width: 480px)'))
  assert.match(mobile, /\.rule-page-title \.ant-btn,\s*\.rule-cards-page \.ant-empty \.ant-btn\s*\{[^}]*min-height:\s*44px/)
})

test('browser betting matrix stays readable at 390px and its controls keep a 44px touch target', () => {
  const mobile = css.slice(css.indexOf('@media (max-width: 480px)'))
  assert.match(mobile, /\.browser-direction-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(mobile, /\.browser-betting-panel \.ant-btn[^\{]*\{[^}]*min-height:\s*44px/)
  assert.doesNotMatch(css, /\.browser-betting-panel[^\{]*\{[^}]*animation:/)
})
