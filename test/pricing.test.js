const test = require('node:test');
const assert = require('node:assert');

const { createDefaultPricingResolver } = require('../src/pricing');

const PER_MTOK = 1e6;

test('opus 4.7 and 4.8 use the modern $5/$25 Opus tier, not the legacy $15/$75', () => {
  const getPricing = createDefaultPricingResolver();

  for (const model of ['claude-opus-4-7', 'claude-opus-4-8']) {
    const pricing = getPricing(model);
    assert.equal(pricing.input * PER_MTOK, 5, `${model} input`);
    assert.equal(pricing.output * PER_MTOK, 25, `${model} output`);
    assert.equal(pricing.cacheWrite * PER_MTOK, 6.25, `${model} cacheWrite`);
    assert.equal(pricing.cacheRead * PER_MTOK, 0.5, `${model} cacheRead`);
  }
});

test('opus 4.5 and 4.6 stay on the $5/$25 tier', () => {
  const getPricing = createDefaultPricingResolver();

  for (const model of ['claude-opus-4-5', 'claude-opus-4-6']) {
    assert.equal(getPricing(model).input * PER_MTOK, 5, `${model} input`);
    assert.equal(getPricing(model).output * PER_MTOK, 25, `${model} output`);
  }
});

test('legacy opus 4.0 / 4.1 / 3 keep the $15/$75 tier', () => {
  const getPricing = createDefaultPricingResolver();

  for (const model of [
    'anthropic.claude-opus-4-1-20250805-v1:0',
    'anthropic.claude-opus-4-20250514-v1:0',
    'anthropic.claude-3-opus-20240229-v1:0',
  ]) {
    assert.equal(getPricing(model).input * PER_MTOK, 15, `${model} input`);
    assert.equal(getPricing(model).output * PER_MTOK, 75, `${model} output`);
  }
});

test('a future opus version defaults to the modern $5/$25 tier', () => {
  const getPricing = createDefaultPricingResolver();
  const pricing = getPricing('claude-opus-4-9');
  assert.equal(pricing.input * PER_MTOK, 5);
  assert.equal(pricing.output * PER_MTOK, 25);
});

test('Codex models use provider-specific standard API-equivalent pricing', () => {
  const getPricing = createDefaultPricingResolver();
  const pricing = getPricing('gpt-5.4', 'Codex', { inputTokens: 1000 });
  assert.equal(pricing.input * PER_MTOK, 2.5);
  assert.equal(pricing.cacheRead * PER_MTOK, 0.25);
  assert.equal(pricing.output * PER_MTOK, 15);
});

test('GPT models use OpenAI pricing even when recorded by Claude Code', () => {
  const getPricing = createDefaultPricingResolver();
  const pricing = getPricing('gpt-5.6-sol', 'Claude Code', { inputTokens: 100000 });
  assert.equal(pricing.input * PER_MTOK, 5);
  assert.equal(pricing.cacheRead * PER_MTOK, 0.5);
  assert.equal(pricing.output * PER_MTOK, 30);
});

test('Claude models use Anthropic pricing even when recorded by Codex', () => {
  const getPricing = createDefaultPricingResolver();
  const pricing = getPricing('claude-sonnet-4-6', 'Codex');
  assert.equal(pricing.input * PER_MTOK, 3);
  assert.equal(pricing.cacheRead * PER_MTOK, 0.3);
  assert.equal(pricing.output * PER_MTOK, 15);
});

test('provider-prefixed GPT model IDs still use OpenAI pricing', () => {
  const getPricing = createDefaultPricingResolver();
  for (const model of ['openai/gpt-5.6-sol', 'openai:gpt-5.6-sol', 'openai.gpt-5.6-sol']) {
    const pricing = getPricing(model, 'Claude Code', { inputTokens: 100000 });
    assert.equal(pricing.input * PER_MTOK, 5, model);
    assert.equal(pricing.output * PER_MTOK, 30, model);
  }
});

test('the GPT-5.6 alias resolves to GPT-5.6 Sol pricing', () => {
  const getPricing = createDefaultPricingResolver();
  const pricing = getPricing('gpt-5.6', 'Claude Code', { inputTokens: 100000 });
  assert.equal(pricing.input * PER_MTOK, 5);
  assert.equal(pricing.output * PER_MTOK, 30);
});

test('Claude Sonnet 5 and Fable 5 use their own current pricing tiers', () => {
  const getPricing = createDefaultPricingResolver();
  const sonnet = getPricing('claude-sonnet-5', 'Claude Code');
  const fable = getPricing('claude-fable-5', 'Claude Code');
  assert.deepEqual(
    [sonnet.input, sonnet.cacheWrite, sonnet.cacheRead, sonnet.output].map((rate) => rate * PER_MTOK),
    [2, 2.5, 0.2, 10]
  );
  assert.deepEqual(
    [fable.input, fable.cacheWrite, fable.cacheRead, fable.output].map((rate) => rate * PER_MTOK),
    [10, 12.5, 1, 50]
  );
});

test('older Sonnet versions do not match the Sonnet 5 tier', () => {
  const getPricing = createDefaultPricingResolver();
  for (const model of ['claude-sonnet-4-5', 'claude-3-5-sonnet']) {
    assert.equal(getPricing(model, 'Claude Code').input * PER_MTOK, 3, model);
  }
});

test('unknown Claude model families remain unpriced instead of falling through to Sonnet', () => {
  const getPricing = createDefaultPricingResolver();
  assert.equal(getPricing('claude-unknown-99', 'Claude Code'), null);
});

test('Codex long-context rates use raw input token count', () => {
  const getPricing = createDefaultPricingResolver();
  const pricing = getPricing('gpt-5.6-sol', 'Codex', { inputTokens: 272001 });
  assert.equal(pricing.input * PER_MTOK, 10);
  assert.equal(pricing.cacheWrite * PER_MTOK, 12.5);
  assert.equal(pricing.output * PER_MTOK, 45);
});

test('unpriced and unknown Codex models never fall through to Sonnet', () => {
  const getPricing = createDefaultPricingResolver();
  assert.equal(getPricing('gpt-5.3-codex-spark', 'Codex'), null);
  assert.equal(getPricing('future-openai-model', 'Codex'), null);
});
