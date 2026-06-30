---
title: "交易所组播行情接入：为什么是 UDP Multicast"
description: "交易所行情不是普通 API 请求响应，而是高频、低延迟、一对多的广播型数据流。UDP Multicast 把发送端扩展性问题交给网络和接入方，但也要求接入系统补齐 sequence、gap detection、recovery、状态校验和监控能力。"
pubDate: 2025-04-29
tags: ["Market Data", "UDP Multicast", "交易系统", "系统设计"]
cover: "/images/posts/udp-multicast-market-data/responsibility-shift.svg"
draft: false
---

交易所行情接入系统里，UDP Multicast 是一个绕不开的基础设施。

很多人第一次解释这个选择时，会说：“因为 UDP 比 TCP 快。”这个说法不能算错，但太浅了。交易所行情选择 UDP Multicast，并不是单纯因为 UDP 少了握手、ACK 和重传，而是因为行情数据本身是一种**高频、低延迟、一对多的广播型数据流**。

真正的问题不是“UDP 快不快”，而是：

> 如何把同一份市场数据，以尽可能低的延迟，同时分发给大量接收方，并且不让某个慢接收方影响整个市场数据广播？

UDP Multicast 正是在这个问题下的一种工程取舍。

![TCP Fanout 与 UDP Multicast 的分发模型对比](/images/posts/udp-multicast-market-data/multicast-vs-tcp.svg)

## 行情分发首先是广播问题

交易所行情和普通后端 API 不一样。

普通 API 大多是请求响应模型。客户端发起请求，服务端返回结果。每个请求都有明确的调用方、返回值、超时和错误处理。

但行情分发不是这样。交易所会持续产生逐笔成交、委托簿、快照、状态变更等数据。这些数据不是给某一个客户端看的，而是同一时间要被很多接收方消费。

如果使用 TCP 点对点推送，交易所需要为每个接收方维护连接状态、发送缓冲区、重传队列和拥塞控制。接收方越多，交易所应用层的发送压力越大。某些客户端慢、网络抖动或频繁重传，也会把复杂度带回发送端。

Multicast 的模型不同：发送方只向一个组播地址发送一份数据，网络设备负责复制，接收方自己订阅和消费。

这对交易所行情这种数据形态非常合适。交易所关心的是让市场数据尽快出现在网络上，而不是逐个确认每个接收方是否已经消费成功。

## UDP Multicast 解决的是发送端扩展性

UDP Multicast 的第一个价值是**一对多**。

当同一份数据要发给很多接收方时，Multicast 可以避免发送端做 N 次应用层复制。接收方数量增加，并不会线性增加交易所应用进程的发送压力。

第二个价值是**低延迟**。

UDP 没有连接建立过程，没有传输层 ACK，也不会因为某个接收方丢包而等待重传。发送端只负责把数据发出去。这种模型非常适合实时性要求极高的行情流。

第三个价值是**慢消费者隔离**。

在行情广播里，一个接收方处理慢，不应该影响其他接收方。如果某个接入方机器 GC 卡顿、应用线程阻塞、socket buffer 溢出，那应该是这个接入方自己的问题，而不是让交易所放慢整个市场数据广播。

所以，UDP Multicast 的核心不是“UDP 简单”，而是它把发送端从大量接收方状态里解放出来。

交易所侧保持一个非常清晰的职责：

> 我负责尽快广播实时市场数据。你是否完整、及时、正确地接收，是接入方系统自己的工程能力。

## 为什么不是 TCP

这不是说 TCP 不好。

TCP 的可靠、有序、重传、流控，在很多业务场景里都是优点。比如订单请求、交易确认、账户查询，这些场景需要明确的请求响应，需要知道对方是否收到，需要强可靠语义。

但行情广播的核心矛盾不同。

行情数据的特点是频率高、体量大、时效强、接收方多。TCP 的可靠性会带来额外状态管理。每个客户端都有自己的连接状态，每个连接都有自己的发送缓冲区和重传行为。对于一对多行情广播来说，这会让发送端承担太多和单个接收方相关的复杂度。

更重要的是，TCP 保证的是**字节流可靠**，不等于业务状态一定可靠。

假设你在本地维护一个订单簿。即使底层 TCP 字节流没有丢，你仍然需要知道业务消息的 sequence 是否连续，增量是否按正确顺序应用，快照和增量是否对齐。也就是说，行情系统真正关心的不是“网络层是否可靠”，而是：

> 我本地构建出来的市场状态是否可信。

