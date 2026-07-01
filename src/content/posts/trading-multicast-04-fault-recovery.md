---
title: "交易所组播行情接入：故障治理与恢复设计"
description: "组播行情接入的稳定性不是保证 UDP 永远不丢包，而是在丢包、乱序、线路异常、状态不可信和单点故障出现时，能够发现、隔离、恢复，并证明当前行情状态是否可信。"
pubDate: 2025-05-01
tags: ["Market Data", "UDP Multicast", "故障治理", "Recovery", "高可用"]
cover: "/images/posts/trading-multicast-04-fault-recovery/fault-model-layers.svg"
draft: false
---

# 交易所组播行情接入：故障治理与恢复设计

前两篇分别讲了架构和性能。

架构篇回答：系统怎么分层，如何支持多交易所接入。

性能篇回答：高峰行情下，JVM、GC、机器、线程、队列、分区怎么设计。

这篇讲第三个问题：

```text
当系统真的坏了，如何发现、隔离、恢复，
并证明当前行情状态是否可信？
```

组播行情接入系统的稳定性，不是保证永远不丢包。UDP Multicast 天然不可靠，网络环境也不可能永远稳定。

真正的稳定性是：

> 丢包时不静默，恢复时可闭环，状态可信度可证明，单点故障不升级成 PO。

## 一、行情故障最危险的是静默错误

普通服务故障，很多时候表现为进程挂了、接口超时、返回错误。

行情系统更危险的故障是：**系统看起来正常，但数据已经不可信。**

```text
进程活着，不代表行情健康
端口开着，不代表 channel 连续
还能收到包，不代表本地订单簿可信
下游还在消费，不代表消费的是实时数据
```

对行情系统来说，最危险的不是“没数据”，而是：

```text
状态已经错了，但系统还在正常输出
```

所以故障治理的核心不只是做进程监控，而是围绕数据连续性、状态可信度和恢复闭环做设计。

## 二、故障类型要按层建模

不要把所有问题都叫“行情异常”。先按层定义系统会怎么坏。

![行情接入故障分层模型](/images/posts/trading-multicast-04-fault-recovery/fault-model-layers.svg)

```text
Network Layer:
  组播收不到
  网卡绑定错误
  IGMP / 路由异常
  RX drop / socket buffer drop

Feed Layer:
  channel 断流
  sequence gap
  duplicate packet
  out-of-order packet
  late packet

Processing Layer:
  parse lag
  partition hotspot
  state apply 失败
  state trust broken

Recovery Layer:
  双路仲裁无法补齐
  retransmission 失败
  snapshot sequence 无法对齐
  replay 追不上实时
  recovery stuck

Publish Layer:
  downstream slow
  send queue 积压
  client pending bytes 过高
  慢消费者拖累主链路

Control Layer:
  feed config 错
  动态配置漂移
  EOD 清理未触发
  管理操作误触发

Deployment Layer:
  单 receiver 进程挂掉
  单机器宕机
  单网卡异常
  单线路断流
  主备脑裂
```

有了故障模型，后面的状态机、告警和恢复才有落点。

## 三、双路 Channel 仲裁：不是主备切换

港股、NASDAQ 这类行情接入通常会提供 A/B 双路 feed。

这不是简单的主备切换：

```text
主线路正常 -> 用主线路
主线路挂了 -> 切备线路
```

更准确的模型是：

```text
Line A Receiver \
                 -> Channel Arbitrator -> Parse / State / Publish
Line B Receiver /
```

![A/B 双路 Channel 仲裁](/images/posts/trading-multicast-04-fault-recovery/dual-line-arbitration.svg)

两路数据在语义上等价，通常都包含相同 `channel` 的相同 `sequence`。差异在于：

```text
到达时间不同
抖动不同
丢包情况不同
局部 channel 健康状况不同
```

所以仲裁粒度不应该是整条线路，而应该是：

```text
exchange + feed + channelId + sequenceNumber
```

一个简化逻辑：

```text
if seq == expectedSeq:
    accept(firstArrivedPacket)
    markOtherLineAsDuplicateIfArrivesLater()
    expectedSeq++

elif seq > expectedSeq:
    markGap(expectedSeq, seq - 1)
    checkOtherLineForMissingRange()

else:
    dropAsDuplicateOrLatePacket()
```

