import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

type VercelConfig = {
  rewrites: Array<{ source: string; destination: string }>
}

const vercelConfig = JSON.parse(
  readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
) as VercelConfig

describe('Vercel same-origin proxy configuration', () => {
  it('proxies API and Socket.IO paths before the SPA fallback', () => {
    assert.deepEqual(vercelConfig.rewrites, [
      {
        source: '/api/:path*',
        destination: 'https://swerv-backend.onrender.com/api/:path*',
      },
      {
        source: '/socket.io/:path*',
        destination: 'https://swerv-backend.onrender.com/socket.io/:path*',
      },
      { source: '/(.*)', destination: '/index.html' },
    ])
  })

  it('does not opt API and Socket.IO rewrites into Vercel response caching', () => {
    assert.equal('headers' in vercelConfig, false)
  })
})