UDP Multicast 把实时性放在传输层优先，把可靠性留给接入方在业务层补偿。

这是它的本质取舍。

## 不可靠是设计的一部分

UDP Multicast 的代价非常明确。

它不保证送达，不保证顺序，也不保证唯一。接收方可能遇到丢包、乱序、重复包、socket buffer 溢出、网卡绑定错误、组播路由异常、应用线程处理不及时、GC 或锁竞争导致消费停顿。

发送方通常不会因为某个接收方丢了包而停下来。对于交易所来说，实时市场数据流必须继续向前。

所以一个成熟的行情接入系统，不能把“收到 UDP 包”当成成功。接入层收到包以后，通常不会只传递原始 `byte[]`，而是要封装成一个带上下文的数据对象。

这个对象至少应该包含：

```text
body
channelId
sequenceNumber
originSendTime
receiveTime
feedName
accessAddress
```

这些字段看起来只是元信息，但它们决定了后面整条链路能不能工作。

`channelId` 用于分区处理，`sequenceNumber` 用于连续性检测，`feedName` 用于区分不同协议或线路，`originSendTime` 和 `receiveTime` 用于延迟统计，`accessAddress` 可以用于链路标识、重连和补偿判断。

这也是行情接入和普通 UDP demo 最大的区别。普通 demo 只关心能不能收到包，生产系统关心的是收到的包能不能证明自己连续、及时、可信。

![行情接入层把原始 UDP 包封装成带上下文的 AccessData](/images/posts/udp-multicast-market-data/access-data-envelope.svg)

## 接入方必须补上 Sequence 能力

因为 UDP 本身不会告诉你丢了什么，所以行情协议通常会在业务消息里携带 sequence number。

接入方需要按 channel 或 feed 维护 `expectedSeq`：

```text
seq == expectedSeq:
    正常处理，expectedSeq++

seq > expectedSeq:
    出现 gap，说明中间有消息缺失

seq < expectedSeq:
    可能是重复包或迟到包
```

这里的关键不是写一个 `if else`，而是要把 sequence 作为系统级概念一路传下去。

接收层要保留 sequence。解析层要知道当前消息属于哪个 sequence。转发层要能把 sequence 带给下游。监控层要能看到每个 channel 的 last sequence。恢复逻辑要知道缺失区间。

如果 sequence 只在 receiver 线程里看一眼，后面所有状态都无法验证。

一个成熟接入系统通常会把 `sequence`、`channel`、`timestamp` 和消息体一起封装，作为后续解析、分区、监控和恢复的基础数据结构。

![Sequence gap detection 与 channel 状态流转](/images/posts/udp-multicast-market-data/sequence-gap-state.svg)

## Gap 不是日志，而是状态机

发现 sequence gap 以后，最差的处理方式是只打一行日志。

比如：

```text
expectedSeq = 100
receivedSeq = 105
missingRange = [100, 104]
```

这表示当前 channel 中间缺了 5 条消息。对于普通事件流，这可能只是少了几条通知；但对于订单簿增量行情，这 5 条消息里可能包含新增委托、撤单、成交、价格档变化。

只要其中一条影响了本地状态，后续消息即使都能收到，也可能是在错误的状态基准上继续计算。

所以 gap detection 不能只是网络层日志，它应该是一个 channel 级状态机。

一个简化的状态流转可以是：

```text
HEALTHY
  -> GAP_DETECTED
  -> RECOVERING
  -> CATCHING_UP
  -> HEALTHY
```

如果恢复失败，则进入：

```text
RECOVERING
  -> STALE
```

至少需要维护这些状态：

```text
channelId
expectedSeq
lastReceivedSeq
lastAppliedSeq
openGapRanges
bufferedFutureMessages
recoveryStatus
```

其中 `lastReceivedSeq` 和 `lastAppliedSeq` 必须区分开。

`lastReceivedSeq` 表示接入层最后收到的 sequence。`lastAppliedSeq` 表示最后成功应用到本地状态的 sequence。

收到 105 不代表系统可以应用 105。如果当前期望的是 100，那么 100-104 都没有到，105 只能说明“未来消息已经到了”，不能说明“本地状态可以继续推进”。

简化后的处理逻辑是：

```text
if seq == expectedSeq:
    apply(message)
    expectedSeq++

elif seq > expectedSeq:
    markGap(expectedSeq, seq - 1)
    markChannelBroken(channelId)
    bufferFutureMessage(seq, message)
    triggerRecovery(channelId, expectedSeq, seq - 1)

else:
    handleDuplicateOrLateMessage(seq, message)
```

