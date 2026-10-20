// Postgres schema — port of 9Drive's Prisma schema with serverless corrections (tech.md §3).
// Sizes are bigint. Enums mirror tech.md §3 status fields. Migrations generated via drizzle-kit.
import {
  pgTable, pgEnum, uuid, varchar, text, bigint, integer, boolean,
  timestamp, jsonb, uniqueIndex, index, primaryKey, type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---- enums ----
export const providerKind = pgEnum('provider_kind', ['google_drive', 's3']);
export const accountStatus = pgEnum('account_status', ['connected', 'needs_reauth', 'disabled', 'degraded']);
export const fileStatus = pgEnum('file_status', ['active', 'deleted', 'purged']);
export const uploadStatus = pgEnum('upload_status', ['initiated', 'uploading', 'completed', 'failed', 'aborted']);
export const chunkStatus = pgEnum('chunk_status', ['pending', 'committed']);
export const shareRole = pgEnum('share_role', ['viewer']); // never 'writer' (L6 fix)

const ts = (dflt = sql`now()`) => timestamp('created_at', { withTimezone: true }).notNull().default(dflt);

// ---- users (identity lives in Firebase Auth) ----
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  firebaseUid: varchar('firebase_uid', { length: 128 }).notNull().unique(),
  email: varchar('email', { length: 255 }).notNull(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: ts(),
});

// ---- accounts (connected storage providers) ----
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: providerKind('provider').notNull(),
  label: varchar('label', { length: 255 }).notNull(), // email (Drive) or user label (S3)
  status: accountStatus('status').notNull().default('connected'),
  providerAccountId: varchar('provider_account_id', { length: 255 }),
  rootFolderId: varchar('root_folder_id', { length: 255 }), // Drive app root
  // tokens — AES-256-GCM at rest (vault); never logged
  accessTokenEnc: text('access_token_enc'),
  refreshTokenEnc: text('refresh_token_enc'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  // S3-only fields (nullable)
  s3Endpoint: text('s3_endpoint'),
  s3Region: varchar('s3_region', { length: 64 }),
  s3Bucket: varchar('s3_bucket', { length: 255 }),
  s3AccessKeyEnc: text('s3_access_key_enc'),
  s3SecretKeyEnc: text('s3_secret_key_enc'),
  s3Prefix: varchar('s3_prefix', { length: 255 }),
  quotaBytes: bigint('quota_bytes', { mode: 'bigint' }),
  lastError: text('last_error'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  createdAt: ts(),
}, (t) => [
  uniqueIndex('accounts_user_provider_label').on(t.userId, t.provider, t.label),
  index('accounts_user_status').on(t.userId, t.status),
]);

// ---- storage_usage (quota invariant target; 1 row per account) ----
export const storageUsage = pgTable('storage_usage', {
  accountId: uuid('account_id').primaryKey().references(() => accounts.id, { onDelete: 'cascade' }),
  totalBytes: bigint('total_bytes', { mode: 'bigint' }),
  usedBytes: bigint('used_bytes', { mode: 'bigint' }).notNull().default(0n),
  availableBytes: bigint('available_bytes', { mode: 'bigint' }),
  trashBytes: bigint('trash_bytes', { mode: 'bigint' }).notNull().default(0n),
  reservedBytes: bigint('reserved_bytes', { mode: 'bigint' }).notNull().default(0n),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
});

// ---- folders (virtual namespace — metadata only) ----
export const folders = pgTable('folders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id').references((): AnyPgColumn => folders.id), // null = root; explicit AnyPgColumn breaks tsc's self-reference cycle
  name: varchar('name', { length: 512 }).notNull(),
  color: varchar('color', { length: 32 }),
  icon: varchar('icon', { length: 64 }),
  pinnedAccountId: uuid('pinned_account_id').references(() => accounts.id),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: ts(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  index('folders_user_parent').on(t.userId, t.parentId, t.deletedAt),
]);

