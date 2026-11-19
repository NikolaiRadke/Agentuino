/*
 * Model suggestions and effort levels: parsing the agents' model lists,
 * per-model levels, fixed lists from agentConfigs.json
 */

"use strict";

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const modelCatalog = env.ext('out/agents/modelCatalog.js');
const registry = env.ext('out/agents/registry.js');

test('model lists are parsed in all three formats', () => {
    const opencode = 'ollama/qwen\n{\n  "variants": {}\n}\nopencode/thinker\n{\n  "variants": {\n    "low": {},\n    "max": {}\n  }\n}\n';
    assert.deepEqual(modelCatalog.parse('opencode-verbose', opencode), [
        { id: 'ollama/qwen', efforts: [] },
        { id: 'opencode/thinker', efforts: ['low', 'max'] }
    ]);

    const codex = JSON.stringify({ models: [
        { slug: 'a', supported_reasoning_levels: [{ effort: 'low' }, { effort: '--bad' }] },
        { slug: 'hidden', visibility: 'hide' },
        { slug: 'a' }
    ] });
    assert.deepEqual(modelCatalog.parse('codex-json', codex), [{ id: 'a', efforts: ['low'] }]);

    assert.deepEqual(modelCatalog.parse('lines', 'Models:\n  gemini-pro (default)\n--flag\n'), [{ id: 'gemini-pro', efforts: null }]);
    assert.deepEqual(modelCatalog.parse('codex-json', 'not json'), []);
});

test('effort levels come from the model if the agent reports them, else from the fixed list', async () => {
    const codex = registry.get('codex');
    const listed = await modelCatalog.listModels(codex, env.fake('codex'));
    assert.deepEqual(listed.map(model => model.id), ['gpt-fast', 'gpt-old']);
    assert.deepEqual(modelCatalog.describe(codex, listed, 'gpt-fast').efforts, ['low', 'medium', 'ultra']);
    // Typed by hand, unknown to Codex: the fixed list from agentConfigs.json
    assert.deepEqual(modelCatalog.describe(codex, listed, 'my-model').efforts, codex.efforts);

    const opencode = registry.get('opencode');
    const fromOpencode = await modelCatalog.listModels(opencode, env.fake('opencode'));
    assert.deepEqual(modelCatalog.describe(opencode, fromOpencode, 'opencode/thinker').efforts, ['none', 'high']);
    // A local model without variants has no effort levels
    assert.deepEqual(modelCatalog.describe(opencode, fromOpencode, 'ollama/qwen-coder').efforts, []);

    // No list command: only the fixed suggestions
    const claude = modelCatalog.describe(registry.get('claudecode'), [], 'opus');
    assert.ok(claude.models.includes('opus'));
    assert.ok(claude.efforts.includes('max'));
    // No effort option at all
    assert.deepEqual(modelCatalog.describe(registry.get('vibe'), [], '').efforts, []);
});

test('a failing list command leaves the fixed lists and is tried again later', async () => {
    const agy = registry.get('antigravity');
    assert.deepEqual(await modelCatalog.listModels(agy, env.fake('missing-agy')), []);
    const listed = await modelCatalog.listModels(agy, env.fake('agy'));
    assert.deepEqual(listed.map(model => model.id), ['gemini-pro-high', 'gemini-flash-low']);
});
