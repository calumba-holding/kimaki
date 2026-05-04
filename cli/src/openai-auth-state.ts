/**
 * OpenAI OAuth account store and rotation.
 * Mirrors anthropic-auth-state.ts but for OpenAI/Codex OAuth accounts.
 * Piggybacks on opencode's built-in CodexAuthPlugin for auth; this module
 * only manages the rotation pool and account switching.
 *
 * Store file: ~/.local/share/opencode/openai-oauth-accounts.json
 * Migration: on first load, copies from multicodex-accounts.json if present.
 */

import type { Plugin } from '@opencode-ai/plugin'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  type AccountStore,
  type OAuthStored,
  type RotationResult,
  type AccountIdentity,
  accountLabel,
  authFilePath,
  findCurrentAccountIndex,
  isOAuthStored,
  normalizeAccountStore,
  readJson,
  upsertAccount,
  withAuthStateLock,
  writeJson,
} from './oauth-rotation-shared.js'

export { type OAuthStored, type AccountStore, type RotationResult, type AccountIdentity }
export { accountLabel, upsertAccount }

// --- Store file path ---

export function openaiAccountsFilePath() {
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, 'opencode', 'openai-oauth-accounts.json')
  }
  return path.join(homedir(), '.local', 'share', 'opencode', 'openai-oauth-accounts.json')
}

// Legacy multicodex store path for migration
function legacyMulticodexStorePath() {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config')
  return path.join(configDir, 'opencode', 'multicodex-accounts.json')
}

// --- Store I/O ---

let migrationAttempted = false

export async function loadOpenAIAccountStore(): Promise<AccountStore> {
  const storePath = openaiAccountsFilePath()
  let raw = await readJson<Partial<AccountStore> | null>(storePath, null)

  // One-time migration from multicodex-accounts.json
  if (!raw && !migrationAttempted) {
    migrationAttempted = true
    const legacyPath = legacyMulticodexStorePath()
    const legacy = await readJson<Partial<AccountStore> | null>(legacyPath, null)
    if (legacy && Array.isArray(legacy.accounts) && legacy.accounts.length > 0) {
      raw = legacy
      // Persist to new location so migration only happens once
      await writeJson(storePath, normalizeAccountStore(raw))
    }
  }

  return normalizeAccountStore(raw)
}

export async function saveOpenAIAccountStore(store: AccountStore) {
  await writeJson(openaiAccountsFilePath(), normalizeAccountStore(store))
}

// --- Current account ---

export type CurrentOpenAIAccount = {
  auth: OAuthStored
  account?: OAuthStored & AccountIdentity
  index?: number
}

export async function getCurrentOpenAIAccount(): Promise<CurrentOpenAIAccount | null> {
  const authJson = await readJson<Record<string, unknown>>(authFilePath(), {})
  const auth = authJson.openai
  if (!isOAuthStored(auth)) {
    return null
  }

  const store = await loadOpenAIAccountStore()
  const index = findCurrentAccountIndex(store, auth)
  const account = store.accounts[index]
  if (!account) {
    return { auth }
  }

  if (account.refresh !== auth.refresh && account.access !== auth.access) {
    return { auth }
  }

  return { auth, account, index }
}

// --- Auth file write + SDK sync ---

async function writeOpenAIAuthFile(auth: OAuthStored | undefined) {
  const file = authFilePath()
  const data = await readJson<Record<string, unknown>>(file, {})
  if (auth) {
    data.openai = auth
  } else {
    delete data.openai
  }
  await writeJson(file, data)
}

export async function setOpenAIAuth(
  auth: OAuthStored,
  client: Parameters<Plugin>[0]['client'],
) {
  await writeOpenAIAuthFile(auth)
  await client.auth.set({ path: { id: 'openai' }, body: auth })
}

// --- Remember new login ---

export async function rememberOpenAIOAuth(
  auth: OAuthStored,
  identity?: AccountIdentity,
) {
  await withAuthStateLock(async () => {
    const store = await loadOpenAIAccountStore()
    upsertAccount(store, { ...auth, ...identity })
    await saveOpenAIAccountStore(store)
  })
}

