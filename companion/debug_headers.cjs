// What error does a fetch produce when response headers hang and NO abort
// signal is attached? Test 1 overrides the dispatcher with a short 3s
// headersTimeout. Test 2 (background variant) uses the built-in defaults.
const { app } = require('electron')
const http = require('http')

const mode = process.argv[2] || 'short'

app.whenReady().then(async () => {
  const server = http.createServer(() => { /* never respond */ })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/hang`

  if (mode === 'short') {
    const { Agent, setGlobalDispatcher } = require('undici')
    setGlobalDispatcher(new Agent({ headersTimeout: 3000 }))
  }

  const t0 = Date.now()
  let outcome = 'still pending'
  const p = fetch(url).then(
    (res) => { outcome = `resolved status=${res.status}` },
    (e) => {
      const cause = e.cause ? ` | cause: ${e.cause.constructor?.name ?? '?'}: ${e.cause.message}` : ''
      outcome = `${e.constructor?.name ?? typeof e}: ${e.message}${cause}`
    }
  )
  p.catch(() => {})
  const cap = mode === 'short' ? 20000 : 320000
  await Promise.race([p, new Promise((r) => setTimeout(r, cap))])
  console.log(`[${mode}] after ${Date.now() - t0}ms -> ${outcome}`)
  server.close()
  app.exit(0)
})
