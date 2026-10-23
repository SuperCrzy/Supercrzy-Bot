/**
 * Retrieval invariants for `tool-search-index`.
 *
 * These assert the two ways the old implementation failed:
 *   1. a Chinese query matched nothing at all (names are English, only names were searched);
 *   2. a query with no match dumped the whole catalogue instead of saying "nothing found".
 *
 * Fixtures mirror the real tool descriptions (they are Chinese in production, which is exactly why
 * description indexing is required).
 */
import { describe, it, expect } from 'vitest'
import { buildIndex, searchIndex, tokenize, getToolIndex, signatureOf } from './tool-search-index'

const DOCS = [
  { name: 'bg_task', description: '管理后台任务：list 列出（状态/已运行时长/最后输出多久前）/ output 读增量输出 / cancel 取消。' },
  { name: 'generate_image', description: '用 AI 生成图片（文生图）。支持 op 为：generate(文生图)。' },
  { name: 'terminal_open', description: '打开一个持久终端会话（仅完全访问权限）。终端可后台运行长任务。' },
  { name: 'draw_diagram', description: '绘制矢量图（架构图/流程图/对比示意图）。直接给出完整 SVG 代码。' },
  { name: 'git_commit', description: '提交 git 变更。' },
  { name: 'video_edit', description: '用 ffmpeg 处理视频/音频。' },
]
const INDEX = buildIndex(DOCS)

const names = (q: string, k = 8) => searchIndex(INDEX, q, k).map((h) => h.name)

describe('tool-search-index 检索', () => {
  it('中文按 bigram 建索引（没有分词器也能召回）', () => {
    const toks = tokenize('后台任务')
    expect(toks).toContain('后台')
    expect(toks).toContain('任务')
  })

  it('中文 query 能命中中文描述（旧实现必然 0 命中）', () => {
    expect(names('后台任务')[0]).toBe('bg_task')
    expect(names('生成图片')[0]).toBe('generate_image')
    expect(names('架构图')[0]).toBe('draw_diagram')
    expect(names('视频')[0]).toBe('video_edit')
  })

  it('英文名查询仍然可用，且精确名排第一', () => {
    expect(names('bg_task')[0]).toBe('bg_task')
    // 前缀/子串也能命中（覆盖 term → terminal_* 这类输入）
    expect(names('terminal')[0]).toBe('terminal_open')
    expect(names('git')[0]).toBe('git_commit')
  })

  it('无匹配时返回空数组 —— 绝不把全量清单倒给模型', () => {
    expect(names('zzz-nonexistent')).toEqual([])
    expect(names('量子纠缠')).toEqual([])
  })

  it('结果数不超过 limit，且按分数降序', () => {
    const hits = searchIndex(INDEX, '任务', 2)
    expect(hits.length).toBeLessThanOrEqual(2)
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score)
    }
  })

  it('别名把"用户会说但不写在描述里"的词接到正确工具（视频 → video_edit 排第一）', () => {
    const idx = buildIndex([
      { name: 'make_article', description: '写长文，支持多段结构与引用。' },
      { name: 'video_edit', description: '用 ffmpeg 处理媒体文件。' },
    ])
    const hits = searchIndex(idx, '视频')
    expect(hits[0]?.name).toBe('video_edit')
  })

  it('相对截断：远低于最高分的弱命中被丢掉（不把噪声塞给模型）', () => {
    const idx = buildIndex([
      { name: 'bg_task', description: '管理后台任务：列出、读输出、取消。' },
      { name: 'read_me', description: '读取说明文档，偶尔提到任务。' },
    ])
    const hits = searchIndex(idx, '后台任务')
    expect(hits[0].name).toBe('bg_task')
    expect(hits.map((h) => h.name)).not.toContain('read_me')
  })

  it('索引按目录签名缓存：目录没变不重建，变了自动失效', () => {
    const a = getToolIndex(DOCS)
    const b = getToolIndex(DOCS)
    expect(a).toBe(b)
    const c = getToolIndex([...DOCS, { name: 'new_tool', description: '新工具' }])
    expect(c).not.toBe(a)
    expect(signatureOf(DOCS)).not.toBe(signatureOf([...DOCS, { name: 'new_tool', description: '新工具' }]))
  })
})