// ---- files (metadata separate from physical bytes) ----
export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  folderId: uuid('folder_id').references(() => folders.id),
  provider: providerKind('provider').notNull(),
  providerFileId: varchar('provider_file_id', { length: 255 }).notNull(),
  name: varchar('name', { length: 512 }).notNull(),
  mimeType: varchar('mime_type', { length: 255 }).notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
  checksumSha256: varchar('checksum_sha256', { length: 64 }),
  status: fileStatus('status').notNull().default('active'),
  // P1 striping
  stripeIndex: integer('stripe_index'),
  stripeCount: integer('stripe_count'),
  parentFileId: uuid('parent_file_id').references((): AnyPgColumn => files.id), // self-ref: explicit AnyPgColumn breaks tsc's cycle
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: ts(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  index('files_user_status_folder_created').on(t.userId, t.status, t.folderId, t.createdAt),
  index('files_user_status_name').on(t.userId, t.status, t.name),
  uniqueIndex('files_account_provider_file').on(t.accountId, t.providerFileId),
]);

// ---- file_stripes (P1 striping) ----
export const fileStripes = pgTable('file_stripes', {
  fileId: uuid('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
  index: integer('index').notNull(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  providerObjectId: varchar('provider_object_id', { length: 255 }).notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
  offsetBytes: bigint('offset_bytes', { mode: 'bigint' }).notNull(),
}, (t) => [primaryKey({ columns: [t.fileId, t.index] })]);

// ---- uploads (resumable session) ----
export const uploads = pgTable('uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clientUploadId: uuid('client_upload_id').notNull(), // idempotency key from client
  fileName: varchar('file_name', { length: 512 }).notNull(),
  mimeType: varchar('mime_type', { length: 255 }).notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
  folderId: uuid('folder_id').references(() => folders.id),
  chunkSize: integer('chunk_size').notNull(),
  totalChunks: integer('total_chunks').notNull(),
  status: uploadStatus('status').notNull().default('initiated'),
  accountId: uuid('account_id').references(() => accounts.id),
  providerSessionUri: text('provider_session_uri'), // Drive resumable URI — server-only, never to client
  targetRootFolderId: varchar('target_root_folder_id', { length: 255 }),
  stripePlan: jsonb('stripe_plan'), // P1
  error: text('error'),
  createdAt: ts(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('uploads_user_client').on(t.userId, t.clientUploadId),
  index('uploads_user_status').on(t.userId, t.status),
]);

// ---- upload_chunks (resume source of truth) ----
export const uploadChunks = pgTable('upload_chunks', {
  uploadId: uuid('upload_id').notNull().references(() => uploads.id, { onDelete: 'cascade' }),
  index: integer('index').notNull(),
  status: chunkStatus('status').notNull().default('pending'),
  sizeBytes: bigint('size_bytes', { mode: 'bigint' }),
  providerOffset: bigint('provider_offset', { mode: 'bigint' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [primaryKey({ columns: [t.uploadId, t.index] })]);

// ---- reservations (DB-backed placement reservations; replace 9Drive's in-memory map) ----
export const reservations = pgTable('reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  uploadId: uuid('upload_id').references(() => uploads.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  bytes: bigint('bytes', { mode: 'bigint' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [index('reservations_account').on(t.accountId)]);

// ---- shares (reader-only, expiring) ----
export const shares = pgTable('shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  fileId: uuid('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(), // SHA-256; raw never stored
  enabled: boolean('enabled').notNull().default(true),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  role: shareRole('role').notNull().default('viewer'),
  createdAt: ts(),
}, (t) => [index('shares_token_hash').on(t.tokenHash)]);

// ---- preview_tokens ----
export const previewTokens = pgTable('preview_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  fileId: uuid('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [index('preview_tokens_token_hash').on(t.tokenHash)]);

// ---- api_keys ----
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  keyPrefix: varchar('key_prefix', { length: 12 }).notNull(), // shown in list for identification
  keyHash: varchar('key_hash', { length: 64 }).notNull().unique(), // SHA-256 of full key
  scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: ts(),
});

// ---- oauth_states (connect-a-account flow) ----
// state is bound to the initiating user: the Google callback arrives as a top-level
// redirect with NO bearer token, so user_id here is how we know whose account this is.
export const oauthStates = pgTable('oauth_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: providerKind('provider').notNull(),
  stateHash: varchar('state_hash', { length: 64 }).notNull().unique(),
  flow: varchar('flow', { length: 64 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: ts(),
}, (t) => [index('oauth_states_user').on(t.userId)]);

// ---- audit_logs ----
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: varchar('action', { length: 64 }).notNull(),
  entityType: varchar('entity_type', { length: 64 }).notNull(),
  entityId: uuid('entity_id'),
  metadata: jsonb('metadata'),
  createdAt: ts(),
}, (t) => [index('audit_logs_user_created').on(t.userId, t.createdAt)]);
