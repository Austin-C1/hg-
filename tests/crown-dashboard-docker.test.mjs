import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('dashboard Docker config keeps the image buildable without copying local secrets', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8')
  const dockerignore = fs.readFileSync('.dockerignore', 'utf8')
  const compose = fs.readFileSync('docker-compose.yml', 'utf8')
  const envExample = fs.readFileSync('.env.example', 'utf8')
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))

  assert.match(dockerfile, /AS frontend-build/)
  assert.match(dockerfile, /npm run build/)
  assert.match(dockerfile, /COPY --from=frontend-build .*frontend\/dist/)
  assert.match(dockerfile, /CROWN_DASHBOARD_HOST=0\.0\.0\.0/)
  assert.match(dockerfile, /CROWN_DB_PATH=\/app\/storage\/crown\.sqlite/)
  assert.match(dockerfile, /CROWN_STATIC_DIR=\/app\/frontend\/dist/)
  assert.match(dockerfile, /EXPOSE 8787/)
  assert.doesNotMatch(dockerfile, /^COPY\s+\.\s/m)
  assert.doesNotMatch(dockerfile, /^COPY\s+config\s+\.\/config/m)
  assert.doesNotMatch(dockerfile, /telegram-settings\.json/)
  assert.match(dockerfile, /COPY config\/default-leagues\.json config\/monitor-settings\.json config\/monitored-leagues\.json \/app\/config\//)

  for (const pattern of [
    'storage/',
    'data/runtime/',
    'config/telegram-settings.json',
    '**/crown-sessions/',
    '**/login-diagnostics/',
    '**/cookies.json',
    '**/storage-state*.json',
    '**/*.key',
    '**/*.pem',
    '**/*.sqlite*',
    '**/*.db*',
  ]) {
    assert.equal(dockerignore.split(/\r?\n/).includes(pattern), true, `missing .dockerignore rule: ${pattern}`)
  }

  assert.match(compose, /127\.0\.0\.1:8787:8787/)
  assert.doesNotMatch(compose, /\.\/data\/runtime:/)
  assert.doesNotMatch(compose, /\.\/config:/)
  assert.doesNotMatch(compose, /\.\/data\/fixtures:/)
  assert.doesNotMatch(compose, /crown-profile|crown-sessions|login-diagnostics|betting-protocol-captures/)
  assert.match(compose, /crown-runtime:\/app\/data\/runtime/)
  assert.match(compose, /crown-config:\/app\/config/)
  assert.match(compose, /crown-storage:\/app\/storage/)
  assert.match(compose, /CROWN_DB_PATH: \/app\/storage\/crown\.sqlite/)
  assert.match(compose, /CROWN_STATIC_DIR: \/app\/frontend\/dist/)
  assert.match(compose, /CROWN_DASHBOARD_PASSWORD_SCRYPT: \$\{CROWN_DASHBOARD_PASSWORD_SCRYPT:-\}/)
  assert.match(compose, /CROWN_DASHBOARD_SESSION_KEY: \$\{CROWN_DASHBOARD_SESSION_KEY:-\}/)
  assert.match(compose, /CROWN_DASHBOARD_ALLOWED_HOSTS: \$\{CROWN_DASHBOARD_ALLOWED_HOSTS:-\}/)
  assert.match(compose, /CROWN_DASHBOARD_ALLOWED_ORIGINS: \$\{CROWN_DASHBOARD_ALLOWED_ORIGINS:-\}/)
  assert.match(envExample, /^CROWN_DASHBOARD_PASSWORD_SCRYPT=$/m)
  assert.match(envExample, /^CROWN_DASHBOARD_SESSION_KEY=$/m)
  assert.match(envExample, /^CROWN_DASHBOARD_ALLOWED_HOSTS=$/m)
  assert.match(envExample, /^CROWN_DASHBOARD_ALLOWED_ORIGINS=$/m)
  for (const line of envExample.split(/\r?\n/).filter((item) => /(?:password|session_key|secret_key)\s*=/i.test(item))) {
    assert.equal(line.replace(/^[^=]*=/, '').trim(), '')
  }
  assert.equal(pkg.scripts['crown:dashboard:docker'], 'docker compose -p crown-dashboard up --build')
})
