---
title: "交易所组播行情接入：低延迟与高吞吐实践"
description: "交易所组播行情接入的低延迟和高吞吐，不是靠单个神奇参数解决的，而是由性能目标、机器资源模型、JVM 参数、GC、receiver 线程、队列容量、partition 策略、对象分配、Direct Memory 和压测排障共同决定。"
pubDate: 2025-04-30
tags: ["Market Data", "UDP Multicast", "低延迟", "高吞吐", "JVM"]
cover: "/images/posts/trading-multicast-low-latency-throughput/runtime-performance-model.svg"
draft: false
---

上一篇讲的是顶层架构：多交易所如何适配，数据如何从 feed 进入 `AccessData`，再经过解析、分区、状态构建和下游发布。

这篇不再重复架构流程，而是聚焦另一个问题：

> 这套架构在行情高峰时，如何做到低延迟、高吞吐，并且尾部抖动可控？

交易所行情不是匀速数据流。开盘、收盘、集合竞价、指数调整、热门标的异动时，消息会在短时间内成簇涌入。系统如果只是“平均能跑通”，很快会遇到：

```text
receiver 被阻塞
socket buffer 溢出
parse worker 积压
热点 channel 打满单线程
下游慢导致 transfer 堵塞
GC pause 放大延迟尾部
Direct Memory 不受控
机器 CPU / 内存 / 网卡规划不合理
```

低延迟和高吞吐不是一个参数能解决的，而是运行时、机器资源、线程模型和容量设计共同决定的。

![行情高峰下的尾部延迟来源](/images/posts/trading-multicast-low-latency-throughput/runtime-performance-model.svg)

## 一、先定义性能目标

行情接入系统不能只看平均延迟。

平均延迟很低，但 `p99` / `p999` 尾部抖动很大，仍然可能导致 UDP buffer 溢出和 sequence gap。更合理的目标应该包括：

```text
packet_rate 峰值可承载
message_rate 峰值可承载
real_time_latency_p99 可控
real_time_latency_p999 可控
receiver_lag 不持续增长
parse_lag 不持续增长
transfer_lag 不持续增长
gap_count 不因本地处理能力不足而上升
GC pause 不与行情延迟尖刺强相关
```

这里的核心是：**低延迟不是平均快，而是高峰时尾部稳定。**

对行情系统来说，真正危险的通常不是“今天平均延迟 1ms 还是 2ms”，而是高峰期突然出现 100ms、500ms 甚至秒级尾部尖刺。只要尖刺发生在 receiver 或 parse 链路，就可能导致 socket buffer 堆满、队列积压、sequence gap 扩大。

所以性能目标要以高峰和尾部为中心，而不是只报一个平均值。

## 二、机器资源模型：先分资源，再调参数

很多性能问题不是代码造成的，而是机器资源分配不合理。

一台行情接入机器至少要为这些部分留资源：

```text
Java heap
Direct memory
线程栈
native memory
OS page cache
kernel network buffer
GC threads
Netty / NIO worker
softirq / kernel network processing
monitor / scheduler
```

不能把机器内存几乎全部给 heap，也不能把 CPU 全部分给业务 worker。

以一台 64G 机器为例，一个粗略资源模型可以是：

```text
Heap:
  28G - 32G
  用于状态缓存、业务对象、transfer data

Direct Memory:
  4G - 8G
  用于 Netty ByteBuf、NIO direct buffer、网络 IO

OS / Native Reserve:
  8G - 12G
  用于线程栈、page cache、native library、kernel buffer

剩余空间:
  给系统抖动、监控、临时峰值留余量
```

CPU 也要按角色规划：

```text
receiver thread:
  少量高优先级线程，必要时做 CPU affinity

parse workers:
  按 channel partition 数配置

transfer workers:
  按下游连接数和发送吞吐配置

Netty selector / worker:
  负责连接和网络写出

GC threads:
  给低延迟 GC 留并发回收资源

OS / softirq:
  预留 CPU，不要让业务线程打满整机
```

如果业务线程把 CPU 吃满，低延迟 GC 的并发线程、Netty worker、内核网络处理都可能被挤压，最终表现成延迟尖刺。

