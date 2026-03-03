import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 45000);

let passed = 0;
let failed = 0;

function logPass(name) {
    passed += 1;
    console.log(`PASS ${name}`);
}

function logFail(name, err) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(`  ${err.message}`);
}

async function runTest(name, fn) {
    try {
        await fn();
        logPass(name);
    } catch (err) {
        logFail(name, err);
    }
}

async function fetchJson(path, init = {}) {
    const resp = await fetch(`${BASE_URL}${path}`, init);
    const text = await resp.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    return { resp, text, json };
}

async function collectSse(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const resp = await fetch(`${BASE_URL}${path}`, { signal: controller.signal });
        assert.equal(resp.status, 200, `SSE HTTP status=${resp.status}`);
        assert.ok(resp.body, 'SSE response body empty');

        const taskId = resp.headers.get('x-task-id');
        assert.ok(taskId, 'missing x-task-id header');

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        const events = [];
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split('\n\n');
            buffer = frames.pop() || '';

            for (const frame of frames) {
                const line = frame
                    .split('\n')
                    .find((x) => x.startsWith('data: '));
                if (!line) continue;

                const payload = JSON.parse(line.slice(6));
                events.push(payload);

                if (payload.type === 'done' || payload.type === 'cancelled') {
                    await reader.cancel();
                    return { taskId, events };
                }
            }
        }

        return { taskId, events };
    } finally {
        clearTimeout(timer);
    }
}

async function main() {
    console.log(`Running API smoke tests on ${BASE_URL}`);

    let latestTaskId = null;

    await runTest('GET /api/platforms', async () => {
        const { resp, json, text } = await fetchJson('/api/platforms');
        assert.equal(resp.status, 200, text);
        assert.ok(Array.isArray(json), 'platforms is not array');
        const ids = json.map((x) => x.id);
        for (const id of ['youtube', 'xiaohongshu', 'douyin', 'tiktok']) {
            assert.ok(ids.includes(id), `missing platform ${id}`);
        }
        for (const item of json) {
            assert.equal(typeof item.loggedIn, 'boolean', 'loggedIn must be boolean');
            assert.ok(['api', 'browser', 'mcp'].includes(item.mode), 'mode invalid');
        }
    });

    await runTest('GET /api/auth/youtube/status', async () => {
        const { resp, json, text } = await fetchJson('/api/auth/youtube/status');
        assert.equal(resp.status, 200, text);
        assert.equal(typeof json.loggedIn, 'boolean');
    });

    await runTest('GET /api/search (SSE)', async () => {
        const query = '/api/search?keyword=%E5%81%A5%E8%BA%AB&platforms=youtube&maxResults=3';
        const { taskId, events } = await collectSse(query);
        latestTaskId = taskId;

        assert.ok(events.length > 0, 'SSE no events');
        assert.ok(events.some((e) => e.type === 'start'), 'missing start event');
        assert.ok(
            events.some((e) => e.type === 'done' || e.type === 'cancelled'),
            'missing done/cancelled event'
        );
    });

    await runTest('GET /api/tasks/:taskId', async () => {
        assert.ok(latestTaskId, 'taskId missing from previous test');
        const { resp, json, text } = await fetchJson(`/api/tasks/${latestTaskId}`);
        assert.equal(resp.status, 200, text);
        assert.ok(['running', 'done', 'cancelled'].includes(json.status), 'invalid status');
        assert.ok(json.summary && typeof json.summary.total === 'number', 'missing summary');
    });

    await runTest('POST /api/tasks/:taskId/cancel (idempotent)', async () => {
        assert.ok(latestTaskId, 'taskId missing from previous test');
        const { resp, json, text } = await fetchJson(`/api/tasks/${latestTaskId}/cancel`, {
            method: 'POST',
        });
        assert.equal(resp.status, 200, text);
        assert.equal(json.success, true);
        assert.ok(['cancelled', 'done', 'running'].includes(json.status), 'invalid cancel status');
    });

    await runTest('POST /api/export', async () => {
        const fixturePath = new URL('../tests/fixtures/export_payload.json', import.meta.url);
        const payload = JSON.parse(await fs.readFile(fixturePath, 'utf8'));

        const resp = await fetch(`${BASE_URL}/api/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        const text = await resp.text();
        assert.equal(resp.status, 200, text);
        assert.ok(
            (resp.headers.get('content-type') || '').includes('text/csv'),
            'content-type is not csv'
        );
        assert.ok(text.includes('数据可信度'), 'csv missing 数据可信度 column');
    });

    console.log(`\nSummary: passed=${passed}, failed=${failed}`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error('Smoke test crashed');
    console.error(err);
    process.exit(1);
});
