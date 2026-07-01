---
title: "交易所组播行情接入：全链路架构设计"
description: "UDP Multicast 只解决交易所如何广播数据，接入方还需要把不可靠的组播数据转换成可解析、可排序、可恢复、可监控、可转发的可信行情流。"
pubDate: 2025-04-30
tags: ["Market Data", "UDP Multicast", "交易系统", "架构设计"]
cover: "/images/posts/trading-multicast-02-architecture/full-link-architecture.svg"
draft: false
---

# 交易所组播行情接入：全链路架构设计

上一篇讲了为什么交易所行情分发常用 UDP Multicast：它解决的是一对多广播、低延迟、发送端负载稳定的问题。

但 UDP Multicast 只解决了“交易所如何把数据广播出来”。对接入方来说，真正的工程问题是：

```text
一包不可靠的组播数据进入系统后，
如何变成可解析、可排序、可恢复、可监控、可转发的可信行情流？
```

所以，组播行情接入系统不能被理解成一个 UDP receiver。它更像是一个多交易所行情接入平台：上游适配不同交易所和不同协议，下游对接解析、状态构建、分发、监控和恢复。

这篇从顶层架构开始拆解。

## 一、先从平台边界看问题

交易所组播接入平台至少要同时解决四类问题：

```text
数据面：
  收包、解析、分区、状态构建、下游分发

控制面：
  配置加载、生命周期、交易日切换、动态开关

恢复面：
  sequence gap、双路仲裁、重传、refresh、snapshot、replay

观测面：
  延迟、积压、丢包、状态可信度、线路健康
```

如果只从“收 UDP 包”开始设计，系统很容易长成一条硬编码流水线：这个交易所能跑，下一个交易所接入时到处复制；这个协议能解析，换一套消息格式就开始改主流程。

更稳妥的方式是先定义平台级抽象：

```text
Exchange
  -> Feed
  -> Channel
  -> Packet
  -> Message
  -> Market Event
  -> State Update
  -> Published Data
```

交易所不同，feed 命名不同，协议字段不同，sequence 规则不同，但接入平台内部要尽量统一成这几个概念。

## 二、顶层架构：多交易所接入平台

一个更完整的架构可以拆成这些层：

![交易所组播行情接入全链路架构](/images/posts/trading-multicast-02-architecture/full-link-architecture.svg)

这套分层的核心是：把交易所差异收敛在 adapter，把实时处理主链路保持稳定。

接入第二个、第三个交易所时，不应该重写 receiver、dispatcher、monitor、publisher，而是新增交易所适配层。

## 三、多交易所适配：不要把协议差异写进主链路

港股、NASDAQ、CME、NYSE 这些交易所，协议格式、channel 组织、sequence 规则、恢复机制都可能不同。

平台层不应该直接依赖某个交易所的字段。更合理的方式是定义一个 `ExchangeAdapter` 抽象：

```text
ExchangeAdapter
  - loadFeedConfig()
  - createReceiver()
  - decodePacketHeader()
  - extractChannelId()
  - extractSequence()
  - extractSendTime()
  - decodeMessageType()
  - decodeMessageBody()
  - createRecoveryClient()
```

主链路只关心标准化结果：

```text
AccessData {
    exchange
    feedName
    lineId
    channelId
    sequenceNumber
    originSendTime
    receiveTime
    body
}
```

这样接入新交易所时，变化主要发生在：

```text
Feed 配置解析
Packet header 解析
Message schema 映射
Recovery 协议适配
交易阶段 / 状态枚举适配
```

而不是改动主链路的 dispatcher、state、publisher。

这也是平台化和项目脚本化的区别。脚本式接入能快速跑通一条线路，但协议一多，主链路会被各交易所的特殊逻辑污染。平台式接入则先定义稳定边界，把差异隔离在 adapter。

## 四、Java 模块划分与技术选型

如果用 Java 构建这类系统，模块边界要尽量贴近运行时职责，而不是按“工具类”“service 类”粗放分包。

一个合理的模块划分可以是：