双路 channel 仲裁的意义，不只是线路容灾，而是在进入重传和快照恢复之前，先用另一条实时 feed 尽可能保持 sequence 连续。

例如：

```text
Line A:
  received 100, 101, 105
  missing 102-104

Line B:
  received 100, 101, 102, 103, 104, 105
```

这时系统不需要立刻走外部 recovery。它可以用 B 路补齐缺口，再继续推进状态。

仲裁器至少要维护：

```text
channelId
expectedSeq
lineA_lastReceivedSeq
lineB_lastReceivedSeq
lineA_lastMessageTime
lineB_lastMessageTime
lineA_gapCount
lineB_gapCount
selectedLine
duplicateDropCount
arbitrationSwitchCount
channelContinuityStatus
```

进一步，还可以维护：

```text
lineA_latency
lineB_latency
lineA_jitter
lineB_jitter
lineA_health
lineB_health
```

这样排障时才能知道：

```text
当前 channel 主要使用哪条 line?
A/B 哪条更快?
哪条 line 丢包更多?
某个 sequence 是从 A 来的还是从 B 来的?
后到数据是否被正确去重?
```

## 四、Gap 不是日志，而是状态机

发现 sequence gap 以后，最差的处理方式是只打一行日志。

```text
expectedSeq = 100
receivedSeq = 105
missingRange = [100, 104]
```

这意味着当前 channel 中间缺了 5 条消息。对于订单簿增量行情，这 5 条消息可能包含新增委托、撤单、成交、价格档变化。

只要其中一条影响本地状态，后续消息即使都能收到，也可能是在错误的状态基准上继续计算。

所以 gap detection 应该是 channel 级状态机：

![Gap 检测与恢复状态机](/images/posts/trading-multicast-04-fault-recovery/gap-recovery-state-machine.svg)

```text
HEALTHY
  -> GAP_DETECTED
  -> RECOVERING
  -> CATCHING_UP
  -> HEALTHY

RECOVERING
  -> STALE
```

每个 channel 至少维护：

```text
expectedSeq
lastReceivedSeq
lastAppliedSeq
openGapRanges
bufferedFutureMessages
channelContinuityStatus
localStateTrustStatus
```

其中 `lastReceivedSeq` 表示接入层最后收到的 sequence。

`lastAppliedSeq` 表示最后成功应用到本地状态的 sequence。

收到 `105` 不代表可以应用 `105`。如果当前期望的是 `100`，那么 `105` 只能说明未来消息已经到了，不能说明本地状态可以推进。

处理逻辑可以简化成：

```text
if seq == expectedSeq:
    apply(message)
    expectedSeq++

elif seq > expectedSeq:
    markGap(expectedSeq, seq - 1)
    markChannelBroken(channelId)
    bufferFutureMessage(seq, message)
    tryFillGapFromOtherLine()
    triggerRecoveryIfNeeded()

else:
    handleDuplicateOrLateMessage(seq, message)
```

这里最关键的是：

```text
buffer 不等于 apply
```

对于强顺序增量，gap 之后到达的消息通常不能直接应用。否则可能把正确增量应用到错误状态上。

## 五、Recovery 闭环：恢复不是请求发出去就结束

恢复流程应该分层：

```text
第一层：双路 channel 仲裁补缺口
第二层：retransmission 补缺失 sequence
第三层：refresh / snapshot 重建状态
第四层：local replay 从本地日志回放
```

Recovery 的目标不是“发起了补偿请求”，而是：

```text
缺失数据被补齐
状态被修复
sequence 重新连续
channel 回到 HEALTHY
localStateTrustStatus 回到 TRUSTED
```

一个完整闭环：

```text
1. 发现 gap
2. 记录 missingRange
3. 先检查另一条 line 是否可补齐
4. 如果不能，发起 retransmission / refresh / snapshot
5. 暂存 gap 后到达的 future messages
6. 按 sequence 回放缺失数据
7. 回放 buffered future messages
8. lastAppliedSeq 追上 lastReceivedSeq
9. localStateTrustStatus 恢复 TRUSTED
```

失败出口也要明确：

```text
recovery timeout
retry exceeded
missing range too large
snapshot sequence cannot align
replay cannot catch up
channel -> STALE
state -> UNTRUSTED
alarm escalation
```

