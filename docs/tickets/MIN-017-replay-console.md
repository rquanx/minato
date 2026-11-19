# MIN-017 测试编辑器与结果对比

里程碑为 M4 管理界面与单次测试。 [Ticket 索引](README.md)

直接依赖 [MIN-015](MIN-015-call-console.md)、[MIN-016](MIN-016-replay-execution.md)。 [相关设计](../implementation/delivery.md)

## 交付范围

- 提供新建测试及从历史调用打开的编辑页，可调整参数、选择测试模型并并排查看结果。

## 验收条件

- [x] 提交前可预览请求与目标。运行后可比较输出、模型、耗时和 token。
- [x] 测试和回放可以独立筛选，也计入真实供应商用量。