/**
 * Detect if the current auth.json openai entry is a new account not yet in
 * our rotation pool. If so, upsert it. Returns the identity if a new account
 * was added, undefined otherwise.
 */
export async function detectAndRememberNewOpenAIAccount(): Promise<AccountIdentity | undefined> {
  const authJson = await readJson<Record<string, unknown>>(authFilePath(), {})
  const auth = authJson.openai
  if (!isOAuthStored(auth)) return undefined

  const store = await loadOpenAIAccountStore()

  // Check if this refresh token is already known
  const known = store.accounts.some(
    (account) => account.refresh === auth.refresh || account.access === auth.access,
  )
  if (known) return undefined

  // New account detected. Try to extract identity from the auth object
  // (opencode's codex plugin may store accountId on the auth entry)
  const authWithIdentity = auth as OAuthStored & { accountId?: string; email?: string }
  const identity: AccountIdentity = {
    email: typeof authWithIdentity.email === 'string' ? authWithIdentity.email : undefined,
    accountId: typeof authWithIdentity.accountId === 'string' ? authWithIdentity.accountId : undefined,
  }

  await withAuthStateLock(async () => {
    // Re-read inside lock to avoid race
    const freshStore = await loadOpenAIAccountStore()
    const alreadyKnown = freshStore.accounts.some(
      (account) => account.refresh === auth.refresh || account.access === auth.access,
    )
    if (alreadyKnown) return
    upsertAccount(freshStore, { ...auth, ...identity })
    await saveOpenAIAccountStore(freshStore)
  })

  return identity
}

// --- Rotation ---

export async function rotateOpenAIAccount(
  auth: OAuthStored,
  client: Parameters<Plugin>[0]['client'],
): Promise<RotationResult | undefined> {
  return withAuthStateLock(async () => {
    const store = await loadOpenAIAccountStore()
    if (store.accounts.length < 2) return undefined

    const currentIndex = findCurrentAccountIndex(store, auth)
    const currentAccount = store.accounts[currentIndex]
    const nextIndex = (currentIndex + 1) % store.accounts.length
    const nextAccount = store.accounts[nextIndex]
    if (!nextAccount) return undefined

    const fromLabel = currentAccount
      ? accountLabel(currentAccount, currentIndex)
      : accountLabel(auth, currentIndex)

    nextAccount.lastUsed = Date.now()
    store.activeIndex = nextIndex
    await saveOpenAIAccountStore(store)

    const nextAuth: OAuthStored = {
      type: 'oauth',
      refresh: nextAccount.refresh,
      access: nextAccount.access,
      expires: nextAccount.expires,
    }
    await setOpenAIAuth(nextAuth, client)
    return {
      auth: nextAuth,
      fromLabel,
      toLabel: accountLabel(nextAccount, nextIndex),
      fromIndex: currentIndex,
      toIndex: nextIndex,
    }
  })
}

// --- Remove account ---

export async function removeOpenAIAccount(index: number) {
  return withAuthStateLock(async () => {
    const store = await loadOpenAIAccountStore()
    if (!Number.isInteger(index) || index < 0 || index >= store.accounts.length) {
      throw new Error(`Account ${index + 1} does not exist`)
    }

    store.accounts.splice(index, 1)
    if (store.accounts.length === 0) {
      store.activeIndex = 0
      await saveOpenAIAccountStore(store)
      await writeOpenAIAuthFile(undefined)
      return { store, active: undefined }
    }

    if (store.activeIndex > index) {
      store.activeIndex -= 1
    } else if (store.activeIndex >= store.accounts.length) {
      store.activeIndex = 0
    }

    const active = store.accounts[store.activeIndex]
    if (!active) throw new Error('Active OpenAI account disappeared during removal')
    active.lastUsed = Date.now()
    await saveOpenAIAccountStore(store)
    const nextAuth: OAuthStored = {
      type: 'oauth',
      refresh: active.refresh,
      access: active.access,
      expires: active.expires,
    }
    await writeOpenAIAuthFile(nextAuth)
    return { store, active: nextAuth }
  })
}