系统不能长期停留在“恢复中但不知道是否成功”的灰色状态。

## 六、Snapshot / Refresh：最容易错在 sequence 边界

Snapshot 不是简单覆盖内存。

Snapshot 是某个时间点或某个 sequence 边界上的完整状态；增量消息是在前一个状态基础上的变化。

因此 snapshot 和增量必须对齐：

```text
snapshotSeq 已知
discard buffered messages <= snapshotSeq
apply buffered messages > snapshotSeq in order
if no gap:
    state -> TRUSTED
else:
    continue recovery
```

如果 snapshot 太旧，后续增量可能不完整。

如果 snapshot 太新，又可能重复应用了部分增量。

如果 snapshot 没有明确 sequence 边界，系统就无法证明重建后的状态可信。

Recovery 的成功标准不是“拉到了快照”，而是：

```text
snapshot sequence 对齐
后续增量连续
lastAppliedSeq 推进
本地状态重新可信
```

## 七、状态可信度要成为一等指标

行情系统不是只有“有数据”和“没数据”。

还必须区分：

```text
TRUSTED:
  sequence 连续，状态可对外输出

UNTRUSTED:
  发生 gap 或状态应用失败，输出需要标记风险

REBUILDING:
  正在 snapshot / replay 修复

STALE:
  长时间无法恢复，状态不可用
```

状态可信度应该暴露给下游。

对于强依赖订单簿的下游，`UNTRUSTED` 状态可能意味着要阻断或降级。

对于弱依赖快照的下游，可以继续输出但带状态标记。

核心原则：

> 不可信时不能假装正常。

## 八、高可用部署：单点接入服务不能导致 PO

内部状态机再完善，也不能假设单个 receiver 永远健康。

下面任何一个问题，都可能让单实例直接不可用：

```text
receiver 进程挂掉
机器宕机
网卡异常
交换机端口异常
单 feed line 断流
GC 长时间停顿
发布端口不可用
机房网络抖动
```

所以要从部署层面消除单点。

![行情接入高可用与故障域隔离](/images/posts/trading-multicast-04-fault-recovery/ha-fault-domain.svg)

### 1. 双线路不是冷备

A/B 双路 feed 应该同时接收、实时仲裁，而不是主线挂了再切备线。

```text
Feed A -> Receiver A
Feed B -> Receiver B
       -> Channel Arbitrator
```

单条 line 异常，不应该升级成全市场不可用。

### 2. 多实例部署

可以选择 active-active 或 hot standby。

Active-Active：

```text
Receiver Node 1 -> Parse -> State -> Publish
Receiver Node 2 -> Parse -> State -> Publish
```

下游必须通过：

```text
exchange + feed + channelId + sequenceNumber + messageType
```

做幂等去重。

Hot Standby：

```text
Primary Receiver -> Publish
Standby Receiver -> Receive + Parse + Build State, 不发布
```

standby 不能是冷备。它必须持续收包、解析、推进 sequence、维护状态。否则 primary 挂掉后，它还要追 sequence、拉 snapshot、重建状态，RTO 不可控。

### 3. 故障域隔离

高可用不是多起几个进程，而是拆故障域：

```text
不同机器
不同网卡
不同交换机端口
不同机架
不同可用区 / 机房
不同 feed line
独立发布端口
```

如果主备跑在同一台机器上，机器宕机时还是一起挂。

如果双路 feed 走同一块网卡，网卡异常时还是一起断。

如果多实例共用同一个发布服务，发布服务仍然是单点。

部署设计要按故障域画图，而不是按进程数量画图。

### 4. Failover 不能破坏状态可信度

切换前必须检查：

```text
standby channel status = HEALTHY
state trust status = TRUSTED
lastAppliedSeq 接近 lastReceivedSeq
无未闭合 critical gap
发布端 ready
```

不安全的切换是：

```text
primary 挂了
standby 还没完成状态重建
直接开始发布
```

这会把“不可用”变成“静默错误”。

### 5. 防止脑裂

如果两个节点都认为自己是 primary，同时向不具备去重能力的下游发布，就可能造成重复应用。

两类方案：

```text
单主发布:
  leader election / lease / fencing token
  同一 feed 同一时刻只有一个 publisher

多主发布:
  下游按 channelId + sequenceNumber 幂等去重
  数据允许重复到达
```

两种都可以，但不能混乱。