![机器资源需要按运行时角色预留](/images/posts/trading-multicast-low-latency-throughput/resource-budget.svg)

## 三、JVM 参数选择：目标是减少运行时动态变化

行情接入系统的 JVM 参数设计，第一目标不是“榨干吞吐”，而是减少运行期不可控抖动。

### 固定堆大小

```text
-Xms31g -Xmx31g
```

`Xms = Xmx` 可以避免 JVM 运行过程中动态扩缩 heap。对普通服务来说，heap 扩缩可能只是一次抖动；对 UDP 行情接入来说，一次抖动就可能导致 receiver 或 worker 积压。

固定 heap 的代价是启动时占用内存更明确，但换来运行时更稳定。

### 控制线程栈

```text
-Xss256k
```

行情接入系统会有 receiver、parse worker、transfer worker、Netty worker、scheduler、monitor 等多类线程。线程栈太大，会浪费虚拟内存。

线程栈不是越小越好，过小可能导致深调用栈场景出问题；但它必须被纳入容量模型，而不是让默认值悄悄吃掉空间。

### 限制 Direct Memory

```text
-XX:MaxDirectMemorySize=8g
```

网络系统大量使用 direct buffer。Direct Memory 如果不显式限制，容量规划和故障排查都会变困难。

设置上限的目的不是越小越好，而是让 off-heap 使用可控、可监控、可预期。

### 预触碰内存

```text
-XX:+AlwaysPreTouch
```

这个参数会在 JVM 启动时预触碰内存页，减少运行时 page fault。启动会慢一点，但对行情系统来说，启动慢一点通常比交易时段运行期抖动更可接受。

### 禁止显式 GC

```text
-XX:+DisableExplicitGC
```

防止业务代码或第三方库调用 `System.gc()` 制造不可控停顿。

### 打开 GC 和 safepoint 日志

```text
-Xlog:gc*,safepoint
```

没有 GC / safepoint 日志，延迟尖刺只能靠猜。

行情系统要能回答：

```text
某次 latency spike 是否发生在 GC pause 附近？
是否有长 safepoint？
是否有 class loading / biased lock / deoptimization 造成停顿？
```

参数本身不是重点。重点是每个参数都服务于同一个目标：

```text
固定 heap          -> 减少运行期内存变化
控制 Xss           -> 降低线程资源成本
Direct Memory      -> 约束 off-heap 风险
AlwaysPreTouch     -> 减少运行时缺页抖动
DisableExplicitGC  -> 避免人为 STW
GC / safepoint log -> 让尾部延迟可解释
```

## 四、GC 选择：低停顿优先，不只看吞吐

行情接入系统选 GC，要围绕一个问题：

> 在行情高峰期，GC 会不会让 receiver 或 worker 停顿到足以造成积压甚至丢包？

常见选择可以这样理解：

```text
G1:
  成熟，吞吐和停顿平衡较好。
  适合大多数服务，但大堆和极端低延迟场景下仍需关注尾部停顿。

ZGC:
  低停顿，适合大堆。
  对 JDK 版本和线上验证要求更高。

Shenandoah:
  低停顿，适合对 STW 敏感的链路。
  需要观察 pacing、allocation rate、并发周期。
```

如果使用 Shenandoah，可以关注类似参数：

```text
-XX:+UseShenandoahGC
-XX:ShenandoahPacingMaxDelay=20
-XX:ShenandoahAllocationThreshold=70
```

这些参数背后的思路是：

```text
尽量让 GC 并发完成
避免堆压力堆到很高才处理
控制 pacing 对业务线程的影响
```

但 GC 不能脱离压测结果谈。

至少要观察：

```text
gc_pause_p99
gc_pause_max
safepoint_time
allocation_rate
heap_used_after_gc
concurrent_gc_cycle_time
receiver_lag
parse_lag
real_time_latency_p99
real_time_latency_p999
```

真正重要的是关联分析：

```text
GC pause 出现
receiver_lag 同时上升
parse queue 同时积压
real_time_latency_p99 同时抬高
```

如果这些指标同时出现，GC 就不是 JVM 内部问题，而是行情链路延迟的一部分。

