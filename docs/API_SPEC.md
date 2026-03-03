# API 接口规范

Base URL: `http://localhost:3000`

Content-Type:

- 普通 JSON 接口：`application/json`
- 搜索流接口：`text/event-stream`
- 导出接口：`text/csv; charset=utf-8`

## 1. 平台信息

### `GET /api/platforms`

返回可用平台、登录状态、运行模式。

响应示例：

```json
[
  {
    "id": "youtube",
    "name": "youtube",
    "icon": "🎬",
    "requiresLogin": false,
    "loggedIn": true,
    "mode": "api"
  },
  {
    "id": "tiktok",
    "name": "tiktok",
    "icon": "🎶",
    "requiresLogin": true,
    "loggedIn": false,
    "mode": "browser"
  }
]
```

`mode` 取值：

- `api`: 官方 API（当前是 YouTube）
- `browser`: 本地 Playwright
- `mcp`: 远端 MCP 网关

## 2. 平台登录

### `POST /api/auth/:platform/login`

参数：

- `platform`: `youtube | xiaohongshu | douyin | tiktok`

响应示例：

```json
{
  "success": true,
  "message": "抖音登录成功！"
}
```

### `GET /api/auth/:platform/status`

响应示例：

```json
{
  "loggedIn": false
}
```

## 3. 任务管理

### `GET /api/tasks/:taskId`

响应示例：

```json
{
  "id": "task-id",
  "keyword": "健身",
  "platforms": ["youtube", "tiktok"],
  "status": "done",
  "cancelled": false,
  "cancelReason": null,
  "startTime": 1700000000000,
  "endTime": 1700000007000,
  "duration": 7000,
  "totalKocs": 12,
  "summary": {
    "total": 12,
    "withContact": 3,
    "avgScore": 71.5,
    "avgConfidence": 66.2
  }
}
```

### `POST /api/tasks/:taskId/cancel`

用于取消运行中的任务。

响应示例：

```json
{
  "success": true,
  "status": "cancelled"
}
```

## 4. 搜索（SSE）

### `GET /api/search`

Query 参数：

- `keyword` (required): 关键词
- `platforms` (optional): 逗号分隔，如 `youtube,tiktok`
- `maxResults` (optional): 默认 `20`
- `minFollowers` (optional): 默认 `0`
- `maxFollowers` (optional): 默认 `0`（表示不限制）

`keyword` 支持包含关系写法：

- `A|B|C`：OR
- `A+B`：AND
- `包含“A”或包含“B”`：OR（自然语言）

响应头：

- `Content-Type: text/event-stream`
- `X-Task-Id: {taskId}`

`start` 事件会返回：

- `keywordMode`: `single | any | all`
- `keywordTerms`: 拆分后的关键词数组

### SSE 事件类型

每个事件格式：

```text
data: {json}

```

`type` 枚举：

- `start`
- `platform_start`
- `progress`
- `platform_error`
- `platform_done`
- `done`
- `cancelled`

### `progress` 事件示例

```json
{
  "type": "progress",
  "platform": "tiktok",
  "platformProgress": 46,
  "overallProgress": 73,
  "message": "已分析 6/20 个用户",
  "error": null,
  "kocs": [],
  "kocCount": 0
}
```

### `platform_error` 错误码

`code` 可能值：

- `UNKNOWN_PLATFORM`
- `AUTH_REQUIRED`
- `SEARCH_FAILED`
- `TASK_ABORTED`

### `done` / `cancelled` 事件示例

```json
{
  "type": "done",
  "taskId": "task-id",
  "totalKocs": 18,
  "kocs": [],
  "duration": 9850,
  "summary": {
    "total": 18,
    "withContact": 4,
    "avgScore": 70.3,
    "avgConfidence": 64.1
  }
}
```

## 5. 导出

### `GET /api/export/:taskId`

从任务缓存导出 CSV。

### `POST /api/export`

请求体：

```json
{
  "keyword": "健身",
  "kocs": []
}
```

## 6. KOC 数据结构

```json
{
  "platform": "tiktok",
  "platformIcon": "🎶",
  "userId": "abc",
  "username": "creator",
  "nickname": "Creator Name",
  "avatar": "https://...",
  "profileUrl": "https://...",
  "followers": 12000,
  "following": 100,
  "likes": 32000,
  "totalViews": 240000,
  "posts": 180,
  "description": "bio",
  "category": "Fitness",
  "contactInfo": {
    "email": "a@b.com"
  },
  "recentPosts": [],
  "engagementRate": 0.04,
  "evaluation": {
    "totalScore": 72.3,
    "grade": "A",
    "confidence": 64,
    "scores": {
      "engagementRate": 75,
      "followerFit": 85,
      "activityLevel": 70,
      "contentRelevance": 80,
      "growthTrend": 65
    },
    "tags": ["优质KOC", "高互动"],
    "recommendation": "推荐合作，可优先进入沟通名单；...",
    "dataQuality": {
      "score": 64,
      "level": "medium",
      "checks": {
        "followers": 1,
        "profileText": 1,
        "category": 1,
        "postsCount": 1,
        "recentPosts": 0.5,
        "interactionSignals": 1,
        "contactInfo": 0
      }
    }
  }
}
```