高可用的目标是：

> 任意单进程、单机器、单网卡、单线路故障，都不会让市场数据链路失去可信输出能力。

## 九、组播网络故障要从部署层治理

组播故障常见现象：

```text
应用启动成功，但没有数据
某个 feed 没数据
某些 channel 没数据
换机器后收不到组播
只在特定机房或网段异常
```

排查维度：

```text
multicast interface bind IP
local network interface IP
multicast route
IGMP join 是否成功
交换机是否转发
RX drop
socket receive buffer drop
softirq CPU
```

工程治理：

```text
启动期校验 bind IP
configured IP 与 local IP 求交集
交集为空：不启动或告警
交集多个：拒绝启动
支持手工 override bind IP
暴露 feed-level lastMessageTime
```

很多行情事故不是协议解析错了，而是系统启动在错误网卡上。

## 十、慢消费者隔离

下游慢是下游故障，不能升级成接入侧丢包事故。

典型指标：

```text
client pending bytes 上升
transfer queue lag 上升
send fail 增加
client last write time 变旧
```

治理策略：

```text
按 client 隔离发送队列
慢消费者断开
非关键订阅降级
只保留最新快照
禁止慢消费者阻塞 parse / receiver
```

如果下游没有幂等能力，还要避免 active-active 重复发布导致状态重复应用。

## 十一、控制面故障也会污染数据面

控制面问题经常被低估。

典型故障：

```text
EOD 清理未触发，状态跨日污染
动态配置把 feed 关错
恢复开关误配置
管理端口暴露导致误触发
配置更新后多实例行为不一致
```

治理方式：

```text
关键配置变更审计
配置版本暴露到监控
EOD 事件路径 + 人工兜底路径
清理操作幂等
关键控制动作打审计日志
动态配置灰度
```

行情系统里，配置不是静态文本。它是运行时控制面的一部分。

## 十二、告警要带上下文

不要只告警：

```text
有 gap
```

这对排障帮助有限。

告警应该包含：

```text
exchange
feedName
lineId
channelId
expectedSeq
receivedSeq
missingRange
gapOpenDuration
lastReceivedTime
recoveryAttempt
stateTrustStatus
affectedChannels
activeInstance
standbyCatchupLag
```

告警分级也要清楚：

```text
P1:
  全市场无数据
  A/B 双路同时断流
  healthy_receiver_count == 0
  active_publisher_count == 0
  state STALE

P2:
  单 channel gap 持续超过阈值
  recovery retry 多次
  snapshot rebuild 失败
  standby catchup lag 持续扩大
  单条 feed line 断流

P3:
  duplicate 增多
  out-of-order 增多
  单 client 慢
  recovery latency 抬高
```

告警不是为了把人叫醒，而是为了让人醒来后知道该看哪里。

## 十三、故障演练

故障治理不是写完代码就结束，要能演练。

演练场景：

```text
丢弃连续 sequence
乱序注入
重复包注入
暂停 Line A
暂停 Line B
同时暂停 A/B 某个 channel
暂停 recovery 服务
snapshot 延迟
下游客户端不读数据
网卡配置错误
EOD 事件缺失
GC pause 模拟
primary publisher 挂掉
standby 未追平时尝试切换
```

验证点：

```text
gap 是否被发现
A/B 仲裁是否补齐
state 是否转 UNTRUSTED
recovery 是否闭合
告警是否带上上下文
failover 是否尊重 trust status
下游是否收到可信度标记
receiver 是否未被下游拖垮
```

没有演练过的恢复流程，在生产上往往只是“看起来有设计”。

## 小结

组播行情接入系统的故障治理，不是避免所有故障。

它真正要做到的是：

```text
故障可发现
影响可隔离
状态可信度可表达
恢复流程可闭环
单点故障不升级成 PO
```

港股、NASDAQ 这类双路 feed 场景下，核心不是主备切换，而是 channel 级实时仲裁：

```text
同一 channel + sequence
谁先到，谁连续，谁健康
由接入系统判断
```

在此基础上，再叠加 retransmission、snapshot、local replay、高可用部署和告警演练，才能构成完整的韧性架构。

最终目标只有一句话：

> 丢包时不静默，恢复时可证明，状态不可信时不伪装，任意单点故障都不应该直接导致市场数据链路 PO。
