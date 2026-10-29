/**
 * The empty list has two opposite causes: a search that matched nothing, and a
 * list that really has nothing. They need different advice — telling someone
 * to create a session when they just searched is answering the wrong question.
 */
export default function SessionListEmpty({
  query,
  showArchived,
  filter,
  providerName,
}: {
  query: string
  showArchived: boolean
  filter: string
  providerName: (id: string) => string
}) {
  return (
    <div className="px-8 py-20 text-center">
      {query ? (
        <>
          <p className="text-sm text-muted-foreground">没有匹配「{query}」的会话</p>
          {/* Said plainly because it is a real limitation of both backends:
              the search looks at titles, never at what was said. */}
          <p className="mt-1 text-[12px] text-muted-foreground/70">只搜索标题，不搜索对话内容</p>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {showArchived ? '归档里没有会话' : filter === 'all' ? '还没有会话' : `${providerName(filter)} 还没有会话`}
          </p>
          <p className="mt-1 text-[12px] text-muted-foreground/70">
            {/* The archive gets its own line because the advice that fits every
                other empty list — create one — cannot produce an archived
                session: nothing is archived until something is. */}
            {showArchived
              ? '归档的会话会出现在这里，可以再取消归档'
              : filter === 'all'
                ? '点右下角 + 新建一个，让代理在项目目录里干活'
                : '切到「全部」看看其他代理的会话'}
          </p>
        </>
      )}
    </div>
  )
}
