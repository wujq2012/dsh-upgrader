/**
 * dsh-upgrader — host half.
 *
 * Two jobs, and nothing else:
 *  1. Inject a head <script> that forges `globalThis.dshDesktop` (the Electron
 *     preload carrier) BEFORE any bundle runs, so the web client's shipped-but-dead
 *     DesktopUpdateIndicator renders exactly like the desktop app. The fake
 *     `updates` bridge is backed by this plugin's HTTP routes.
 *  2. Serve the real update data: read the installed @deepseek-ai/dsh version,
 *     compare it with the npm dist-tag, and (after an explicit two-step
 *     confirmation) stop this host, run `npm install -g @deepseek-ai/dsh@<ver>`
 *     from a detached PowerShell helper, then relaunch the original CLI.
 *
 * The upgrade helper is the same shape as the desktop app's flow
 * (stop host -> install -> relaunch); the helper always relaunches the old
 * install when npm fails, so a failed upgrade does not leave the host dead.
 *
 * @module dsh-upgrader
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Package this plugin upgrades. */
const PACKAGE_NAME = '@deepseek-ai/dsh'
/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/plugins/dsh-upgrader'
/** npm dist-tags document (single small JSON). */
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags'
/** Header carrying the per-process action token required by write routes. */
const TOKEN_HEADER = 'x-dsh-upgrader-key'

/** Cordis service dependency: routes must mount only once the web server exists. */
export const inject = ['webServer']

// ---------------------------------------------------------------------------
// versions

/**
 * Parse a strict semver version (leading v allowed).
 * @param {string} value - version text.
 * @returns {{major:number,minor:number,patch:number,pre:Array<string|number>}|null}
 */
function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return null
  const pre = match[4] === undefined ? [] : match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre }
}

/**
 * Compare two semver versions (prerelease-aware: alpha < beta < rc < release).
 * @param {string} left - version text.
 * @param {string} right - version text.
 * @returns {number} negative, zero or positive.
 */
function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 0
  const head = a.major - b.major || a.minor - b.minor || a.patch - b.patch
  if (head !== 0) return head
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < length; i += 1) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y
      continue
    }
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// ---------------------------------------------------------------------------
// install detection

/**
 * Find the @deepseek-ai/dsh package that owns this running process.
 *
 * `dsh web` runs `<prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js`, so walking
 * up from argv[1] finds the package manifest without spawning npm.
 * @returns {{dir:string,version:string}|null}
 */
function detectDshPackage() {
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry !== '') {
    let dir = dirname(resolve(entry))
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        if (manifest !== null && typeof manifest === 'object' && manifest.name === PACKAGE_NAME && typeof manifest.version === 'string') {
          return { dir, version: manifest.version }
        }
      } catch {
        // no manifest here; keep walking
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// http helpers

/** @param {import('node:http').IncomingMessage} req */
function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Whether a write request came from this host's own page.
 * @param {import('node:http').IncomingMessage} req
 */
function isSameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return false
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Consume a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<unknown>}
 */
function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        rejectPromise(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolvePromise({})
      try {
        resolvePromise(JSON.parse(text))
      } catch {
        rejectPromise(new Error('invalid json'))
      }
    })
    req.on('error', rejectPromise)
  })
}

/** @returns {string} DSH home directory used for logs. */
function dshHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured !== '' ? configured : join(homedir(), '.dsh')
}

// ---------------------------------------------------------------------------
// carrier script (runs in the page head, before any bundle)

/**
 * Build the page-side carrier script.
 * @returns {string} plain ES5 script text (no backticks, no </script>).
 */
