// Temporary diagnostic: does the main-process fetch honor AbortSignal.timeout
// in this Electron build, and what error appears when response headers hang?
const { app, net } = require('electron')
const http = require('http')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runTest(label, makeSignal, deadlineMs) {
  const t0 = Date.now()
  let outcome = 'STILL PENDING (signal ignored)'
  let settled = false
  const p = fetch(globalThis.__hangUrl, { signal: makeSignal() }).then(
    () => {
      settled = true
      outcome = 'resolved (unexpected)'
    },
    (e) => {
      settled = true
      const cause = e.cause ? ` | cause: ${e.cause.constructor?.name}: ${e.cause.message}` : ''
      outcome = `${e.constructor?.name ?? typeof e}: ${e.message}${cause}`
    }
  )
  p.catch(() => {}) // silence anything that lands after the deadline
  await Promise.race([p, sleep(deadlineMs)])
  console.log(`${label}: ${outcome} @ ${Date.now() - t0}ms (settled=${settled})`)
}

app.whenReady().then(async () => {
  console.log('electron:', process.versions.electron, '| node:', process.versions.node)
  try {
    console.log('global fetch === net.fetch:', fetch === net.fetch)
  } catch (e) {
    console.log('net.fetch comparison failed:', e.message)
  }

  const server = http.createServer(() => { /* accept, never send headers */ })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  globalThis.__hangUrl = `http://127.0.0.1:${server.address().port}/hang`

  await runTest('A AbortSignal.timeout(2000)', () => AbortSignal.timeout(2000), 10000)
  await runTest('B AbortController.abort()@2000', () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 2000)
    return ac.signal
  }, 10000)

  server.close()
  app.exit(0)
})

setTimeout(() => {
  console.log('FORCE EXIT - something hung')
  app.exit(2)
}, 30000)
