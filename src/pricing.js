const DEFAULT_MODEL_PRICING = {
  'opus-4.8': { input: 5 / 1e6, output: 25 / 1e6, cacheWrite: 6.25 / 1e6, cacheRead: 0.5 / 1e6 },
  'opus-4.7': { input: 5 / 1e6, output: 25 / 1e6, cacheWrite: 6.25 / 1e6, cacheRead: 0.5 / 1e6 },
  'opus-4.6': { input: 5 / 1e6, output: 25 / 1e6, cacheWrite: 6.25 / 1e6, cacheRead: 0.5 / 1e6 },
  'opus-4.5': { input: 5 / 1e6, output: 25 / 1e6, cacheWrite: 6.25 / 1e6, cacheRead: 0.5 / 1e6 },
  'opus-4.1': { input: 15 / 1e6, output: 75 / 1e6, cacheWrite: 18.75 / 1e6, cacheRead: 1.5 / 1e6 },
  'opus-4.0': { input: 15 / 1e6, output: 75 / 1e6, cacheWrite: 18.75 / 1e6, cacheRead: 1.5 / 1e6 },
  sonnet: { input: 3 / 1e6, output: 15 / 1e6, cacheWrite: 3.75 / 1e6, cacheRead: 0.3 / 1e6 },
  'haiku-4.5': { input: 1 / 1e6, output: 5 / 1e6, cacheWrite: 1.25 / 1e6, cacheRead: 0.1 / 1e6 },
  'haiku-3.5': { input: 0.8 / 1e6, output: 4 / 1e6, cacheWrite: 1 / 1e6, cacheRead: 0.08 / 1e6 },
};

const DEFAULT_CATEGORY_MODEL_IDS = {
  'opus-4.8': ['anthropic.claude-opus-4-8', 'global.anthropic.claude-opus-4-8'],
  'opus-4.7': ['anthropic.claude-opus-4-7', 'global.anthropic.claude-opus-4-7'],
  'opus-4.6': ['anthropic.claude-opus-4-6-v1', 'global.anthropic.claude-opus-4-6-v1'],
  'opus-4.5': ['anthropic.claude-opus-4-5-20251101-v1:0'],
  'opus-4.1': ['anthropic.claude-opus-4-1-20250805-v1:0'],
  'opus-4.0': ['anthropic.claude-opus-4-20250514-v1:0', 'anthropic.claude-3-opus-20240229-v1:0'],
  sonnet: ['anthropic.claude-sonnet-4-6', 'anthropic.claude-3-7-sonnet-20250219-v1:0', 'anthropic.claude-3-5-sonnet-20241022-v2:0'],
  'haiku-4.5': ['anthropic.claude-haiku-4-5-20251001-v1:0'],
  'haiku-3.5': ['anthropic.claude-3-5-haiku-20241022-v1:0'],
};

const LITELLM_PRICING_URL =
  process.env.LITELLM_PRICING_URL ||
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

let pricingState = null;
let pricingInitializationPromise = null;

function createDefaultPricingResolver() {
  return buildCategoryPricingResolver(DEFAULT_MODEL_PRICING);
}

function normalizeModelPricingEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const input = Number(entry.input_cost_per_token);
  const output = Number(entry.output_cost_per_token);
  const cacheWrite = Number(entry.cache_creation_input_token_cost);
  const cacheRead = Number(entry.cache_read_input_token_cost);

  if (![input, output, cacheWrite, cacheRead].every(Number.isFinite)) {
    return null;
  }

  return { input, output, cacheWrite, cacheRead };
}

function buildCategoryPricingMap(modelMap) {
  const categories = {};

  for (const [category, candidates] of Object.entries(DEFAULT_CATEGORY_MODEL_IDS)) {
    const matchedModelId = candidates.find((candidate) => modelMap[candidate]);
    const normalizedEntry = matchedModelId ? normalizeModelPricingEntry(modelMap[matchedModelId]) : null;
    categories[category] = normalizedEntry || DEFAULT_MODEL_PRICING[category];
  }

  return categories;
}

function buildCategoryPricingResolver(categoryPricingMap) {
  const defaultPricing = categoryPricingMap.sonnet || DEFAULT_MODEL_PRICING.sonnet;

  return function getPricing(modelName) {
    const model = String(modelName || '').toLowerCase();

    if (model.includes('opus')) {
      // Legacy Opus generation (4.0 / 4.1 / 3) priced at the old $15/$75 tier.
      const isLegacyOpus =
        model.includes('4-1') ||
        model.includes('4.1') ||
        model.includes('claude-3-opus') ||
        model.includes('opus-4-2025') || // base claude-opus-4-2025xxxx (4.0)
        model.includes('opus-4-0') ||
        model.includes('opus-4.0');
      if (isLegacyOpus) {
        return categoryPricingMap['opus-4.1'] || defaultPricing;
      }

      if (model.includes('4-8') || model.includes('4.8')) {
        return categoryPricingMap['opus-4.8'] || categoryPricingMap['opus-4.6'] || defaultPricing;
      }
      if (model.includes('4-7') || model.includes('4.7')) {
        return categoryPricingMap['opus-4.7'] || categoryPricingMap['opus-4.6'] || defaultPricing;
      }
      if (model.includes('4-5') || model.includes('4.5')) {
        return categoryPricingMap['opus-4.5'] || defaultPricing;
      }
      // Default to the modern Opus tier ($5/$25) for 4.6 and any newer version.
      return categoryPricingMap['opus-4.6'] || defaultPricing;
    }

    if (model.includes('haiku')) {
      if (model.includes('4-5') || model.includes('4.5')) {
        return categoryPricingMap['haiku-4.5'] || defaultPricing;
      }
      return categoryPricingMap['haiku-3.5'] || defaultPricing;
    }

    return categoryPricingMap.sonnet || defaultPricing;
  };
}

async function fetchLiteLLMCategoryPricingMap() {
  const response = await fetch(LITELLM_PRICING_URL, {
    signal: AbortSignal.timeout(5000),
    headers: {
      Accept: 'application/json',
      'User-Agent': 'claude-usage-export/0.1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`LiteLLM pricing request failed with ${response.status}`);
  }

  const payload = await response.json();
  return buildCategoryPricingMap(payload);
}

async function initializePricingResolver() {
  if (pricingState) {
    return pricingState;
  }

  if (!pricingInitializationPromise) {
    console.log('Fetching latest model pricing from LiteLLM...');
    pricingInitializationPromise = fetchLiteLLMCategoryPricingMap()
      .then((categoryPricingMap) => {
        pricingState = {
          source: 'litellm',
          categoryPricingMap,
          getPricing: buildCategoryPricingResolver(categoryPricingMap),
        };
        console.log('Initialized pricing from LiteLLM.');
        return pricingState;
      })
      .catch((error) => {
        pricingState = {
          source: 'default',
          categoryPricingMap: DEFAULT_MODEL_PRICING,
          getPricing: createDefaultPricingResolver(),
        };
        console.warn(
          `Failed to fetch LiteLLM pricing, falling back to bundled defaults: ${error.message}`
        );
        return pricingState;
      })
      .finally(() => {
        pricingInitializationPromise = null;
      });
  }

  return pricingInitializationPromise;
}

module.exports = {
  DEFAULT_MODEL_PRICING,
  createDefaultPricingResolver,
  initializePricingResolver,
};
