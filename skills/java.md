---
name: java
trigger: "*.java"
severity_weight: 1.2
---

# Java 专项审查

只审 Java 语言特有缺陷（通用逻辑问题由 correctness 负责，不要重复报告）：

1. **空安全**：Optional.get() 未判 isPresent；自动拆箱 NPE（Integer==int 比较）；
   equals 调用方向（常量应在前）；Map.get 结果直接解引用
2. **资源**：Closeable 未用 try-with-resources；Stream 未关闭；连接池借出未归还
3. **并发**：SimpleDateFormat 等非线程安全对象做成员变量；double-checked locking 缺 volatile；
   ConcurrentModificationException 风险（遍历中修改集合）；CompletableFuture 异常被吞
4. **集合与相等性**：重写 equals 不重写 hashCode；可变对象做 Map key；
   Arrays.asList 返回的定长列表被 add/remove
5. **事务与框架惯用坑**（Spring 场景）：@Transactional 自调用失效、
   catch 后未 rethrow 导致事务不回滚；@Async 方法内部调用无效
6. **BigDecimal**：金额用 double 构造 BigDecimal；equals 与 compareTo 混用

判定：正常业务路径可触发 → critical/serious；纯风格不报。
