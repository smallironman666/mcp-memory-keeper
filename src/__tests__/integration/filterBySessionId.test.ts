import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DatabaseManager } from '../../utils/database';
import { ContextRepository } from '../../repositories/ContextRepository';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

/**
 * Tests for filterBySessionId parameter in queryEnhanced
 *
 * Bug: When user specifies sessionId in context_get, the API should return
 * only items from that specific session (respecting privacy rules).
 *
 * Previous behavior: sessionId was only used for privacy checking, not filtering.
 * All public items from ALL sessions were returned regardless of sessionId.
 *
 * Fixed behavior: When sessionId is specified, only items from that session
 * are returned (public items always visible, private items only if current session).
 */
describe('filterBySessionId parameter in queryEnhanced', () => {
  let dbManager: DatabaseManager;
  let tempDbPath: string;
  let db: any;
  let contextRepo: ContextRepository;
  let sessionA: string;
  let sessionB: string;
  let sessionC: string;

  beforeEach(() => {
    tempDbPath = path.join(os.tmpdir(), `test-filter-session-${Date.now()}.db`);
    dbManager = new DatabaseManager({
      filename: tempDbPath,
      maxSize: 10 * 1024 * 1024,
      walMode: true,
    });
    db = dbManager.getDatabase();
    contextRepo = new ContextRepository(dbManager);

    // Create three test sessions
    sessionA = uuidv4();
    sessionB = uuidv4();
    sessionC = uuidv4();

    db.prepare('INSERT INTO sessions (id, name) VALUES (?, ?)').run(sessionA, 'Session A - Main');
    db.prepare('INSERT INTO sessions (id, name) VALUES (?, ?)').run(sessionB, 'Session B - Other');
    db.prepare('INSERT INTO sessions (id, name) VALUES (?, ?)').run(sessionC, 'Session C - Third');

    // Create test items in different sessions
    const testItems = [
      // Session A items
      {
        id: uuidv4(),
        session_id: sessionA,
        key: 'session-a-public-1',
        value: 'Public item 1 in session A',
        category: 'note',
        priority: 'normal',
        channel: 'main',
        created_at: new Date().toISOString(),
        is_private: 0,
      },
      {
        id: uuidv4(),
        session_id: sessionA,
        key: 'session-a-private-1',
        value: 'Private item 1 in session A',
        category: 'note',
        priority: 'high',
        channel: 'main',
        created_at: new Date().toISOString(),
        is_private: 1,
      },
      // Session B items
      {
        id: uuidv4(),
        session_id: sessionB,
        key: 'session-b-public-1',
        value: 'Public item 1 in session B',
        category: 'task',
        priority: 'normal',
        channel: 'main',
        created_at: new Date().toISOString(),
        is_private: 0,
      },
      {
        id: uuidv4(),
        session_id: sessionB,
        key: 'session-b-private-1',
        value: 'Private item 1 in session B',
        category: 'task',
        priority: 'normal',
        channel: 'main',
        created_at: new Date().toISOString(),
        is_private: 1,
      },
      // Session C items
      {
        id: uuidv4(),
        session_id: sessionC,
        key: 'session-c-public-1',
        value: 'Public item 1 in session C',
        category: 'reference',
        priority: 'low',
        channel: 'main',
        created_at: new Date().toISOString(),
        is_private: 0,
      },
    ];

    const insertStmt = db.prepare(`
      INSERT INTO context_items (id, session_id, key, value, category, priority, channel, created_at, is_private)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of testItems) {
      insertStmt.run(
        item.id,
        item.session_id,
        item.key,
        item.value,
        item.category,
        item.priority,
        item.channel,
        item.created_at,
        item.is_private
      );
    }
  });

  afterEach(() => {
    dbManager.close();
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  });

  describe('Without filterBySessionId (default behavior)', () => {
    it('should return all accessible items (public from all + private from current)', () => {
      const result = contextRepo.queryEnhanced({
        sessionId: sessionA, // Current session for privacy check
        // No filterBySessionId - should return all accessible items
      });

      // Should see:
      // - All public items (3 items from sessions A, B, C)
      // - Private items from sessionA (1 item)
      // Total: 4 items
      expect(result.items.length).toBe(4);

      const publicItems = result.items.filter(item => item.is_private === 0);
      const privateItems = result.items.filter(item => item.is_private === 1);

      expect(publicItems.length).toBe(3); // Public from A, B, C
      expect(privateItems.length).toBe(1); // Only private from A (current session)
      expect(privateItems[0].session_id).toBe(sessionA);
    });
  });

  describe('With filterBySessionId', () => {
    it('should return only items from the specified session', () => {
      const result = contextRepo.queryEnhanced({
        sessionId: sessionA, // Current session for privacy check
        filterBySessionId: sessionA, // Filter to only session A
      });

      // Should only see items from session A
      expect(result.items.length).toBe(2); // 1 public + 1 private
      expect(result.items.every(item => item.session_id === sessionA)).toBe(true);
    });

    it('should respect privacy when filtering another session', () => {
      const result = contextRepo.queryEnhanced({
        sessionId: sessionA, // Current session for privacy check
        filterBySessionId: sessionB, // Filter to session B
      });

      // Should only see public items from session B
      // (private items from B are not visible to A)
      expect(result.items.length).toBe(1);
      expect(result.items[0].key).toBe('session-b-public-1');
      expect(result.items[0].is_private).toBe(0);
    });

    it('should see all items when filtering own session', () => {
      const result = contextRepo.queryEnhanced({
        sessionId: sessionA, // Current session
        filterBySessionId: sessionA, // Filter to same session
      });

      // Should see both public and private items from session A
      expect(result.items.length).toBe(2);
      const keys = result.items.map(i => i.key).sort();
      expect(keys).toEqual(['session-a-private-1', 'session-a-public-1']);
    });

    it('should return empty when filtering session with only private items from another session', () => {
      // Create a session with only private items
      const privateOnlySession = uuidv4();
      db.prepare('INSERT INTO sessions (id, name) VALUES (?, ?)').run(
        privateOnlySession,
        'Private Only Session'
      );
      db.prepare(
        `
        INSERT INTO context_items (id, session_id, key, value, category, priority, channel, created_at, is_private)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        uuidv4(),
        privateOnlySession,
        'secret-item',
        'This is a secret',
        'note',
        'normal',
        'main',
        new Date().toISOString(),
        1 // Private
      );

      const result = contextRepo.queryEnhanced({
        sessionId: sessionA, // Current session (not privateOnlySession)
        filterBySessionId: privateOnlySession, // Filter to private-only session
      });

      // Should return no items (the only item is private and belongs to another session)
      expect(result.items.length).toBe(0);
    });

    it('should work with other filters combined', () => {
      const result = contextRepo.queryEnhanced({
        sessionId: sessionA,
        filterBySessionId: sessionA,
        category: 'note',
      });

      // Should return only note items from session A
      expect(result.items.length).toBe(2); // Both session A items are notes
      expect(result.items.every(item => item.category === 'note')).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle non-existent session gracefully', () => {
      const nonExistentSession = uuidv4();
      const result = contextRepo.queryEnhanced({
        sessionId: sessionA,
        filterBySessionId: nonExistentSession,
      });

      expect(result.items.length).toBe(0);
      expect(result.totalCount).toBe(0);
    });

    it('should handle undefined filterBySessionId same as not provided', () => {
      const resultWithUndefined = contextRepo.queryEnhanced({
        sessionId: sessionA,
        filterBySessionId: undefined,
      });

      const resultWithout = contextRepo.queryEnhanced({
        sessionId: sessionA,
      });

      expect(resultWithUndefined.items.length).toBe(resultWithout.items.length);
    });
  });
});
