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
