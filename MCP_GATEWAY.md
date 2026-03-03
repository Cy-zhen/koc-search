# MCP Gateway Contract

When `MCP_GATEWAY_URL` is configured, `xiaohongshu` / `douyin` / `tiktok` adapters call the gateway instead of local Playwright.

## Endpoints

All endpoints are `POST` and prefixed by:

`{MCP_GATEWAY_URL}/platform/{platform}/{action}`

Supported actions:

- `status`
- `login`
- `search`

Example:

- `POST https://gateway.example.com/platform/tiktok/status`
- `POST https://gateway.example.com/platform/tiktok/login`
- `POST https://gateway.example.com/platform/tiktok/search`

## Request Payload

### `status`

```json
{}
```

### `login`

```json
{}
```

### `search`

```json
{
  "keyword": "健身",
  "options": {
    "maxResults": 20,
    "minFollowers": 1000,
    "maxFollowers": 0
  }
}
```

## Response Payload

### `status`

```json
{
  "loggedIn": true
}
```

### `login`

```json
{
  "success": true,
  "message": "ok"
}
```

### `search`

Option A (single result):

```json
{
  "message": "ok",
  "kocs": [
    {
      "userId": "abc",
      "nickname": "creator",
      "followers": 12345,
      "description": "bio"
    }
  ]
}
```

Option B (progress updates):

```json
{
  "updates": [
    { "progress": 20, "message": "loading", "kocs": [] },
    { "progress": 100, "message": "done", "kocs": [] }
  ]
}
```

## Auth

If `MCP_GATEWAY_TOKEN` is set, requests include:

`Authorization: Bearer {MCP_GATEWAY_TOKEN}`
