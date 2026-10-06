import { Buffer } from 'node:buffer'
import { createHash, createPublicKey, verify } from 'node:crypto'

export interface Key {
  id: Buffer
  key: Buffer
}

export interface Signature {
  algorithm: Buffer
  keyID: Buffer
  signature: Buffer
  trustedComment: Buffer
  globalSignature: Buffer
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const UNTRUSTED_HEADER = Buffer.from('untrusted comment: ')
const TRUSTED_HEADER = Buffer.from('trusted comment: ')

/** Parse a minisign public key represented as a base64 string. Throws on invalid keys. */
export const parseKey = (keyString: string): Key => {
  const keyInfo = Buffer.from(keyString, 'base64')

  const id = keyInfo.subarray(2, 10)
  const key = keyInfo.subarray(10)

  if (key.byteLength !== 32) {
    throw new Error('invalid public key given')
  }

  return { id, key }
}

const readLine = (buffer: Buffer): { line: Buffer, rest: Buffer } => {
  const end = buffer.indexOf('\n')
  if (end === -1) return { line: buffer, rest: Buffer.alloc(0) }
  return { line: buffer.subarray(0, end), rest: buffer.subarray(end + 1) }
}

/** Parse the contents of a minisign signature file. Throws on invalid signature files. */
export const parseSignature = (sigBuf: Buffer): Signature => {
  if (!sigBuf.subarray(0, UNTRUSTED_HEADER.length).equals(UNTRUSTED_HEADER)) {
    throw new Error('invalid minisign signature: bad untrusted comment header')
  }

  const untrustedLine = readLine(sigBuf.subarray(UNTRUSTED_HEADER.length))
  const sigInfoLine = readLine(untrustedLine.rest)
  const sigInfo = Buffer.from(sigInfoLine.line.toString(), 'base64')
  const algorithm = sigInfo.subarray(0, 2)
  const keyID = sigInfo.subarray(2, 10)
  const signature = sigInfo.subarray(10)

  if (!sigInfoLine.rest.subarray(0, TRUSTED_HEADER.length).equals(TRUSTED_HEADER)) {
    throw new Error('invalid minisign signature: bad trusted comment header')
  }

  const commentLine = readLine(sigInfoLine.rest.subarray(TRUSTED_HEADER.length))
  const globalSigLine = readLine(commentLine.rest)

  return {
    algorithm,
    keyID,
    signature,
    trustedComment: commentLine.line,
    globalSignature: Buffer.from(globalSigLine.line.toString(), 'base64'),
  }
}

/** Given a parsed key, signature and raw file content, verifies both the signature and its trusted comment. */
export const verifySignature = (pubkey: Key, signature: Signature, fileContent: Buffer): boolean => {
  if (!signature.keyID.equals(pubkey.id)) return false

  const signedContent = signature.algorithm.equals(Buffer.from('ED'))
    ? createHash('blake2b512').update(fileContent).digest()
    : fileContent

  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, pubkey.key]),
    format: 'der',
    type: 'spki',
  })

  if (!verify(null, signedContent, publicKey, signature.signature)) return false

  const globalSignedContent = Buffer.concat([signature.signature, signature.trustedComment])
  return verify(null, globalSignedContent, publicKey, signature.globalSignature)
}