这里最关键的是：**buffer 不等于 apply**。

对于订单簿增量这类强顺序数据，gap 之后到达的消息通常不能直接应用。因为增量描述的是“在前一个状态基础上的变化”。如果前一个状态已经不可信，后面的变化再正确，也可能被应用到错误的本地订单簿上。

所以 gap 出现时，系统应该同时标记两件事：

```text
channel continuity = BROKEN
local state trust = UNTRUSTED
```

前者表示传输连续性断了。后者表示由这个 channel 驱动的本地状态已经不能直接对外声称可信。

最危险的不是丢包，而是状态已经错了，但系统还以为自己是对的。

## Recovery 是接入方的可靠性工程

UDP Multicast 把复杂度转移给接入方，不代表可靠性不重要。相反，可靠性只是从传输层下沉到了接入系统自己的工程设计里。

当 gap 被检测出来后，系统要做的不是“等待下一条消息”，而是进入 recovery 流程。不同交易所协议细节不同，有的提供重传通道，有的提供 refresh 通道，有的依赖 snapshot 重建，但目标是一致的：

```text
找到缺失数据
修复本地状态
证明 sequence 重新连续
恢复 channel 健康状态
```

如果缺口较小，协议又支持按 sequence 补包，可以走 retransmission：

```text
missingRange = [100, 104]

replay 100
replay 101
replay 102
replay 103
replay 104
apply buffered 105
expectedSeq = 106
```

只有当缺失区间被完整补齐，并且 buffered 消息可以连续回放时，channel 才能重新回到 `HEALTHY`。

如果缺口过大，或者缺失消息已经无法完整补回，就不能继续依赖增量修复。这时要走 snapshot 或 refresh：

```text
1. 标记本地状态 UNTRUSTED
2. 暂停应用相关增量，或只缓存不应用
3. 拉取 snapshot
4. 用 snapshot 重建本地状态
5. 确认 snapshot 对应的 sequence 边界
6. 回放 snapshot 之后的连续增量
7. 状态闭环后恢复 HEALTHY
```

这里最容易出错的是 sequence 边界。

快照不是简单覆盖内存。系统必须知道这份 snapshot 对应到哪个 sequence，否则可能出现两种问题：snapshot 太旧，后续增量不完整；snapshot 太新，又重复应用了部分增量。

所以 recovery 的闭环条件不是“拉到了快照”，而是：

```text
snapshotSeq 已知
snapshotSeq 之后的增量连续
lastAppliedSeq 追上 lastReceivedSeq
本地状态重新可信
```

同时 recovery 必须有失败出口。比如：

```text
gap 持续超过阈值: 报警
recovery 重试超过次数: 升级告警
缺口无法闭合: channel 标记 STALE
状态重建失败: 阻断下游或输出不可信标记
```

否则系统会长期卡在“正在恢复”的灰色状态里，进程还活着，线程还在跑，但数据已经不能信。

## 实时链路和补偿链路不能混用一套指标

还有一个很容易被忽略的问题：实时数据和补偿数据不能混在一起统计延迟。

实时组播数据的延迟通常是：

```text
now - exchangeSendTime
```

它衡量的是接收、解析、转发这条实时链路是否足够快。

但 recovery、refresh、rebroadcast 数据本来就可能是历史数据。如果把这些数据也塞进实时 latency stats，监控会出现大量“延迟尖刺”。这并不一定代表实时链路变慢，而可能只是系统正在补历史缺口。

更合理的方式是按数据语义拆指标：

```text
real_time_latency_ms
recovery_latency_ms
gap_open_duration_ms
refresh_rebuild_duration_ms
catch_up_lag_ms
```

每个 channel 也应该暴露足够细的状态：

```text
expected_seq
last_received_seq
last_applied_seq
open_gap_count
open_gap_min_seq
open_gap_max_seq
recovery_attempt_count
channel_continuity_status
local_state_trust_status
```

这样排障时才能回答几个关键问题：

```text
现在有没有丢包？
缺口发生在哪个 channel？
缺口范围是多少？
补偿是否已经开始？
补偿是否闭合？
本地状态现在还能不能信？
下游收到的是实时数据还是补偿数据？
```

这才是 gap detection 的工程价值。

它不是为了证明 UDP 会丢包。所有人都知道 UDP 可能丢包。

它真正要解决的是：当传输不可靠时，接入系统如何判断状态是否可信，并在状态不可信时，把系统重新带回可信状态。

