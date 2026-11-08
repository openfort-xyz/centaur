import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProactivityRules, proactiveLayers, resolveProactivityRules } from './proactivity-rules'

describe('proactivity rules', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { force: true, recursive: true })
  })

  function writeRules(files: Record<string, string>): string {
    dir = mkdtempSync(join(tmpdir(), 'googlechat-proactivity-rules-'))
    // Mirror a mounted ConfigMap: files are symlinks into a hidden data dir.
    mkdirSync(join(dir, '..data'))
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, '..data', name), content)
      symlinkSync(join('..data', name), join(dir, name))
    }
    return dir
  }

  test('load ordered default rules that space rule files replace or turn off', () => {
    writeRules({
      'default.json': JSON.stringify([{ name: 'services', when: 'Questions about our services.\n' }]),
      'AAAALERTS.json': JSON.stringify([
        { context: '\nCheck the dashboards first.\n', name: 'alert', when: 'A firing alert.' },
        { name: 'rollback', when: 'A rollback request.', context: '  ' }
      ]),
      'AAAASOCIAL.json': '[]'
    })
    writeFileSync(join(dir, 'README.txt'), 'not rules')

    const rules = loadProactivityRules(dir)

    expect(resolveProactivityRules(rules, 'spaces/AAAAOTHER')).toEqual([
      { name: 'services', when: 'Questions about our services.' }
    ])
    expect(resolveProactivityRules(rules, 'spaces/AAAALERTS')).toEqual([
      { context: 'Check the dashboards first.', name: 'alert', when: 'A firing alert.' },
      { name: 'rollback', when: 'A rollback request.' }
    ])
    expect(resolveProactivityRules(rules, 'spaces/AAAASOCIAL')).toBeUndefined()
    expect(rules.spaces).not.toHaveProperty('README')
  })

  test('reject a rule file that is not a list of named rules with criteria', () => {
    for (const content of [
      '{"name": "x", "when": "y"}',
      '[{"name": "x"}]',
      '[{"name": "x", "when": "y"}, {"name": "x", "when": "z"}]',
      '[{"name": "x", "when": "y"}, {"name": " x ", "when": "z"}]',
      '[{"name": " ", "when": "y"}]',
      JSON.stringify(Array.from({ length: 21 }, (_, index) => ({ name: `r${index}`, when: 'y' }))),
      'not json'
    ]) {
      writeRules({ 'AAAABAD.json': content })
      expect(() => loadProactivityRules(dir)).toThrow()
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test('throw to the caller when the rules directory cannot be read', () => {
    expect(() => loadProactivityRules(join(tmpdir(), 'missing-googlechat-proactivity-rules'))).toThrow()
  })

  test('apply no rules when none are configured', () => {
    expect(resolveProactivityRules({}, 'spaces/AAAAOTHER')).toBeUndefined()
    expect(resolveProactivityRules(undefined, 'spaces/AAAAOTHER')).toBeUndefined()
  })
})

describe('proactive layers', () => {
  const rules = [{ name: 'alert', when: 'A firing alert.' }]

  test('a joined thread answers people; rules answer people and other apps', () => {
    expect(proactiveLayers(undefined, { proactiveEligible: true }, 'person')).toEqual(['mentioned'])
    expect(proactiveLayers(undefined, { proactiveEligible: true }, 'app')).toEqual([])
    expect(proactiveLayers(rules, {}, 'person')).toEqual(['rules'])
    expect(proactiveLayers(rules, {}, 'app')).toEqual(['rules'])
    expect(proactiveLayers(rules, { proactiveEligible: true }, 'person')).toEqual(['mentioned', 'rules'])
    expect(proactiveLayers(rules, { proactiveEligible: true }, 'app')).toEqual(['rules'])
  })

  test('a stop silences rules in its thread, and no rules means no layer', () => {
    expect(proactiveLayers(rules, { proactiveEligible: false }, 'person')).toEqual([])
    expect(proactiveLayers(rules, { proactiveEligible: false }, 'app')).toEqual([])
    expect(proactiveLayers(undefined, {}, 'person')).toEqual([])
  })
})
