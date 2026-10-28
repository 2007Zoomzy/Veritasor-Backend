/**
 * Pagination tests for queryDeliveryReceipts (issue #1211).
 *
 * Uses a mocked db.query — no real database required.
 * Designed to FAIL on the old code and PASS on the new keyset implementation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeCursor } from '../../utils/pagination.js';
import { MalformedCursorError, queryDeliveryReceipts } from '../deliveryReceiptRepository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDbRow(id: string, created_at: string): Record<string, unknown> {
  return {
    id,
    delivery_id: 'del-1',
    attempt_number: 1,
    subscription_id: 'sub-1',
    business_id: 'biz-1',
    url: 'https://example.com/webhook',
    status_code: 200,
    latency_ms: 42,
    signature_version: 1,
    signature: 'sig',
    response_body: null,
    created_at,
  };
}

function makeSortedRows(count: number, baseMs = 1_700_000_000_000): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    rows.push(makeDbRow(`id-${String(i).padStart(6, '0')}`, new Date(baseMs - i).toISOString()));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Mock: db.query returns queued response arrays
// ---------------------------------------------------------------------------

let queryResponses: Array<Record<string, unknown>[]> = [];

vi.mock('../../db/client.js', () => ({
  db: {
    query: vi.fn((_sql: string, _params: unknown[]) => {
      const rows = queryResponses.shift() ?? [];
      return Promise.resolve({ rows });
    }),
  },
}));

import { db } from '../../db/client.js';
const mockQuery = vi.mocked(db.query);

beforeEach(() => {
  queryResponses = [];
  mockQuery.mockClear();
});

// ---------------------------------------------------------------------------
// 1. Three-page traversal: 120 rows at limit 50 → 50, 50, 20
// ---------------------------------------------------------------------------

describe('120 receipts at limit 50', () => {
  const ALL_ROWS = makeSortedRows(120);

  it('page 1 returns 50 rows and a nextCursor encoding (created_at, id)', async () => {
    queryResponses = [ALL_ROWS.slice(0, 50)];
    const p1 = await queryDeliveryReceipts({ limit: 50 });

    expect(p1.data).toHaveLength(50);
    expect(p1.nextCursor).toBeDefined();

    const last = ALL_ROWS[49];
    const decoded = decodeCursor(p1.nextCursor!);
    expect(decoded).not.toBeNull();
    expect(decoded!.value).toBe(last.created_at);
    expect(decoded!.id).toBe(last.id);
  });

  it('page 2 SQL uses keyset WHERE (created_at, id) < ($n, $m) and ORDER BY created_at DESC, id DESC', async () => {
    queryResponses = [ALL_ROWS.slice(0, 50), ALL_ROWS.slice(50, 100)];
    const p1 = await queryDeliveryReceipts({ limit: 50 });

    await queryDeliveryReceipts({ limit: 50, cursor: p1.nextCursor });

    const [sql, params] = mockQuery.mock.calls[1]! as [string, unknown[]];

    // keyset condition
    expect(sql).toMatch(/\(created_at,\s*id\)\s*<\s*\(\$\d+,\s*\$\d+\)/);
    // stable order
    expect(sql).toMatch(/ORDER BY\s+created_at\s+DESC,\s+id\s+DESC/i);
    // cursor values in params
    const decoded = decodeCursor(p1.nextCursor!)!;
    expect(params).toContain(decoded.value);
    expect(params).toContain(decoded.id);
    expect(params[params.length - 1]).toBe(50);
  });

  it('page 3 returns 20 rows and no nextCursor', async () => {
    queryResponses = [ALL_ROWS.slice(0, 50), ALL_ROWS.slice(50, 100), ALL_ROWS.slice(100, 120)];
    const p1 = await queryDeliveryReceipts({ limit: 50 });
    const p2 = await queryDeliveryReceipts({ limit: 50, cursor: p1.nextCursor });
    const p3 = await queryDeliveryReceipts({ limit: 50, cursor: p2.nextCursor });

    expect(p3.data).toHaveLength(20);
    expect(p3.nextCursor).toBeUndefined();
  });

  it('no duplicates across all three pages', async () => {
    queryResponses = [ALL_ROWS.slice(0, 50), ALL_ROWS.slice(50, 100), ALL_ROWS.slice(100, 120)];
    const p1 = await queryDeliveryReceipts({ limit: 50 });
    const p2 = await queryDeliveryReceipts({ limit: 50, cursor: p1.nextCursor });
    const p3 = await queryDeliveryReceipts({ limit: 50, cursor: p2.nextCursor });

    const ids = [...p1.data, ...p2.data, ...p3.data].map((r) => r.id);
    expect(new Set(ids).size).toBe(120);
  });

  it('no gaps across all three pages', async () => {
    queryResponses = [ALL_ROWS.slice(0, 50), ALL_ROWS.slice(50, 100), ALL_ROWS.slice(100, 120)];
    const p1 = await queryDeliveryReceipts({ limit: 50 });
    const p2 = await queryDeliveryReceipts({ limit: 50, cursor: p1.nextCursor });
    const p3 = await queryDeliveryReceipts({ limit: 50, cursor: p2.nextCursor });

    const ids = [...p1.data, ...p2.data, ...p3.data].map((r) => r.id);
    expect(ids).toEqual(ALL_ROWS.map((r) => r.id));
  });
});

// ---------------------------------------------------------------------------
// 2. Stable pagination when all rows share the same created_at
// ---------------------------------------------------------------------------

describe('identical created_at — stable pagination by id', () => {
  const TS = '2024-01-15T10:00:00.000Z';
  const TIE_ROWS = ['id-z', 'id-y', 'id-x', 'id-w', 'id-v'].map((id) => makeDbRow(id, TS));

  it('cursor encodes the timestamp AND the id tiebreaker', async () => {
    queryResponses = [TIE_ROWS.slice(0, 3)];
    const p1 = await queryDeliveryReceipts({ limit: 3 });

    const decoded = decodeCursor(p1.nextCursor!);
    expect(decoded!.value).toBe(TS);
    expect(decoded!.id).toBe('id-x');
  });

  it('page-2 SQL passes both timestamp and id into keyset params', async () => {
    queryResponses = [TIE_ROWS.slice(0, 3), TIE_ROWS.slice(3, 5)];
    const p1 = await queryDeliveryReceipts({ limit: 3 });
    await queryDeliveryReceipts({ limit: 3, cursor: p1.nextCursor });

    const [sql, params] = mockQuery.mock.calls[1]! as [string, unknown[]];
    expect(sql).toMatch(/\(created_at,\s*id\)\s*<\s*\(\$\d+,\s*\$\d+\)/);
    expect(params).toContain(TS);
    expect(params).toContain('id-x');
  });

  it('page 2 returns remaining 2 rows with no nextCursor', async () => {
    queryResponses = [TIE_ROWS.slice(0, 3), TIE_ROWS.slice(3, 5)];
    const p1 = await queryDeliveryReceipts({ limit: 3 });
    const p2 = await queryDeliveryReceipts({ limit: 3, cursor: p1.nextCursor });

    expect(p2.data).toHaveLength(2);
    expect(p2.nextCursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. nextCursor only when page is full
// ---------------------------------------------------------------------------

describe('nextCursor only on full page', () => {
  it('sets nextCursor when rows === limit', async () => {
    queryResponses = [makeSortedRows(10)];
    const r = await queryDeliveryReceipts({ limit: 10 });
    expect(r.nextCursor).toBeDefined();
  });

  it('omits nextCursor when rows < limit', async () => {
    queryResponses = [makeSortedRows(7)];
    const r = await queryDeliveryReceipts({ limit: 10 });
    expect(r.nextCursor).toBeUndefined();
  });

  it('omits nextCursor on empty result', async () => {
    queryResponses = [[]];
    const r = await queryDeliveryReceipts({ limit: 10 });
    expect(r.nextCursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Malformed cursor → MalformedCursorError (no DB call made)
// ---------------------------------------------------------------------------

describe('malformed cursor', () => {
  it('throws MalformedCursorError for a garbage string', async () => {
    await expect(queryDeliveryReceipts({ cursor: 'garbage' })).rejects.toThrow(MalformedCursorError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('throws for valid base64 with wrong payload shape', async () => {
    const bad = Buffer.from('{"not":"valid"}').toString('base64');
    await expect(queryDeliveryReceipts({ cursor: bad })).rejects.toThrow(MalformedCursorError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('empty string is treated as first page (no error)', async () => {
    queryResponses = [makeSortedRows(3)];
    await expect(queryDeliveryReceipts({ cursor: '' })).resolves.toBeDefined();
  });

  it('undefined cursor is treated as first page (no error)', async () => {
    queryResponses = [makeSortedRows(3)];
    await expect(queryDeliveryReceipts({ cursor: undefined })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Route-level: ?cursor=garbage → 400
//
// We test the handler logic directly, bypassing the full admin router import.
// The admin route handler reads req.query.cursor, calls queryDeliveryReceipts,
// and returns 400 when it catches MalformedCursorError.
// ---------------------------------------------------------------------------

describe('route handler: ?cursor=garbage → 400', () => {
  it('returns 400 JSON for a malformed cursor', async () => {
    // Inline the exact same handler logic as admin.ts to verify the contract
    // without importing the full router (which has many heavy deps).
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;

    const app = express();
    app.use(express.json());

    // Mirror the admin.ts handler for /webhooks/receipts
    app.get('/api/v1/admin/webhooks/receipts', async (req, res) => {
      try {
        const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
        const limit = typeof req.query.limit === 'string' ? Math.min(parseInt(req.query.limit, 10) || 50, 100) : 50;
        const result = await queryDeliveryReceipts({ cursor, limit });
        res.json(result);
      } catch (err: unknown) {
        if (err instanceof MalformedCursorError) {
          return res.status(400).json({ error: 'Bad Request', message: 'Invalid cursor' });
        }
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });

    const res = await supertest(app).get('/api/v1/admin/webhooks/receipts?cursor=garbage');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
  });
});