## 接收线程必须足够薄

UDP Multicast 接入里，一个非常朴素但重要的原则是：**接收线程要薄**。

接收线程不应该做复杂业务计算，不应该写数据库，不应该同步打大量日志，不应该远程调用，也不应该做可能长时间持锁的操作。

原因很简单：UDP socket buffer 是有限的。

当应用层消费速度跟不上内核收包速度，buffer 满了就会丢包。UDP 没有传输层重试，丢了就是丢了。发送方不会等你，交易所行情流也不会停下来。

所以接入链路通常会被拆成几层：

```text
收包
封装元信息
投递到下一层
```

Receiver Thread 只做三件事：

```text
收包
封装元信息
投递到下一层
```

解析、状态构建、转发、落盘，都应该放到后面的 worker 中处理。

在更高吞吐的系统里，parse worker 还会按 channel 分区。这样可以在保证同一个 channel 顺序性的同时，把不同 channel 分散到多个处理单元。对于流量特别大的热点 channel，甚至不能简单 hash，而要根据真实流量分布做显式映射，避免某个处理单元被打满。

这就是从“会收 UDP 包”到“能做生产行情接入”的差别。

![UDP Multicast 接收线程保持轻量，把解析和状态构建交给 worker](/images/posts/udp-multicast-market-data/receiver-pipeline.svg)

## Multicast 还有部署复杂度

UDP Multicast 的复杂度不只在代码里，也在部署环境里。

常见问题包括：

```text
机器有多块网卡，绑定错 interface
配置的 multicast interface IP 和本机 IP 对不上
IGMP 配置异常
交换机没有正确转发组播
路由配置不完整
应用启动成功，但实际没有收到目标 feed
```

生产系统不能只相信配置文件。更稳妥的方式是在启动时做校验：

```text
配置中的 multicast interface IP
    ∩
本机实际网卡 IP
    =
可绑定网卡
```

如果交集为空，说明这台机器不应该接这个 feed，或者配置错了。

如果交集超过一个，说明配置有歧义，应该拒绝启动或报警。

如果需要特殊切换，可以支持通过环境变量或 JVM 参数手工指定 bind IP。

这个细节看起来和 UDP 协议无关，但它决定了系统是不是能在线上稳定运行。

很多行情接入事故，不是代码不会解析协议，而是机器启动在错误网卡上，系统看起来活着，但数据根本没进来。

## 真正要监控的是数据可信度

行情接入系统不能只监控进程是否存活。

进程 alive 不代表行情健康。线程还在，不代表数据连续。端口开着，不代表本地状态可信。

更有价值的指标应该包括：

```text
lastSequence
lastMessageTime
gapCount
duplicateCount
outOfOrderCount
recoveryCount
receiverLag
parseLag
transferLag
sourceNumber
processedNumber
sourceNumber - processedNumber
realTimeLatency
recoveryLatency
localStateTrustStatus
```

其中 `sourceNumber - processedNumber` 很有用。它可以反映某一层是否出现积压。接收层进来的数据越来越多，但解析层处理不上，差值会扩大。解析层处理完了，但转发层发不出去，转发层也会积压。

这类指标比单纯的 CPU、内存、进程状态更接近真实问题。

因为行情系统最核心的问题不是“服务是否活着”，而是：

```text
数据是否连续
数据是否新鲜
状态是否可信
下游是否跟得上
```

## 小结

交易所行情接入选择 UDP Multicast，本质上是一种工程责任划分。

![UDP Multicast 把传输可靠性之外的连续性、恢复和状态校验责任转移给接入方](/images/posts/udp-multicast-market-data/responsibility-shift.svg)

它选择了：

```text
一对多广播
低延迟
发送端负载稳定
慢消费者隔离
```

同时也放弃了：

```text
传输层可靠
传输层有序
传输层重传
发送端感知每个接收方状态
```

因此，UDP Multicast 并不是让系统更简单。它只是让交易所发送端更简单、更稳定、更低延迟，而把可靠性、连续性、状态可信度和监控复杂度转移给了接入方。

成熟的行情接入系统，必须在不可靠传输之上补齐这些能力：

```text
sequence tracking
gap detection
recovery / refresh
snapshot rebuild
thin receiver thread
partitioned workers
state validation
real-time / recovery metric isolation
```

所以，交易所组播行情接入的核心不是“如何收到 UDP 包”。

真正的核心是：

> 如何证明自己收到的数据是连续的、及时的、可信的，并且在它不可信时能够被系统发现和修复。
