---
name: python
trigger: "*.py"
severity_weight: 1.2
---

# Python 专项审查

只审 Python 语言特有缺陷（通用逻辑问题由 correctness 负责，不要重复报告）：

1. **可变默认参数**：`def f(x, items=[])` —— 跨调用共享状态
2. **异常**：裸 `except:` / `except Exception: pass` 吞错；异常链丢失（raise 无 from）；
   finally 里 return 覆盖异常
3. **闭包与作用域**：循环变量被 lambda/闭包延迟绑定；列表推导变量泄漏误用
4. **类型与相等**：`is` 比较字符串/数字（小整数缓存陷阱）；bool 是 int 的子类导致的分支误判
5. **并发与异步**：asyncio 里调用阻塞 IO（requests/time.sleep）；
   忘记 await（协程未执行且无报错）；线程共享可变状态无锁
6. **资源**：open 未用 with；子进程 PIPE 未读导致死锁
7. **常见库坑**：pandas 链式赋值（SettingWithCopy）；json.loads 后直接下标不判 KeyError；
   datetime 无时区混用；f-string 里调用有副作用的函数

判定：正常输入可触发 → critical/serious；纯风格（命名、行宽）不报。
