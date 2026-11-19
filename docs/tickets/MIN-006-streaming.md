# MIN-006 流式透传与取消

里程碑为 M1 本地推理链路。 [Ticket 索引](README.md)

直接依赖 [MIN-005](MIN-005-inference.md)。 [相关设计](../implementation/routing.md)

## 交付范围

- 转发 Chat 和 Responses 的 SSE，处理首个有效事件、背压、断开和请求期限。

## 验收条件

- [x] 首个有效事件前的可重试错误可以回退。已输出后中断时结束流并记录中断。
- [x] 客户端断开时向上游传播取消，流式输出的缓冲有上限。

