# Session Restart State Handling 修复分析

本文档记录了 session restart 相关问题的修复分析。

---

## Problem 1: SDK session ID persists after restart

### 问题场景

```
用户发送消息 → state=processing → sdkSessionId=abc123
              ↓
服务 crash → systemd 重启 → 读取持久化 session.json
              ↓
state=processing (卡住) + sdkSessionId=abc123 (仍存在)
              ↓
用户发新消息 → resume: abc123 → SDK 尝试恢复 server-side 会话
              ↓
问题：SDK 进程已死，abc123 指向的会话可能：
  - 已终止 → 出错
  - 还存在 → 继续处理旧任务（用户实际遇到的情况）
```

### 实际影响

用户发送新消息后，收到的是旧任务的回复（请求和响应不匹配）。

### 修复方案

```typescript
// src/main.ts - runDaemon()
if (session.sdkSessionId) {
  logger.info('Clearing SDK session ID on restart', { accountId: account.accountId, sessionId: session.sdkSessionId });
  session.previousSdkSessionId = session.sdkSessionId;  // 备份，便于手动恢复
  session.sdkSessionId = undefined;                     // 清除，避免 resume 继续旧任务
}
```

### 必要性评估

| 等级 | 说明 |
|-----|-----|
| **高** | 用户实际遇到的问题，严重影响用户体验 |

---

## Problem 2: Permission timeout uses wrong context

### 问题场景

```
消息1 → 创建权限请求 → sharedCtx.lastContextToken = token1
                      ↓
                      等待用户 y/n（最多120秒）
                      ↓
消息2 到达 → sharedCtx.lastContextToken = token2 ← 覆盖了！
            ↓
120秒超时 → 用 sharedCtx.lastContextToken = token2 发送超时消息
            ↓
问题：超时消息发到了消息2的用户（token2），而不是消息1（token1）
```

### 修复方案

修改前：依赖共享状态 `sharedCtx.lastContextToken`

```typescript
// 旧代码
const permissionBroker = createPermissionBroker(async () => {
  await sender.sendText(fromUserId, sharedCtx.lastContextToken, '⏰ 权限请求超时');
});
```

修改后：将 context 存储在 PendingPermission 本身

```typescript
// src/session.ts
export interface PendingPermission {
  toolName: string;
  toolInput: string;
  contextToken: string;  // Store context token for timeout message
  fromUserId: string;    // Store user ID for timeout message
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

// src/permission.ts
function createPending(
  accountId: string,
  toolName: string,
  toolInput: string,
  contextToken: string,  // 直接传入
  fromUserId: string,    // 直接传入
): Promise<boolean> {
  // ...
  pending.set(accountId, { toolName, toolInput, contextToken, fromUserId, resolve, timer });
  // timeout 时使用存储的 contextToken 和 fromUserId
}
```

### 必要性评估

| 等级 | 说明 |
|-----|-----|
| **中** | 边缘场景，但架构上不应依赖共享状态，多账号支持更健壮 |

---

## 修复涉及的文件

| 文件 | 改动 |
|-----|-----|
| `src/session.ts` | PendingPermission 添加 contextToken/fromUserId 字段 |
| `src/permission.ts` | createPending 接收这两个参数，timeout 时使用 |
| `src/main.ts` | sdkSessionId 清除 + permissionBroker callback 传递参数 + splitMessage 代码块保护 |

