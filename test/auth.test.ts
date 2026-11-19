import { describe, it, expect, vi } from 'vitest'

vi.mock('@atproto/xrpc-server', async (orig) => {
  const actual: any = await orig()
  return { ...actual, verifyJwt: vi.fn() }
})

import { verifyJwt, AuthRequiredError } from '@atproto/xrpc-server'
import { validateAuth } from '../src/auth'

const mockVerify = verifyJwt as any
const req = (authorization?: string, url = '/xrpc/app.bsky.feed.getFeedSkeleton?feed=x') =>
  ({ headers: authorization === undefined ? {} : { authorization }, url, originalUrl: url }) as any

describe('validateAuth', () => {
  it('rejects a missing authorization header with AuthRequiredError', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(validateAuth(req(), 'did:web:x', {} as any)).rejects.toBeInstanceOf(AuthRequiredError)
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it('rejects a non-Bearer scheme', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(validateAuth(req('Basic abc'), 'did:web:x', {} as any)).rejects.toBeInstanceOf(AuthRequiredError)
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it('verifies the trimmed jwt against service did and nsid, returning the issuer', async () => {
    mockVerify.mockResolvedValue({ iss: 'did:plc:user' })
    const did = await validateAuth(req('Bearer  tok.en.x '), 'did:web:svc', {} as any)
    expect(did).toBe('did:plc:user')
    const [jwt, aud, nsid] = mockVerify.mock.calls[0]
    expect(jwt).toBe('tok.en.x')
    expect(aud).toBe('did:web:svc')
    expect(nsid).toBe('app.bsky.feed.getFeedSkeleton')
  })

  it('resolves the signing key through the DidResolver', async () => {
    mockVerify.mockImplementation(async (_j: string, _a: string, _n: string, getKey: any) => ({
      iss: await getKey('did:plc:abc'),
    }))
    const resolver = { resolveAtprotoKey: vi.fn().mockResolvedValue('did:key:zKey') }
    expect(await validateAuth(req('Bearer t'), 'did:web:svc', resolver as any)).toBe('did:key:zKey')
    expect(resolver.resolveAtprotoKey).toHaveBeenCalledWith('did:plc:abc')
  })

  it('propagates verification failures', async () => {
    mockVerify.mockRejectedValue(new Error('jwt expired'))
    await expect(validateAuth(req('Bearer t'), 'did:web:svc', {} as any)).rejects.toThrow('jwt expired')
  })
})