function carrierScript() {
  return `(function () {
  var ENDPOINT = ${JSON.stringify(ROUTE_PREFIX)};
  var view = { presentation: { phase: 'idle' }, detail: null, error: null, dialogOpen: false, confirming: false, posting: false };
  var listeners = new Set();
  var poll = null;
  function emit(next) {
    view.presentation = next;
    listeners.forEach(function (fn) { try { fn(next); } catch (e) { console.error('[dsh-upgrader] listener failed', e); } });
  }
  function apply(payload) {
    view.detail = payload.detail;
    view.error = null;
    emit(payload.presentation);
    if (view.dialogOpen) renderDialog();
  }
  function fail(error) {
    view.error = String((error && error.message) || error);
    if (view.dialogOpen) renderDialog();
  }
  function fetchStatus() {
    return fetch(ENDPOINT + '/status.json', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) { if (!res.ok) throw new Error('status HTTP ' + res.status); return res.json(); })
      .then(apply, fail);
  }
  function post(path, body) {
    var token = view.detail && view.detail.actionToken ? view.detail.actionToken : '';
    return fetch(ENDPOINT + path, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', '${TOKEN_HEADER}': token },
      body: JSON.stringify(body || {})
    }).then(function (res) { return res.json().then(function (payload) { if (!res.ok) throw new Error(payload && payload.message ? payload.message : ('HTTP ' + res.status)); return payload; }); });
  }
  function ensureStyle() {
    if (document.getElementById('dsh-upgrader-style') !== null) return;
    var style = document.createElement('style');
    style.id = 'dsh-upgrader-style';
    style.textContent = [
      '#dsh-upgrader-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(8,10,14,.42)}',
      '.duc-card{width:min(560px,calc(100vw - 40px));max-height:calc(100vh - 80px);overflow:auto;box-sizing:border-box;border-radius:14px;padding:20px 20px 16px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:0 24px 70px rgba(0,0,0,.32);font:13px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}',
      '.duc-title{display:flex;align-items:center;justify-content:space-between;font-size:15px;font-weight:600;margin:0 0 12px}',
      '.duc-close{cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:18px;line-height:1;padding:2px 6px;border-radius:6px}',
      '.duc-row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#111) 8%,transparent)}',
      '.duc-row b{font-weight:600}',
      '.duc-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}',
      '.duc-note{margin:10px 0 0;color:var(--dsw-alias-label-secondary,#666);font-size:12px}',
      '.duc-error{margin:10px 0 0;color:#d33;font-size:12px;white-space:pre-wrap}',
      '.duc-ok{margin:10px 0 0;color:#2a9d58;font-size:12px}',
      '.duc-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap}',
      '.duc-btn{cursor:pointer;border-radius:8px;padding:6px 14px;font:inherit;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#111) 18%,transparent);background:transparent;color:inherit}',
      '.duc-btn[disabled]{opacity:.5;cursor:default}',
      '.duc-btn-primary{background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#3b6ef5);border-color:transparent;color:#fff}',
      '.duc-btn-warn{border-color:#e0a33a;color:#b57914}'
    ].join('');
    document.head.appendChild(style);
  }
  function button(label, className, onClick, disabled) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'duc-btn' + (className ? ' ' + className : '');
    el.textContent = label;
    el.disabled = Boolean(disabled);
    el.addEventListener('click', onClick);
    return el;
  }
  function renderDialog() {
    ensureStyle();
    var existing = document.getElementById('dsh-upgrader-overlay');
    if (!view.dialogOpen) { if (existing !== null) existing.remove(); return; }
    var overlay = existing;
    if (overlay === null) {
      overlay = document.createElement('div');
      overlay.id = 'dsh-upgrader-overlay';
      overlay.addEventListener('click', function (event) { if (event.target === overlay) closeDialog(); });
      document.body.appendChild(overlay);
    }
    overlay.textContent = '';
    var card = document.createElement('div');
    card.className = 'duc-card';
    var title = document.createElement('div');
    title.className = 'duc-title';
    var titleText = document.createElement('span');
    titleText.textContent = 'DeepSeek Harness 更新';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'duc-close';
    close.textContent = '\\u00d7';
    close.addEventListener('click', closeDialog);
    title.appendChild(titleText);
    title.appendChild(close);
    card.appendChild(title);
    var detail = view.detail || {};
    var rows = [
      ['当前版本', detail.currentVersion || '未知'],
      ['最新版本', detail.latestVersion ? (detail.latestVersion + (detail.channel ? '（' + detail.channel + '）' : '')) : '未知'],
      ['检查时间', detail.checkedAt ? new Date(detail.checkedAt).toLocaleString() : '尚未检查'],
    ];
    rows.forEach(function (pair) {
      var row = document.createElement('div');
      row.className = 'duc-row';
      var label = document.createElement('span');
      label.textContent = pair[0];
      var value = document.createElement('b');
      value.textContent = pair[1];
      row.appendChild(label);
      row.appendChild(value);
      card.appendChild(row);
    });
    if (detail.install && detail.install.command) {
      var cmdRow = document.createElement('div');
      cmdRow.className = 'duc-row';
      var cmdLabel = document.createElement('span');
      cmdLabel.textContent = '升级命令';
      var cmd = document.createElement('b');
      cmd.className = 'duc-mono';
      cmd.textContent = detail.install.command;
      cmdRow.appendChild(cmdLabel);
      cmdRow.appendChild(cmd);
      card.appendChild(cmdRow);
    }
    var note = document.createElement('p');
    note.className = 'duc-note';
    note.textContent = detail.upgrade && detail.upgrade.status === 'running'
      ? '升级已交给后台执行：先停掉当前服务，再 npm 安装目标版本并自动重开。页面会短暂断开，恢复后刷新即可。'
      : '确认后会：停止当前 dsh 服务 → 用 npm 安装目标版本 → 自动重新启动。页面会短暂断开。';
    card.appendChild(note);
    if (view.error) {
      var error = document.createElement('p');
      error.className = 'duc-error';
      error.textContent = view.error;
      card.appendChild(error);
    }
    if (detail.upgrade && detail.upgrade.message) {
      var upgradeNote = document.createElement('p');
      upgradeNote.className = detail.upgrade.status === 'failed' ? 'duc-error' : 'duc-ok';
      upgradeNote.textContent = detail.upgrade.message;
      card.appendChild(upgradeNote);
    }
    var actions = document.createElement('div');
    actions.className = 'duc-actions';
    var busy = view.posting || (detail.upgrade && detail.upgrade.status === 'running');
    actions.appendChild(button('检查更新', '', function () {
      view.posting = true; view.confirming = false; renderDialog();
      post('/check.json', {}).then(function (payload) { view.posting = false; apply(payload); }, function (error) { view.posting = false; fail(error); });
    }, busy));
    if (detail.updateAvailable) {
      actions.appendChild(button(view.confirming ? '确认停止服务并安装' : '重启并安装', view.confirming ? 'duc-btn-warn' : 'duc-btn-primary', function () {
        if (!view.confirming) { view.confirming = true; renderDialog(); return; }
        view.posting = true; renderDialog();
        post('/upgrade.json', { confirm: true, version: detail.latestVersion }).then(function (payload) {
          view.posting = false; view.confirming = false; apply(payload);
        }, function (error) { view.posting = false; fail(error); });
      }, busy || !detail.install || detail.install.kind !== 'npm'));
    }
    actions.appendChild(button('关闭', '', closeDialog, false));
    card.appendChild(actions);
    overlay.appendChild(card);
  }
  function closeDialog() {
    view.dialogOpen = false;
    renderDialog();
  }
  globalThis.__dshUpdateCapsule = view;
  globalThis.dshDesktop = {
    protocolVersion: 1,
    updates: {
      status: function () { return fetchStatus().then(function () { return view.presentation; }, function () { return view.presentation; }); },
      subscribe: function (listener) {
        listeners.add(listener);
        if (poll === null) poll = setInterval(fetchStatus, 5000);
        fetchStatus();
        return function () { listeners.delete(listener); };
      },
      open: function () { view.dialogOpen = true; view.confirming = false; renderDialog(); fetchStatus(); return Promise.resolve(); }
    },
    channel: {
      get: function () { return Promise.resolve({ channel: 'latest', packagedChannel: 'latest', changing: false }); },
      set: function () { return Promise.resolve({ kind: 'unchanged', state: { channel: 'latest', packagedChannel: 'latest', changing: false } }); },
      subscribe: function () { return function () {}; }
    }
  };
  console.log('[dsh-upgrader] forged globalThis.dshDesktop (protocolVersion=1); real bridge -> ' + ENDPOINT);
})()`
}

