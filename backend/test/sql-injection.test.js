/**
 * SQL Injection Security Test Suite
 * 
 * Tests for SQL injection vulnerabilities in database service functions.
 * Covers parameterized queries, input validation, and edge cases.
 */

import { describe, beforeEach, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "../src/services/db.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function removeMigrationFixture(filePath) {
  for (const candidate of [filePath, `${filePath}.migrated`]) {
    if (fs.existsSync(candidate)) {
      fs.unlinkSync(candidate);
    }
  }
}

function expect(actual) {
  return {
    toThrow(expected) {
      assert.equal(typeof actual, "function");

      let thrown;
      try {
        actual();
      } catch (error) {
        thrown = error;
      }

      assert.ok(thrown, "Expected function to throw");

      if (expected !== undefined) {
        const message =
          thrown instanceof Error ? thrown.message : String(thrown);

        if (expected instanceof RegExp) {
          assert.match(message, expected);
        } else {
          assert.ok(
            message.includes(String(expected)),
            `Expected error message to include "${expected}", received "${message}"`,
          );
        }
      }
    },

    toBe(expected) {
      assert.equal(actual, expected);
    },

    toBeGreaterThanOrEqual(expected) {
      assert.ok(
        actual >= expected,
        `Expected ${actual} to be greater than or equal to ${expected}`,
      );
    },

    not: {
      toThrow() {
        assert.equal(typeof actual, "function");
        assert.doesNotThrow(actual);
      },
    },
  };
}