![GC 与行情链路指标需要做关联分析](/images/posts/trading-multicast-low-latency-throughput/gc-latency-correlation.svg)

## 五、Receiver 线程：保护收包路径

Receiver 线程要尽可能薄，这一点在架构篇已经讲过。性能篇需要进一步关注运行时保护：

```text
receiver 线程数量
CPU affinity
socket receive buffer
NIC RX queue
softirq CPU
packet drop
```

在高吞吐场景下，如果网卡队列、softirq 和 receiver 线程都挤在同一个 CPU 上，就可能出现单核打满，其他核很空。

需要观察：

```text
单核 CPU 使用率
softirq 使用率
网卡 RX drop
socket buffer drop
packet_rate
receiver loop cost
```

如果 receiver 没有及时取包，后面的 parse worker 再快也没意义。

Receiver 的目标不是做最多事情，而是保证收包路径持续前进。

## 六、队列容量模型：队列是削峰，不是黑洞

行情接入链路中通常有多级队列：

```text
receiver -> parse queue
parse    -> transfer queue
recovery -> replay queue
```

队列容量要来自容量模型，而不是拍脑袋。

一个简单估算：

```text
peakRate = 200_000 msg/s
workerRate = 180_000 msg/s
allowedBurstDuration = 2s

queueCapacity >= (peakRate - workerRate) * allowedBurstDuration
```

但真实系统还要考虑：

```text
单条消息大小
消息处理耗时分布
GC 抖动
下游发送抖动
恢复流量是否共用队列
```

队列选型也要看语义：

```text
ArrayBlockingQueue:
  简单稳定，有界，背压语义清楚

Disruptor:
  低延迟，适合固定 ring buffer 和明确生产消费模型

JCTools MPSC / SPSC:
  适合高性能无锁队列，但要清楚生产者消费者语义
```

无论选哪种，都必须有指标：

```text
queue_size
queue_remaining_capacity
offer_fail_count
sourceNumber
processedNumber
lag = sourceNumber - processedNumber
```

队列太大，会把“处理不过来”伪装成“系统还没挂”。行情系统里延迟无限增长，本身就是故障。

## 七、Partition 策略：热点 channel 不能靠运气

按 channel 分区是行情接入的常见设计，但不能简单写成：

```text
worker = workers[channelId % workerCount]
```

因为 channel 流量通常不均匀。热点 channel 如果落到同一个 worker，就会造成单分区积压。

更稳妥的设计：

```text
hot channel 显式映射
普通 channel hash fallback
按 partition 观察 lag
按真实流量调整映射
parse partition 与 transfer partition 协同设计
```

指标要按 partition 暴露：

```text
partition_source_count
partition_processed_count
partition_lag
partition_max_process_cost
channel_distribution
```

如果只有全局 lag，看不到热点在哪里。真正排障时，更有价值的是：

```text
哪个 partition 最慢？
它承载了哪些 channel？
这些 channel 是否是高峰热点？
下游 transfer 是否也在同一个分区积压？
```

![热点 channel 需要显式分区治理](/images/posts/trading-multicast-low-latency-throughput/partition-hotspot.svg)

## 八、热路径对象分配：减少无意义 allocation

行情消息量大时，每条消息多几个临时对象，都会放大成 GC 压力。

常见风险包括：

```text
每条消息 new 大对象
频繁 String 拼接
日志中隐式 toString 大对象
临时 List / Map 反复创建
ByteBuf 生命周期不清
反序列化产生大量中间对象
```

原则不是“零对象”，而是区分：

```text
承载系统语义的对象:
  AccessData / MessageContext / TransferData

无意义临时对象:
  临时字符串、临时集合、日志大对象、重复包装
```

前者可以存在，后者要减少。

热路径里尤其要小心日志。即使日志级别没有打开，参数拼接、`toString()`、临时对象构造也可能已经发生。

## 九、Direct Memory 与 ByteBuf 生命周期

网络系统绕不开 Direct Memory。

Direct Memory 的好处是减少堆内拷贝，提高 IO 效率。但风险是：

```text
不直接体现在 Java heap
泄漏不一定表现为 heap OOM
引用计数错误会很隐蔽
高峰期 direct buffer 分配可能抖动
```