| 模块 | 主要职责 | Java 技术选型 |
| --- | --- | --- |
| access-runtime | 组播接收、网卡绑定、feed 生命周期 | Java NIO `DatagramChannel` / Netty UDP / native multicast library wrapper |
| exchange-adapter | 多交易所协议适配 | SPI / 工厂 / 配置驱动 adapter |
| protocol-decode | 二进制协议解析 | `ByteBuffer` / Netty `ByteBuf` / generated decoder |
| sequencing | channel、sequence、gap 基础能力 | per-channel state + primitive map / concurrent map |
| dispatch | 分区、队列、worker 调度 | Disruptor / JCTools MPSC / `ArrayBlockingQueue` |
| state | 订单簿、快照、参考数据、本地状态 | `ConcurrentHashMap` + striped lock / per-key lock |
| publish | 下游分发、订阅过滤 | Netty TCP / KCP / Aeron / gRPC streaming |
| recovery | 重传、refresh、snapshot、replay | 独立 client + replay queue |
| observability | 指标、日志、告警、trace | Micrometer / Prometheus / 自研 metrics |
| config-control | 动态配置、生命周期、交易日切换 | YAML + dynamic config + lifecycle manager |

技术选型不是为了显得复杂，而是每个模块都有自己的运行时约束。

接收层关注 socket buffer、网卡绑定和收包延迟。
解析层关注二进制解析效率和对象分配。
调度层关注顺序性、吞吐和背压。
状态层关注一致性和锁粒度。
发布层关注慢消费者隔离。
恢复层关注状态闭环。
观测层关注数据是否可信。

## 五、Access Runtime：接收层只处理接入语义

Access Runtime 负责和网络环境打交道：

```text
绑定 multicast interface
join multicast group
配置 socket receive buffer
启动 receiver thread
处理 feed 生命周期
识别 lineId / feedName
```

多网卡环境下，不能只依赖默认路由。启动时应该校验：

```text
configured multicast interface IPs
    ∩
local network interface IPs
    =
bind candidates
```

如果交集为空，说明这台机器不该接这条 feed，或者配置错了。
如果交集超过一个，说明绑定有歧义，应该拒绝启动或报警。
如果刚好一个，才进入接收流程。

Access Runtime 不应该理解具体业务消息。它只把 packet 转换为 `AccessData`。

## 六、Packet Context：不要只传 byte[]

生产系统里，接收层不能只传原始 `byte[]`。

后续链路需要这些上下文：

```text
exchange
feedName
lineId
channelId
sequenceNumber
originSendTime
receiveTime
accessAddress
body
```

这些字段分别服务于不同能力：

```text
channelId        -> 分区和顺序性
sequenceNumber   -> gap detection
originSendTime   -> 端到端延迟
receiveTime      -> 本地接收延迟
lineId           -> 双路仲裁
feedName         -> 多线路区分
exchange         -> 多交易所隔离
```

这一步是架构里非常关键的标准化边界。

接收层之后，系统处理的不再是“网络包”，而是“带交易所、线路、channel、sequence 和时间语义的数据事件”。

## 七、Protocol Decode：解析和业务计算分开

协议解析层负责把 `body` 解析成结构化消息。

这里要避免两个问题：

第一，不要在 receiver thread 做完整解析。
第二，不要把协议解析和业务状态更新揉在一起。

更清晰的流程是：

```text
AccessData
  -> identify message type
  -> decode fields
  -> build MarketEvent / TransferData
  -> pass to state / publish
```

Java 里常见选择有：

```text
ByteBuffer:
  JDK 原生，简单稳定，适合明确二进制布局

Netty ByteBuf:
  网络系统友好，支持 direct buffer 和引用计数

generated decoder:
  适合协议字段多、版本多、需要减少手写解析错误的场景
```

不建议在热路径上做字符串切分、JSON 解析或反射式字段绑定。交易所行情协议通常是二进制协议，解析层应该尽量接近协议布局，减少拷贝和临时对象。

## 八、Sequencing Layer：sequence 是平台能力

Sequence 不应该是某个 receiver 内部的局部变量。

它应该成为平台能力，贯穿：

```text
接收
解析
分区
状态应用
下游转发
监控
恢复
```

每个 channel 至少维护：

```text
expectedSeq
lastReceivedSeq
lastAppliedSeq
openGapRanges
lineHealth
channelStatus
```

这里 `lastReceivedSeq` 和 `lastAppliedSeq` 要分开。

收到某个 sequence，只代表接收层看见了它；只有消息按顺序成功应用到本地状态，才能推进 `lastAppliedSeq`。

如果 sequence 只在 receiver 里检查一次，后续状态无法证明自己可信。