// ---------------------------------------------------------------------------
// plugin

/**
 * Plugin entry.
 * @param {object} ctx - Cordis context.
 * @param {object} [rawConfig] - row config from cordis.patch.yml.
 */
export function apply(ctx, rawConfig) {
  const config = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  const settings = {
    channel: typeof config.channel === 'string' && config.channel !== '' ? config.channel : 'latest',
    checkOnStart: config.checkOnStart !== false,
    checkIntervalHours: typeof config.checkIntervalHours === 'number' && config.checkIntervalHours >= 0 ? config.checkIntervalHours : 6,
  }
  const actionToken = randomBytes(24).toString('base64url')
  const pkg = detectDshPackage()
  const state = {
    currentVersion: pkg === null ? null : pkg.version,
    latestVersion: null,
    channel: settings.channel,
    checking: false,
    updateAvailable: false,
    checkedAt: null,
    error: null,
    install: {
      kind: pkg === null ? 'unknown' : 'npm',
      packageDir: pkg === null ? null : pkg.dir,
      command: null,
    },
    upgrade: { status: 'idle', message: null, logPath: null, acceptedAt: null },
    actionToken,
  }

  /** Present the state in the shape the official DesktopUpdateSource expects. */
  const presentation = () => {
    if (state.upgrade.status === 'starting' || state.upgrade.status === 'running') return { phase: 'installing', version: state.latestVersion ?? undefined }
    if (state.checking) return { phase: 'checking', version: state.latestVersion ?? undefined }
    if (state.updateAvailable) return { phase: 'available', version: state.latestVersion ?? undefined }
    return { phase: 'idle' }
  }
  const snapshot = () => ({
    presentation: presentation(),
    detail: {
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      channel: state.channel,
      checking: state.checking,
      updateAvailable: state.updateAvailable,
      checkedAt: state.checkedAt,
      error: state.error,
      install: { kind: state.install.kind, command: state.install.command },
      upgrade: state.upgrade,
      actionToken: state.actionToken,
    },
  })

  /** Read the npm dist-tag and compare it with the running install. */
  const check = async () => {
    if (state.checking) return snapshot()
    state.checking = true
    state.error = null
    try {
      const response = await fetch(DIST_TAGS_URL, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error('npm registry HTTP ' + response.status)
      const tags = await response.json()
      const target = typeof tags?.[settings.channel] === 'string'
        ? tags[settings.channel]
        : typeof tags?.latest === 'string'
          ? tags.latest
          : null
      if (target === null) throw new Error('npm dist-tags 里没有可用的版本')
      state.latestVersion = target
      state.channel = typeof tags?.[settings.channel] === 'string' ? settings.channel : 'latest'
      state.updateAvailable = state.currentVersion !== null && compareVersions(target, state.currentVersion) > 0
      state.install.command = state.updateAvailable ? 'npm install -g ' + PACKAGE_NAME + '@' + target : null
      state.checkedAt = Date.now()
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    } finally {
      state.checking = false
    }
    return snapshot()
  }

  /** Write and launch the detached stop-install-relaunch helper. */
  const startUpgrade = (version) => {
    const logDirectory = join(dshHome(), 'plugins', 'dsh-upgrader')
    mkdirSync(logDirectory, { recursive: true })
    const logPath = join(logDirectory, 'upgrade.log')
    const scriptPath = join(logDirectory, 'upgrade.ps1')
    const nodeExe = process.execPath
    const argv = process.argv.slice(1)
    const cwd = process.cwd()
    if (argv.length === 0) throw new Error('无法确定原启动命令')
    const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'"
    const startArgs = argv.map((arg) => "'" + String(arg).replaceAll("'", "''").replaceAll('"', '`"') + "'").join(',')
    const script = [
      "$ErrorActionPreference = 'Continue'",
      'function W([string] $m) { try { Add-Content -LiteralPath $Log -Value ((Get-Date -Format o) + " " + $m) } catch {} }',
      '$Log = ' + quote(logPath),
      'W "upgrade helper start; pid=$PID; host=' + String(process.pid) + '"',
      'Start-Sleep -Milliseconds 2500',
      'try { Stop-Process -Id ' + String(process.pid) + ' -Force -ErrorAction Stop; W "host stopped" } catch { W ("stop host failed: " + $_) }',
      'Start-Sleep -Milliseconds 1500',
      '$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source',
      'if (-not $npm) { $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }',
      'if (-not $npm) { W "npm not found on PATH" } else {',
      '  W ("running: " + $npm + " install -g " + ' + quote(PACKAGE_NAME + '@' + version) + ')',
      '  & $npm install -g ' + quote(PACKAGE_NAME + '@' + version) + ' *>> $Log',
      '  W ("npm exit code: " + $LASTEXITCODE)',
      '}',
      'W "relaunching dsh"',
      'try {',
      '  Start-Process -FilePath ' + quote(nodeExe) + ' -ArgumentList @(' + startArgs + ') -WorkingDirectory ' + quote(cwd) + ' -RedirectStandardOutput (' + quote(logPath) + ' + ".out") -RedirectStandardError (' + quote(logPath) + ' + ".err")',
      '  W "relaunch requested"',
      '} catch { W ("relaunch failed: " + $_) }',
    ].join('\r\n')
    writeFileSync(scriptPath, script, 'utf8')
    state.upgrade = {
      status: 'starting',
      message: '已交给后台：先停服务，再安装 ' + version + ' 并自动重开。',
      logPath,
      acceptedAt: Date.now(),
    }
    const helper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    helper.unref()
    return snapshot()
  }

  // 1) index injection: forge the desktop carrier before every bundle.
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script', placement: 'head', text: carrierScript() })
  })

  // 2) HTTP routes the page-side bridge talks to. Mount only once webServer exists:
  //    at apply time the service may not be registered yet (apply order is not guaranteed).
  const mountRoutes = (webServer) => {
    if (webServer === undefined || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('[dsh-upgrader] no webServer service; update capsule routes are unavailable')
      return
    }

    /**
     * Wrap one route with loopback/origin/token guards; the POST body is parsed exactly once here.
     * @param {'GET'|'POST'} method
     * @param {string} name
     * @param {(req: import('node:http').IncomingMessage, body: unknown) => Promise<unknown>|unknown} handler
     */
    const route = (method, name, handler) => {
      const path = ROUTE_PREFIX + '/' + name
      const listener = async (req, res) => {
        try {
          if (req.method !== method) return sendJson(res, 405, { ok: false, message: method + ' only' })
          if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, message: 'loopback requests only' })
          let body
          if (method === 'POST') {
            if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, message: 'same-origin writes only' })
            const provided = req.headers[TOKEN_HEADER]
            if (typeof provided !== 'string' || provided !== actionToken) return sendJson(res, 403, { ok: false, message: 'stale action token; reopen the dialog' })
            body = await readJsonBody(req)
          }
          const result = await handler(req, body)
          sendJson(res, 200, result)
        } catch (error) {
          sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
        }
      }
      const dispose = webServer.register({ kind: 'exact', path, handler: listener })
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-upgrader: ' + path)
    }

    route('GET', 'status.json', () => snapshot())
    route('POST', 'check.json', async () => {
      await check()
      return snapshot()
    })
    route('POST', 'upgrade.json', async (_req, body) => {
      const input = body !== null && typeof body === 'object' ? body : {}
      if (input.confirm !== true) throw new Error('missing explicit confirmation')
      if (!state.updateAvailable || state.latestVersion === null) throw new Error('没有可升级的目标版本，请先检查更新')
      if (input.version !== state.latestVersion) throw new Error('确认的版本已过期，请重新检查')
      if (state.install.kind !== 'npm') throw new Error('当前安装形态不支持自动升级（只支持 npm 全局安装）')
      if (state.upgrade.status === 'starting' || state.upgrade.status === 'running') throw new Error('已有升级在进行中')
      startUpgrade(state.latestVersion)
      return snapshot()
    })
  }
  const initialWebServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (initialWebServer !== undefined) {
    mountRoutes(initialWebServer)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => mountRoutes(webCtx.get('webServer') ?? webCtx.webServer))
  } else {
    ctx.logger?.warn?.('[dsh-upgrader] cannot obtain the webServer service')
  }

  // 3) automatic checks
  if (settings.checkOnStart) {
    setTimeout(() => { check().catch(() => {}) }, 3000)
  }
  if (settings.checkIntervalHours > 0) {
    const timer = setInterval(() => { check().catch(() => {}) }, settings.checkIntervalHours * 3600 * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(timer), 'dsh-upgrader: check timer')
  }

  ctx.logger?.info?.('[dsh-upgrader] ready; installed=' + String(state.currentVersion) + ' channel=' + settings.channel)
}
