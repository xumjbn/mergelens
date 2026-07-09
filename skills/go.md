---
name: go
trigger: "*.go"
severity_weight: 1.2
---

# Go 专项审查

只审 Go 代码的语言特有缺陷（通用逻辑问题由 correctness 维度负责，不要重复报告）：

1. **错误处理**
   - `err` 被忽略（`_ = f()` 或干脆没接收）；`if err != nil` 里返回了 nil
   - `:=` 在内层作用域意外遮蔽（shadow）外层 err/变量，导致错误丢失
   - `errors.Is/As` 该用没用，直接 `==` 比较包装过的错误
2. **并发**
   - goroutine 泄漏：没有退出路径、channel 永远没人收/发导致永久阻塞
   - `for` 循环变量被 goroutine/闭包捕获（Go 1.22 之前逐次共享）
   - map 并发读写没加锁；`sync.WaitGroup.Add` 在 goroutine 内部调用
   - `context` 没往下传、`cancel()` 没 defer、用 `context.Background()` 断链
3. **defer 与资源**
   - 循环体内 defer（函数结束才执行，资源堆积）
   - `defer resp.Body.Close()` 在 err 检查之前（resp 可能为 nil）
   - Close/Rollback 的错误被吞
4. **切片与 map**
   - 子切片共享底层数组导致的意外修改（该 copy 没 copy）
   - 向 nil map 写入；append 结果没有赋回
5. **其他惯用坑**
   - time.After 在 for-select 里每轮泄漏 timer
   - 结构体大对象按值传递进热路径；interface nil 判断陷阱（typed nil）
   - JSON 反序列化字段没导出（小写开头）导致静默丢数据

判定标准：能在正常并发/错误路径下触发的 → critical/serious；风格与微优化不报。
每条发现的 detail 中说明触发条件（什么时序/什么输入会出事）。
