import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, BookOpen, Brain, ChevronRight, FileText, Plus, RefreshCw, Save, Sparkles } from 'lucide-react'
import type { CodexGlobalCatalog, CodexGlobalCategory, CodexGlobalDocument } from '@vibemobile/protocol'
import { api, ApiError } from '../lib/api'
import Sheet from './Sheet'
import FileBody, { isRenderable, SourcePreviewToggle } from './FileBody'
import { Button } from './ui/button'
import { Input } from './ui/input'

const CATEGORIES = [
  { id: 'rules' as const, title: '固定规则', description: '跨项目使用的全局指令', icon: BookOpen },
  { id: 'skills' as const, title: 'Skills', description: '浏览、编辑和新建全局技能', icon: Sparkles },
  { id: 'memory' as const, title: '记忆', description: '浏览和编辑 Codex 记忆文件', icon: Brain },
]

const ERRORS: Record<string, string> = {
  codex_global_invalid_path: '此文件不属于可管理的 Codex 全局文档，或链接指向了其他目录。',
  codex_global_not_found: '文件已不存在，请刷新列表。',
  codex_global_not_file: '此路径是目录，无法作为文件编辑。',
  codex_global_not_text: '此文件不是可编辑的文本。',
  codex_global_read_only: '文件过大或不是 UTF-8 编码，当前仅可浏览。',
  codex_global_too_large: '内容超过 512 KB，无法保存。',
  codex_global_invalid_text: '请输入有效的文本内容，大小不超过 512 KB。',
  codex_global_invalid_skill_name: '技能目录名限 1–64 个小写字母、数字和连字符，首尾须为字母或数字。',
  codex_global_invalid_skill: 'SKILL.md 需要以 YAML 头部开始，并包含非空的 name 和 description。',
  codex_global_skill_exists: '同名技能目录已存在，请使用其他名称。',
  codex_global_changed: '文件已被其他程序修改。草稿已保留，请重新读取文件后合并修改。',
  codex_global_io_error: '无法读写执行机上的文件，请检查文件权限后重试。',
}

function errorLabel(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return ERRORS[message] ?? message
}

