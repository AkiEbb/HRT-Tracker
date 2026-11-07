export {
  DEK_RECOVERY_AAD,
  DEK_WRAP_AAD,
  type RecordAadInput,
  recordAad,
  SHARE_KEY_AAD,
} from './aad'
export {
  decodeSealed,
  encodeSealed,
  open,
  type Sealed,
  seal,
  sealWithNonce,
  utf8,
} from './aead'
export {
  createKeys,
  DEK_BYTES,
  decodeRecord,
  encodeRecord,
  newDek,
  openRecord,
  type RecordMeta,
  type SealedRecord,
  sealRecord,
  type UnlockedKeys,
  unwrapDekWithKek,
  unwrapDekWithRecovery,
  wrapDekWithKek,
  wrapDekWithRecovery,
} from './envelope'
export { CryptoError, type CryptoErrorCode } from './errors'
export {
  deriveKek,
  KDF_PARAMS,
  type KdfParams,
  newSalt,
  SALT_BYTES,
} from './kdf'
export { KEY_BYTES, NONCE_BYTES, randomBytes, TAG_BYTES } from './random'
export {
  generateRecoveryPhrase,
  isValidRecoveryPhrase,
  normalizePhrase,
  phraseToEntropy,
  RECOVERY_WORDS,
  recoveryToKek,
} from './recovery'