如果使用 ByteBuf 这类引用计数对象，要明确：

```text
谁 retain，谁 release
跨线程传递时所有权如何转移
异常路径是否 release
是否存在缓存 ByteBuf 的行为
```

监控也要包括：

```text
direct_memory_used
direct_memory_capacity
bytebuf_pool_used
allocation_count
release_count
leak_detection
```

Direct Memory 不是 JVM 之外就可以忽略。它是网络链路容量的一部分。

## 十、State 更新：锁粒度决定尾部延迟

状态更新必须正确，但锁粒度过大，会制造尾部延迟。

热门标的在高峰期可能集中更新同一个 order book 或 reference state。如果每次更新都持有大锁，并且在锁里做复杂计算，就会排队。

更稳妥的做法：

```text
锁内:
  apply delta
  update sequence
  update necessary state

锁外:
  日志
  指标
  下游消息构造
  可延迟的派生计算
```

如果要进一步优化，可以考虑：

```text
per-symbol lock
striped lock
copy-on-write snapshot
immutable view
单 channel 单线程应用
```

但前提是不能破坏状态一致性。行情系统里，正确性永远优先于微观性能。

## 十一、Transfer 性能：慢消费者隔离

下游慢不能拖垮上游。

发布层要观察：

```text
transfer_source_count
transfer_processed_count
transfer_lag
send_fail_count
client_pending_bytes
client_last_write_time
slow_consumer_count
```

治理策略包括：

```text
按 client 隔离发送队列
断开慢消费者
非关键订阅降级
只保留最新快照类数据
禁止同步发送阻塞 parse worker
```

如果业务允许 active-active 发布，下游还要支持幂等去重。否则重复数据会变成状态污染。

## 十二、压测：不要只压平均 QPS

行情接入压测要模拟真实风险：

```text
恒定高 packet rate
突发 burst
热点 channel
乱序 / 重复包
补偿流量叠加实时流量
慢消费者
GC 压力
大消息和小消息混合
```

压测指标至少包括：

```text
packet_rate
message_rate
real_time_latency_p50 / p99 / p999
receiver_lag
parse_lag
transfer_lag
partition_max_lag
gap_count
duplicate_count
gc_pause
direct_memory_used
slow_consumer_count
```

压测成功不是“进程没挂”，而是高峰下：

```text
lag 不持续增长
延迟尾部可控
无本地处理能力导致的 gap
GC 不制造明显尖刺
Direct Memory 不泄漏
慢消费者不影响主链路
```

## 十三、性能排障路径

性能问题要按层定位。

如果：

```text
receiver lag 上升
socket drop 上升
softirq CPU 高
```

优先看网卡、内核、receiver 线程。

如果：

```text
parse lag 上升
某个 partition lag 特别高
其他 partition 正常
```

优先看热点 channel 分布和该分区处理逻辑。

如果：

```text
parse 正常
transfer lag 上升
client pending bytes 上升
```

优先看下游慢消费者。

如果：

```text
所有层同时抖动
GC pause / safepoint 同时出现
```

优先看 JVM 和 allocation rate。

性能优化最怕乱调参数。先定位瓶颈层，再决定是改分区、调队列、优化锁、处理下游，还是调 JVM。

![低延迟行情系统的排障路径](/images/posts/trading-multicast-low-latency-throughput/troubleshooting-path.svg)

## 小结

组播行情接入的低延迟与高吞吐，不是靠某个神奇参数。

它来自一整套运行时设计：

```text
机器资源有模型
JVM 参数减少动态抖动
GC 选择服务于尾部延迟
receiver 线程被保护
队列容量可解释
partition 能拆热点
状态更新锁粒度可控
Direct Memory 生命周期清楚
慢消费者被隔离
压测覆盖真实高峰和故障场景
```

一个成熟的行情接入系统，要能在高峰时证明：

```text
我没有因为本地处理能力不足而丢包
我的延迟尾部在预算内
我的 GC 和 Direct Memory 可观测
我的热点 channel 没有打穿单分区
我的下游慢不会拖垮上游
```

这才是低延迟与高吞吐实践的真正价值。