export default function CodexGlobalSection() {
  const [category, setCategory] = useState<CodexGlobalCategory | null>(null)
  return (
    <section className="mt-7">
      <h2 className="mb-2 px-1 text-xs font-medium text-muted-foreground">Codex 全局设置</h2>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {CATEGORIES.map(({ id, title, description, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setCategory(id)}
            className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left active:bg-secondary"
          >
            <Icon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{title}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
            </span>
            <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
      </div>
      <p className="mt-2 px-1 text-[11px] leading-5 text-muted-foreground">
        管理当前执行机上的 Codex，全局内容供该用户的所有项目使用。
      </p>
      {category && <CodexGlobalManager category={category} onClose={() => setCategory(null)} />}
    </section>
  )
}

export function CodexGlobalManager({ category, onClose }: { category: CodexGlobalCategory; onClose: () => void }) {
  const [catalog, setCatalog] = useState<CodexGlobalCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [document, setDocument] = useState<CodexGlobalDocument | null>(null)
  const [reading, setReading] = useState(false)
  const [readAttempt, setReadAttempt] = useState(0)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState(true)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [creating, setCreating] = useState(false)
  const [skillName, setSkillName] = useState('')
  const [newSkillText, setNewSkillText] = useState('')
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setCatalog(await api.codexGlobal())
      setError(null)
    } catch (err) {
      setError(errorLabel(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    setReading(true)
    setError(null)
    setDocument(null)
    setEditing(false)
    setSaved(false)
    setConflict(false)
    api
      .codexGlobalDocument(selectedId)
      .then((result) => {
        if (cancelled) return
        setDocument(result)
        setDraft(result.text)
      })
      .catch((err) => {
        if (!cancelled) setError(errorLabel(err))
      })
      .finally(() => {
        if (!cancelled) setReading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, readAttempt])

  const dirty = creating ? Boolean(skillName || newSkillText) : editing && draft !== document?.text
  function leave(action: () => void) {
    if (busy) return
    if (dirty) setDiscardAction(() => action)
    else {
      setError(null)
      action()
    }
  }
  function back() {
    leave(() => {
      setSelectedId(null)
      setDocument(null)
      setCreating(false)
      setEditing(false)
      setSaved(false)
      setSkillName('')
      setNewSkillText('')
    })
  }
  async function save() {
    if (!document || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.saveCodexGlobalDocument({
        id: document.entry.id,
        text: draft,
        revision: document.revision,
      })
      setDocument(result)
      setDraft(result.text)
      setEditing(false)
      setSaved(true)
      setConflict(false)
      // Refresh metadata without clearing the file or its saved feedback.
      api
        .codexGlobal()
        .then(setCatalog)
        .catch(() => undefined)
    } catch (err) {
      setError(errorLabel(err))
      setConflict(err instanceof ApiError && err.code === 'codex_global_changed')
    } finally {
      setBusy(false)
    }
  }
  async function create() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const text =
        newSkillText ||
        `---\nname: ${skillName.trim()}\ndescription: 在此描述技能的用途和触发条件。\n---\n\n# ${skillName.trim()}\n\n在此填写执行步骤。\n`
      const result = await api.createCodexGlobalSkill({ name: skillName.trim(), text })
      setCreating(false)
      setSkillName('')
      setNewSkillText('')
      setSelectedId(result.entry.id)
      api
        .codexGlobal()
        .then(setCatalog)
        .catch(() => undefined)
    } catch (err) {
      setError(errorLabel(err))
    } finally {
      setBusy(false)
    }
  }

  const title = CATEGORIES.find((item) => item.id === category)!.title
  const entries = (catalog?.entries ?? []).filter(
    (entry) =>
      entry.category === category &&
      `${entry.title} ${entry.relativePath} ${entry.source}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  )
  return (
    <Sheet
      title={creating ? '新建 Skill' : (document?.entry.title ?? title)}
      closeLabel="关闭"
      onClose={() => leave(onClose)}
      dismissable={!busy}
      footer={
        <div className="space-y-2">
          {error && (
            <p role="alert" className="break-words text-xs leading-5 text-destructive">
              {error}
            </p>
          )}
          {saved && (
            <p role="status" className="text-xs text-success">
              已保存到当前执行机。已有会话可能仍保留旧上下文。
            </p>
          )}
          {discardAction ? (
            <div className="space-y-2">
              <p className="text-sm">有未保存的内容，是否放弃？</p>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={() => setDiscardAction(null)}>
                  继续编辑
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    discardAction()
                    setDiscardAction(null)
                    setError(null)
                  }}
                >
                  放弃更改
                </Button>
              </div>
            </div>
          ) : creating ? (
            <Button
              type="button"
              className="min-h-11 w-full"
              onClick={() => void create()}
              disabled={busy || !skillName.trim()}
            >
              {busy ? '创建中…' : '创建技能'}
            </Button>
          ) : editing ? (
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                className="min-h-11"
                disabled={busy}
                onClick={() => {
                  setDraft(document?.text ?? '')
                  setEditing(false)
                  setError(null)
                  setConflict(false)
                }}
              >
                取消编辑
              </Button>
              <Button
                type="button"
                className="min-h-11 flex-1"
                onClick={() => void save()}
                disabled={busy || !dirty || conflict}
              >
                <Save aria-hidden="true" className="size-4" />
                {busy ? '保存中…' : '保存'}
              </Button>
            </div>
          ) : document?.editable ? (
            <Button
              type="button"
              className="min-h-11 w-full"
              onClick={() => {
                setEditing(true)
                setSaved(false)
              }}
            >
              {document.entry.exists ? '编辑' : '创建并编辑'}
            </Button>
          ) : selectedId && !reading && !document ? (
            <Button type="button" variant="secondary" onClick={() => setReadAttempt((value) => value + 1)}>
              重试读取
            </Button>
          ) : null}
          {conflict && (
            <Button type="button" variant="outline" onClick={() => leave(() => setReadAttempt((value) => value + 1))}>
              放弃草稿并重新读取
            </Button>
          )}
        </div>
      }
    >
      <div className="min-h-48 space-y-3 px-4 pt-2 pb-4">
        {(selectedId || creating) && (
          <Button type="button" variant="ghost" className="-ml-2 min-h-11" onClick={back} disabled={busy}>
            <ArrowLeft aria-hidden="true" className="size-4" />
            返回{title}
          </Button>
        )}
        {creating ? (
          <div className="space-y-3">
            <label htmlFor="codex-skill-name" className="block space-y-1.5 text-sm">
              技能目录名
              <Input
                id="codex-skill-name"
                value={skillName}
                onChange={(event) => setSkillName(event.target.value)}
                placeholder="例如 release-check"
                disabled={busy}
              />
            </label>
            <p className="text-xs leading-5 text-muted-foreground">
              创建在执行机的用户技能目录，供所有项目使用。留空技能内容时会生成可编辑的模板。
            </p>
            <label className="block space-y-1.5 text-sm">
              技能内容
              <textarea
                aria-label="新技能内容"
                value={newSkillText}
                onChange={(event) => setNewSkillText(event.target.value)}
                disabled={busy}
                placeholder="可填写带 name 和 description 的 SKILL.md 内容"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="min-h-64 w-full rounded-xl border border-input bg-background p-3 font-mono text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>
        ) : selectedId ? (
          reading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">读取中…</p>
          ) : (
            document && (
              <>
                <p className="break-all font-mono text-[11px] leading-5 text-muted-foreground">{document.entry.path}</p>
                {category === 'rules' && (
                  <p className="text-xs leading-5 text-muted-foreground">
                    AGENTS.override.md 存在时优先于 AGENTS.md。只编辑需要生效的规则文件。
                  </p>
                )}
                {category === 'memory' && (
                  <p className="text-xs leading-5 text-muted-foreground">
                    这些文件由 Codex 整理，后续自动整理可能更新内容。
                  </p>
                )}
                {document.entry.source === '插件技能' && (
                  <p className="text-xs leading-5 text-muted-foreground">插件更新可能覆盖这里的修改。</p>
                )}
                {document.files.length > 1 && (
                  <label className="block text-xs text-muted-foreground">
                    技能文件
                    <select
                      aria-label="技能文件"
                      value={document.entry.id}
                      disabled={busy}
                      onChange={(event) => leave(() => setSelectedId(event.target.value))}
                      className="mt-1 min-h-11 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground"
                    >
                      {document.files.map((file) => (
                        <option key={file.id} value={file.id}>
                          {file.relativePath}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {!document.editable && (
                  <p role="status" className="text-xs text-warning">
                    {document.truncated
                      ? '文件超过 512 KB，仅展示前半部分，不能编辑。'
                      : '文件不是 UTF-8 编码，当前仅可浏览。'}
                  </p>
                )}
                {editing ? (
                  <textarea
                    aria-label="文档内容"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    disabled={busy}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="min-h-[42dvh] w-full resize-y rounded-xl border border-input bg-background p-3 font-mono text-[16px] leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">{document.entry.source}</span>
                      {isRenderable(document.entry.path) && (
                        <SourcePreviewToggle preview={preview} onChange={setPreview} />
                      )}
                    </div>
                    {document.text ? (
                      <div className="overflow-hidden rounded-xl border border-border">
                        <FileBody
                          path={document.entry.path}
                          content={{
                            path: document.entry.path,
                            text: document.text,
                            truncated: document.truncated,
                            bytes: document.entry.bytes,
                          }}
                          preview={preview}
                        />
                      </div>
                    ) : (
                      <p className="py-8 text-center text-sm text-muted-foreground">
                        {document.entry.exists ? '文件内容为空。' : '尚未创建，编辑保存后生效。'}
                      </p>
                    )}
                  </>
                )}
              </>
            )
          )
        ) : (
          <>
            <p className="text-xs leading-5 text-muted-foreground">当前执行机 · 用户全局配置</p>
            {catalog && <p className="break-all font-mono text-[11px] text-muted-foreground">{catalog.codexHome}</p>}
            {category === 'memory' && catalog && (
              <p className="text-xs leading-5 text-muted-foreground">
                {catalog.memoryEnabled === false
                  ? '全局配置已关闭记忆，仍可浏览已有文件。'
                  : catalog.memoryEnabled === true
                    ? '全局配置已启用记忆。'
                    : '记忆开关沿用 Codex 默认值或启动配置。'}
              </p>
            )}
            <div className="flex gap-2">
              <Input
                aria-label={`搜索${title}`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`搜索${title}`}
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="shrink-0"
                aria-label="刷新列表"
                disabled={loading}
                onClick={() => void load()}
              >
                <RefreshCw aria-hidden="true" className="size-4" />
              </Button>
              {category === 'skills' && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setError(null)
                    setCreating(true)
                  }}
                >
                  <Plus aria-hidden="true" className="size-4" />
                  新建
                </Button>
              )}
            </div>
            {catalog?.warnings.map((warning) => (
              <p key={warning} className="text-xs leading-5 text-warning">
                {warning}
              </p>
            ))}
            {loading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">读取中…</p>
            ) : entries.length ? (
              <div className="divide-y divide-border rounded-xl border border-border">
                {entries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="flex min-h-16 w-full items-center gap-3 px-3 py-3 text-left active:bg-secondary"
                    onClick={() => setSelectedId(entry.id)}
                  >
                    <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-medium">{entry.title}</span>
                      <span className="mt-1 block break-all text-[11px] text-muted-foreground">
                        {entry.source} · {entry.relativePath}
                        {!entry.exists && ' · 尚未创建'}
                      </span>
                    </span>
                    <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            ) : (
              <p className="py-8 text-center text-sm leading-6 text-muted-foreground">
                {query
                  ? '没有匹配的文件。'
                  : category === 'memory'
                    ? '尚无记忆文件。Codex 生成后可在这里浏览和编辑。'
                    : '尚无全局技能，可以新建一个。'}
              </p>
            )}
          </>
        )}
      </div>
    </Sheet>
  )
}