## 九、Dispatch Layer：分区是顺序性和吞吐的平衡

行情数据有两种相互冲突的要求：

```text
同一 channel / instrument 需要顺序
不同 channel / instrument 希望并行
```

因此调度层通常按 channel 或 instrument 分区：

```text
partitionKey = partition(exchange, feedName, channelId)
worker = workers[partitionKey % workerCount]
```

这里不要把它写成普通线程池。

普通线程池只关心并发执行，不能天然保证同一 channel 的顺序。行情接入系统需要的是“有边界的并行”：该串行的串行，该并行的并行。

分区策略还要考虑热点 channel。真实行情流量经常不均匀，简单 hash 不一定能均衡负载。架构上要允许：

```text
热点 channel 显式映射
普通 channel hash fallback
运行期观察 partition lag
必要时调整映射
```

## 十、State Layer：状态集中管理，处理逻辑保持无状态

行情接入最终会产生本地状态：

```text
order book
snapshot
trade cache
reference data
market status
index status
```

跨消息状态要集中管理，不能散落在各个处理类实例字段里。

尤其是 Java 系统里，很多 process logic / handler 是单例。如果在单例里保存请求级变量：

```text
currentSymbol
currentDate
currentChannel
currentSequence
```

多线程并发时就可能串号。

更合理的原则是：

```text
请求级状态：
  放在 AccessData / MessageContext / TransferData

跨消息状态：
  放在 StateCache / Repository / OrderBookStore
```

状态容器可以使用：

```text
ConcurrentHashMap
per-symbol lock
striped lock
AtomicReference
immutable snapshot
```

具体怎么选，取决于状态更新频率和一致性要求。但架构边界要清晰：处理逻辑负责计算，状态容器负责持久化跨消息状态。

## 十一、Publish Layer：发布不是简单 send

下游发布层至少要处理：

```text
订阅过滤
消息编码
慢消费者隔离
发送队列
连接管理
失败统计
重复数据幂等
```

常见技术选型：

```text
Netty TCP:
  通用、可控、适合内部长连接推送

KCP / UDP-based tunnel:
  适合跨网络低延迟场景，但运维复杂度更高

Aeron:
  低延迟消息传播强，但引入成本较高

gRPC streaming:
  工程生态好，适合控制面或非极限低延迟链路
```

发布层不要阻塞 parse worker。更稳妥的方式是：

```text
State / Parse
  -> Publish Queue
  -> Publish Worker
  -> Downstream
```

这样下游慢不会直接反向拖垮接收链路。

## 十二、Recovery 与 Observability 是平台必选能力

Recovery 不应该是事后补丁。

从架构上就要为这些能力留位置：

```text
双路 channel 仲裁
sequence gap detection
retransmission
refresh
snapshot rebuild
local replay
state trust status
```

观测层也不能只看进程。

至少要能回答：

```text
哪条 feed 正常？
哪个 channel 有 gap？
lastReceivedSeq 到哪里？
lastAppliedSeq 到哪里？
哪个 partition 积压？
哪个下游慢？
状态现在是否可信？
当前输出是实时数据还是恢复数据？
```

指标设计应该贴近数据语义，而不是只看 CPU、内存、端口和进程。

## 十三、顶层设计原则

把整套架构收束一下，组播行情接入平台应该遵守这些原则：

```text
交易所差异封装在 ExchangeAdapter
主链路只处理标准化 AccessData
接收层不做业务计算
协议解析和状态更新解耦
sequence 是全链路能力
分区保证局部顺序和并行吞吐
跨消息状态集中管理
处理逻辑保持无请求级实例状态
发布层隔离慢消费者
恢复链路和实时链路分开
监控围绕连续性、延迟和状态可信度
```

## 小结

交易所组播行情接入的架构价值，不在于写一个 UDP receiver，而在于把不同交易所、不同 feed、不同协议的数据，统一接入到一条可治理的实时数据链路。

这条链路要能做到：

```text
多交易所可扩展
多线路可仲裁
消息可解析
sequence 可追踪
状态可证明
下游可隔离
恢复可闭环
指标可解释
```

一个成熟的行情接入平台，不是“能收到包”，而是能持续回答：

> 我接入的是哪条线路，处理的是哪个 channel，当前 sequence 是否连续，本地状态是否可信，下游是否跟得上，故障时是否能恢复。

这才是全链路架构设计的核心。
