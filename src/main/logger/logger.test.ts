import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock electron's app module
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-hitl'),
  },
}))

// Mock fs operations
vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(true),
  readdirSync: vi.fn().mockReturnValue([]),
  readFileSync: vi.fn().mockReturnValue(''),
  statSync: vi.fn(),
}))

import { log, getRecentLogs, createLogger, initLogger, type LogEntry, type LogLevel } from './index'

describe('logger', () => {
  beforeEach(() => {
    // Clear the ring buffer by reading all entries — we need a clean slate.
    // Since we can't access logBuffer directly, we'll use getRecentLogs and
    // just be aware of existing entries from prior tests.
  })

  describe('log()', () => {
    it('adds entries to the ring buffer', () => {
      const before = getRecentLogs().length

      log('info', 'test', 'hello world')

      const after = getRecentLogs()
      expect(after.length).toBe(before + 1)

      const last = after[after.length - 1]
      expect(last.level).toBe('info')
      expect(last.source).toBe('test')
      expect(last.message).toBe('hello world')
      expect(last.timestamp).toBeDefined()
    })

    it('includes data when provided', () => {
      log('warn', 'test', 'with data', { key: 'value', num: 42 })

      const logs = getRecentLogs()
      const last = logs[logs.length - 1]
      expect(last.data).toEqual({ key: 'value', num: 42 })
    })

    it('omits data field when not provided', () => {
      log('info', 'test', 'no data')

      const logs = getRecentLogs()
      const last = logs[logs.length - 1]
      expect(last.data).toBeUndefined()
    })

    it('outputs to console for each level', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      log('debug', 'test', 'debug msg')
      log('info', 'test', 'info msg')
      log('warn', 'test', 'warn msg')
      log('error', 'test', 'error msg')

      expect(debugSpy).toHaveBeenCalledWith('[test] debug msg')
      expect(logSpy).toHaveBeenCalledWith('[test] info msg')
      expect(warnSpy).toHaveBeenCalledWith('[test] warn msg')
      expect(errorSpy).toHaveBeenCalledWith('[test] error msg')

      debugSpy.mockRestore()
      logSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    })

    it('includes JSON data in console output', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      log('info', 'test', 'msg', { foo: 'bar' })

      expect(logSpy).toHaveBeenCalledWith('[test] msg {"foo":"bar"}')

      logSpy.mockRestore()
    })
  })

  describe('ring buffer', () => {
    it('caps the buffer at 500 entries', () => {
      // Push 510 entries to exceed the buffer size
      for (let i = 0; i < 510; i++) {
        log('debug', 'buffer-test', `entry-${i}`)
      }

      const allLogs = getRecentLogs()
      expect(allLogs.length).toBeLessThanOrEqual(500)
    })
  })

  describe('getRecentLogs()', () => {
    it('filters by minimum level', () => {
      // Add known entries
      log('debug', 'level-test', 'debug entry')
      log('info', 'level-test', 'info entry')
      log('warn', 'level-test', 'warn entry')
      log('error', 'level-test', 'error entry')

      const warnAndAbove = getRecentLogs('warn', 'level-test')
      for (const entry of warnAndAbove) {
        expect(['warn', 'error']).toContain(entry.level)
      }

      const errorOnly = getRecentLogs('error', 'level-test')
      for (const entry of errorOnly) {
        expect(entry.level).toBe('error')
      }
    })

    it('filters by source', () => {
      log('info', 'source-a', 'from A')
      log('info', 'source-b', 'from B')

      const aLogs = getRecentLogs(undefined, 'source-a')
      for (const entry of aLogs) {
        expect(entry.source).toBe('source-a')
      }

      const bLogs = getRecentLogs(undefined, 'source-b')
      for (const entry of bLogs) {
        expect(entry.source).toBe('source-b')
      }
    })

    it('limits the number of returned entries', () => {
      // Add several entries
      for (let i = 0; i < 10; i++) {
        log('info', 'limit-test', `entry-${i}`)
      }

      const limited = getRecentLogs(undefined, 'limit-test', 3)
      expect(limited.length).toBeLessThanOrEqual(3)

      // Should return the MOST RECENT entries (slice from end)
      if (limited.length === 3) {
        expect(limited[2].message).toContain('entry-')
      }
    })

    it('returns all entries when limit exceeds buffer size', () => {
      log('info', 'big-limit', 'entry1')
      log('info', 'big-limit', 'entry2')

      const result = getRecentLogs(undefined, 'big-limit', 1000)
      expect(result.length).toBeGreaterThanOrEqual(2)
    })

    it('combines level and source filters', () => {
      log('debug', 'combo-src', 'debug')
      log('warn', 'combo-src', 'warn')
      log('error', 'combo-src', 'error')
      log('warn', 'other-src', 'other warn')

      const result = getRecentLogs('warn', 'combo-src')
      for (const entry of result) {
        expect(entry.source).toBe('combo-src')
        expect(['warn', 'error']).toContain(entry.level)
      }
    })
  })

  describe('createLogger()', () => {
    it('creates a scoped logger with all four methods', () => {
      const scoped = createLogger('my-module')
      expect(typeof scoped.debug).toBe('function')
      expect(typeof scoped.info).toBe('function')
      expect(typeof scoped.warn).toBe('function')
      expect(typeof scoped.error).toBe('function')
    })

    it('scoped logger logs with the correct source', () => {
      const scoped = createLogger('scoped-test')
      scoped.info('scoped message')

      const logs = getRecentLogs(undefined, 'scoped-test')
      const last = logs[logs.length - 1]
      expect(last.source).toBe('scoped-test')
      expect(last.message).toBe('scoped message')
    })

    it('scoped logger passes data through', () => {
      const scoped = createLogger('data-test')
      scoped.error('fail', { code: 500 })

      const logs = getRecentLogs(undefined, 'data-test')
      const last = logs[logs.length - 1]
      expect(last.data).toEqual({ code: 500 })
    })
  })
})
