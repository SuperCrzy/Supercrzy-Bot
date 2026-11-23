/**
 * verify_claim — check whether the evidence actually supports a "does not exist" claim.
 *
 * The failure this exists for, observed in practice: a codebase audit searched the
 * compiled bundle for "mcp", found nothing, and concluded there was no MCP UI. The
 * UI was there, complete with create/edit/delete, in SettingsView.vue — the search
 * had looked at build output instead of source. "0 hits" and "0 database rows" are
 * not evidence of absence, and a model asked to judge on its own will treat them
 * as such whenever the search dimension is wrong.
 *
 * This tool is the rule, applied by something that cannot be talked out of it.
 * It does not search; it tells the caller whether what they have is enough, and
 * what is missing.
 */
import type { ToolDef } from './types'

/** What kind of check produced the evidence. Ordered from weakest to strongest. */
type EvidenceKind =
  | 'db_rows'          // SELECT count(*) — proves data state only
  | 'bundle_grep'      // searched compiled output / chunk names
  | 'filename'         // judged from a file or directory name
  | 'source_grep'      // grep over packages/*/src
  | 'source_read'      // read the implementation
  | 'runtime'          // ran it, saw the UI or the behaviour

const WEAK: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['db_rows', 'bundle_grep', 'filename'])
const STRONG: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['source_grep', 'source_read', 'runtime'])

export function assessAbsenceClaim(kinds: EvidenceKind[], distinctQuery = 1): {
  supports: boolean
  verdict: string
} {
  const strong = kinds.filter((k) => STRONG.has(k))
  const weak = kinds.filter((k) => WEAK.has(k))

  if (strong.length === 0) {
    return {
      supports: false,
      verdict:
        'NOT SUPPORTED. Every kind of evidence given is indirect: ' + (weak.join(', ') || '(none)') +
        '. Zeroes from a database count, a compiled-bundle grep or a file name only describe that one dimension — ' +
        'they cannot establish that a capability is missing. Search the source tree next ' +
        '(grep over packages/*/src for the feature name in both languages), then read the file you find.',
    }
  }
  // A single source grep that turned up nothing is still one dimension; two distinct
  // queries (e.g. the Chinese and English name) are the minimum to call it absent.
  if (strong.length === 1 && strong[0] === 'source_grep' && distinctQuery < 2) {
    return {
      supports: false,
      verdict:
        'NOT YET SUPPORTED. One source-text search is a single dimension. Try at least two distinct names ' +
        '(feature name in English and Chinese, plus any abbreviation) before concluding it is absent — ' +
        'a tab labelled "MCP" is not found by grepping for "connector", and vice versa.',
    }
  }
  return {
    supports: true,
    verdict:
      'SUPPORTED. Evidence includes ' + strong.join(', ') + (weak.length ? ' (plus ' + weak.join(', ') + ')' : '') +
      '. State the conclusion as [已核实] and cite the file and line you looked at.',
  }
}

const tool: ToolDef = {
  name: 'verify_claim',
  description: [
    'Before telling the user that something does NOT exist, is missing, or is unimplemented,',
    'call this with the evidence you actually gathered. It tells you whether that evidence is',
    'sufficient or which dimension is still unchecked.',
    'Never present an absence claim to the user without either passing this check or marking the',
    'claim as [推断] (inference) with the specific gap spelled out.',
  ].join(' '),
  category: 'memory',
  parameters: {
    type: 'object',
    properties: {
      claim: {
        type: 'string',
        description: 'The absence claim, e.g. "the client has no MCP management UI"',
      },
      evidence: {
        type: 'array',
        description: 'Every kind of check you ran, weakest or strongest — order does not matter',
        items: {
          type: 'string',
          enum: ['db_rows', 'bundle_grep', 'filename', 'source_grep', 'source_read', 'runtime'],
        },
      },
      distinctQueries: {
        type: 'number',
        description:
          'How many different search terms you used against the source tree (e.g. "mcp" and "连接器" = 2). Count distinct names, not repeats.',
        minimum: 1,
        maximum: 20,
      },
      locations: {
        type: 'array',
        description: 'Directories or files you actually searched or read, for the record',
        items: { type: 'string' },
      },
    },
    required: ['claim', 'evidence'],
  },
  async execute(args) {
    const claim = String(args.claim || '').trim()
    if (!claim) return '❌ 缺少 claim'
    const evidence = Array.isArray(args.evidence) ? (args.evidence as string[]) : []
    const valid = evidence.filter((e): e is EvidenceKind =>
      ['db_rows', 'bundle_grep', 'filename', 'source_grep', 'source_read', 'runtime'].includes(e))
    const distinct = Math.max(1, Number(args.distinctQueries) || 1)
    const locs = Array.isArray(args.locations) ? args.locations.map(String).slice(0, 8) : []

    const { supports, verdict } = assessAbsenceClaim(valid, distinct)
    const head = supports
      ? '✅ 证据充分，可以下否定结论'
      : '⛔ 证据不足，不能下否定结论'
    const locLine = locs.length ? `\n已检索位置: ${locs.join(', ')}` : ''
    return `${head}\n\n结论: ${claim}\n证据类型: ${valid.join(', ') || '(无)'}${locLine}\n\n${verdict}`
  },
}

export default tool