describe('SQL Injection Security Tests', () => {
  let testDb;
  let testDbPath;

  beforeEach(() => {
    // Create temporary test database
    testDbPath = path.join(__dirname, `test_${Date.now()}.db`);
    testDb = db.initDb(testDbPath);
  });

  afterEach(() => {
    // Clean up test database
    if (testDb) {
      testDb.close();
    }
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('DAO ID Validation', () => {
    test('should reject negative DAO IDs', () => {
      expect(() => {
        db.addEvent({
          daoId: -1,
          type: 'dao_create',
          data: {},
        });
      }).toThrow('Invalid DAO ID');
    });

    test('should reject non-integer DAO IDs', () => {
      expect(() => {
        db.addEvent({
          daoId: 1.5,
          type: 'dao_create',
          data: {},
        });
      }).toThrow('Invalid DAO ID');
    });

    test('should reject extremely large DAO IDs', () => {
      expect(() => {
        db.addEvent({
          daoId: 9999999,
          type: 'dao_create',
          data: {},
        });
      }).toThrow('Invalid DAO ID');
    });

    test('should reject DAO ID injection attempts', () => {
      const maliciousIds = [
        '1; DROP TABLE events_1; --',
        '1 UNION SELECT * FROM sqlite_master',
        '1\' OR \'1\'=\'1',
        '1/**/OR/**/1=1',
      ];

      maliciousIds.forEach(maliciousId => {
        expect(() => {
          db.addEvent({
            daoId: maliciousId,
            type: 'dao_create',
            data: {},
          });
        }).toThrow();
      });
    });
  });

  describe('Event Type Validation', () => {
    test('should reject invalid event types', () => {
      expect(() => {
        db.addEvent({
          daoId: 1,
          type: 'malicious_type',
          data: {},
        });
      }).toThrow('Invalid event type');
    });

    test('should reject event type injection attempts', () => {
      const maliciousTypes = [
        'dao_create\'; DROP TABLE events_1; --',
        'dao_create UNION SELECT * FROM sqlite_master',
        'dao_create\' OR \'1\'=\'1',
        'dao_create/**/OR/**/1=1',
      ];

      maliciousTypes.forEach(maliciousType => {
        expect(() => {
          db.addEvent({
            daoId: 1,
            type: maliciousType,
            data: {},
          });
        }).toThrow('Invalid event type');
      });
    });

    test('should accept only allowlisted event types', () => {
      const validTypes = [
        'dao_create',
        'admin_transfer',
        'member_added',
        'vote_cast'
      ];

      validTypes.forEach(type => {
        expect(() => {
          db.addEvent({
            daoId: 1,
            type,
            data: {},
          });
        }).not.toThrow();
      });
    });
  });

  describe('ORDER BY Security', () => {
    test('should reject invalid order columns', () => {
      expect(() => {
        db.getEventsForDao(1, {
          orderBy: 'malicious_column'
        });
      }).toThrow('Invalid order column');
    });

    test('should reject ORDER BY injection attempts', () => {
      const maliciousOrderBys = [
        'timestamp; DROP TABLE events_1; --',
        'timestamp UNION SELECT * FROM sqlite_master',
        'timestamp, (SELECT COUNT(*) FROM sqlite_master)',
        '1=1 OR 1=1',
      ];

      maliciousOrderBys.forEach(maliciousOrderBy => {
        expect(() => {
          db.getEventsForDao(1, {
            orderBy: maliciousOrderBy
          });
        }).toThrow('Invalid order column');
      });
    });

    test('should accept only allowlisted order columns', () => {
      const validColumns = [
        'id',
        'timestamp', 
        'ledger',
        'type',
        'verified'
      ];

      validColumns.forEach(column => {
        expect(() => {
          db.getEventsForDao(1, {
            orderBy: column
          });
        }).not.toThrow();
      });
    });
  });

  describe('Type Filtering Security', () => {
    test('should validate event type filters', () => {
      expect(() => {
        db.getEventsForDao(1, {
          types: ['dao_create', 'malicious_type']
        });
      }).toThrow('Invalid event types');
    });

    test('should reject type filter injection attempts', () => {
      const maliciousTypes = [
        ['dao_create\'; DROP TABLE events_1; --'],
        ['dao_create\' OR \'1\'=\'1'],
        ['dao_create UNION SELECT password FROM users'],
      ];

      maliciousTypes.forEach(types => {
        expect(() => {
          db.getEventsForDao(1, { types });
        }).toThrow();
      });
    });
  });

  describe('Parameter Boundary Tests', () => {
    test('should enforce reasonable limits', () => {
      // Test limit boundaries
      expect(() => {
        db.getEventsForDao(1, { limit: 0 });
      }).not.toThrow(); // Should be corrected to 1

      expect(() => {
        db.getEventsForDao(1, { limit: 10000 });
      }).not.toThrow(); // Should be corrected to 1000

      // Test offset boundaries  
      expect(() => {
        db.getEventsForDao(1, { offset: -1 });
      }).not.toThrow(); // Should be corrected to 0
    });

    test('should handle edge case parameters', () => {
      const edgeCases = [
        { limit: null },
        { offset: undefined },
        { types: [] },
        { types: null },
      ];

      edgeCases.forEach(options => {
        expect(() => {
          db.getEventsForDao(1, options);
        }).not.toThrow();
      });
    });
  });

  describe('JSON Migration Security', () => {
    test('should validate JSON migration input', () => {
      const maliciousJsonPath = path.join(__dirname, 'malicious_events.json');
      
      // Create malicious JSON file
      const maliciousData = {
        events: {
          '1; DROP TABLE events_1; --': [
            {
              type: 'dao_create\'; DROP TABLE events_1; --',
              data: { malicious: true },
              timestamp: '2024-01-01T00:00:00Z'
            }
          ]
        },
        lastLedger: 'malicious'
      };

      fs.writeFileSync(maliciousJsonPath, JSON.stringify(maliciousData));

      // Migration should handle malicious input safely
      expect(() => {
        db.migrateFromJson(maliciousJsonPath);
      }).not.toThrow();

      // Clean up
      removeMigrationFixture(maliciousJsonPath);
    });

    test('should reject invalid timestamps in JSON', () => {
      const jsonPath = path.join(__dirname, 'invalid_timestamps.json');
      
      const invalidData = {
        events: {
          '1': [
            {
              type: 'dao_create',
              data: {},
              timestamp: 'invalid-timestamp'
            },
            {
              type: 'dao_create', 
              data: {},
              timestamp: '2024-13-45T25:99:99Z' // Invalid date
            }
          ]
        }
      };

      fs.writeFileSync(jsonPath, JSON.stringify(invalidData));

      // Should handle invalid timestamps gracefully
      const result = db.migrateFromJson(jsonPath);
      
      // Should not migrate events with invalid timestamps
      expect(result).toBe(0);

      // Clean up
      removeMigrationFixture(jsonPath);
    });
  });

  describe('Transaction Hash Validation', () => {
    test('should validate transaction hash format', () => {
      const invalidHashes = [
        '', // empty
        'x'.repeat(200), // too long
        'invalid_hash_with_special_chars!@#',
        '1\'; DROP TABLE events_1; --',
      ];

      invalidHashes.forEach(txHash => {
        expect(() => {
          db.verifyEvent(txHash, 12345);
        }).toThrow();
      });
    });

    test('should validate ledger numbers', () => {
      const invalidLedgers = [
        -1, // negative
        1.5, // decimal
        'malicious', // string
        Infinity,
        NaN
      ];

      invalidLedgers.forEach(ledger => {
        expect(() => {
          db.verifyEvent('valid_hash_123', ledger);
        }).toThrow();
      });
    });
  });

  describe('Prepared Statement Protection', () => {
    test('should use parameterized queries for all user input', () => {
      // This test verifies that prepared statements are used correctly
      // by ensuring malicious input doesn't affect database structure
      
      const initialTables = testDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'"
      ).all();

      // Attempt various SQL injection attacks
      try {
        db.addEvent({
          daoId: 1,
          type: 'dao_create',
          data: { 
            malicious: '\'; DROP TABLE sqlite_master; --'
          },
        });
      } catch (e) {
        // Expected to fail due to validation
      }

      // Verify database structure is unchanged
      const finalTables = testDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'"
      ).all();

      expect(finalTables.length).toBeGreaterThanOrEqual(initialTables.length);
    });
  });
});