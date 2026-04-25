const fs = require('node:fs');
const path = require('node:path');
const { fileToDataUrl } = require('./files');
const { renderPdfPagesAsDataUrls } = require('./answerSheets');
const {
  applyAutoSplitGradingRule,
  extractQuestionSubquestionCatalog,
  normalizeOrdinaryGradingRuleTree,
} = require('./gradingRuleAutoSplit');
const { buildEssayRuleSummary, getEssayRuleTreeTotalScore, normalizeEssayRuleTree } = require('./essayRuleTree');
const { buildOrdinarySectionContext } = require('./subjectiveReviewUtils');
const { buildEssaySectionPlan } = require('./essayReviewUtils');

const DEFAULT_MODELS = {
  general: 'doubao-seed-2-0-pro-260215',
};
const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';

const MODEL_FALLBACKS = {
  general: [
    'doubao-seed-2-0-pro-260215',
    'doubao-seed-1-6-250615',
    'doubao-seed-1-6-251015',
    'doubao-seed-2-0-lite-260215',
    'doubao-seed-1-6-lite-251015',
    'doubao-1-5-lite-32k-250115',
  ],
};

const resolvedModelCache = new Map();
const answerSheetRecognitionCache = new Map();
const answerSheetRecognitionInFlight = new Map();
const ANSWER_SHEET_CACHE_LIMIT = 200;
const generatedModelDebugDir = path.resolve(__dirname, '..', '..', 'data', 'generated', 'model-debug');

function clearModelResolutionCache() {
  const clearedCount = resolvedModelCache.size;
  resolvedModelCache.clear();
  return clearedCount;
}

function clearAnswerSheetRecognitionCache() {
  const clearedCount = answerSheetRecognitionCache.size;
  answerSheetRecognitionCache.clear();
  answerSheetRecognitionInFlight.clear();
  return clearedCount;
}

function normalizeChatProfile(profile) {
  const normalized = String(profile || '').trim();
  return ['general', 'answerSheet', 'subjectiveGrading', 'normal', 'strong'].includes(normalized) ? normalized : 'general';
}

function getProfileConfig(settings, profile) {
  const normalizedProfile = normalizeChatProfile(profile);
  const effectiveProfile = normalizedProfile === 'normal' || normalizedProfile === 'strong' ? 'general' : normalizedProfile;

  if (effectiveProfile === 'general') {
    const apiKey = String(settings?.generalApiKey ?? '').trim();
    if (!apiKey) {
      throw new Error('请先填写综合模型（豆包）的 API Key。');
    }

    return {
      profile: effectiveProfile,
      apiKey,
      preferredModel: String(settings?.generalModel ?? DEFAULT_MODELS.general).trim() || DEFAULT_MODELS.general,
      baseUrl: String(settings?.apiBaseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3').trim() || 'https://ark.cn-beijing.volces.com/api/v3',
    };
  }

  if (effectiveProfile === 'answerSheet') {
    const apiKey = String(settings?.answerSheetApiKey ?? '').trim();
    if (!apiKey) {
      throw new Error('请先填写答题卡识别（硅基流动）的 API Key。');
    }

    return {
      profile: effectiveProfile,
      apiKey,
      preferredModel: String(settings?.answerSheetModel ?? 'PaddlePaddle/PaddleOCR-VL').trim() || 'PaddlePaddle/PaddleOCR-VL',
      baseUrl: SILICONFLOW_BASE_URL,
    };
  }

  if (effectiveProfile === 'subjectiveGrading') {
    const apiKey = String(settings?.subjectiveGradingApiKey ?? '').trim();
    if (!apiKey) {
      throw new Error('请先填写主观题阅卷（硅基流动）的 API Key。');
    }

    return {
      profile: effectiveProfile,
      apiKey,
      preferredModel: String(settings?.subjectiveGradingModel ?? 'Pro/deepseek-ai/DeepSeek-R1').trim() || 'Pro/deepseek-ai/DeepSeek-R1',
      baseUrl: SILICONFLOW_BASE_URL,
    };
  }

  return getProfileConfig(settings, effectiveProfile);

  const apiKey = settings.generalApiKey;
  const preferredModel =
    normalizedProfile === 'strong'
      ? settings.generalModel || DEFAULT_MODELS.general
      : settings.generalModel || DEFAULT_MODELS.general;
  const baseUrl = settings.apiBaseUrl || 'https://ark.cn-beijing.volces.com/api/v3';

  if (!apiKey) {
    throw new Error(`请先填写${normalizedProfile === 'strong' ? '强力' : '普通'}模型的 API Key。`);
  }

  return { profile: normalizedProfile, apiKey, preferredModel, baseUrl };
}

function getProviderForProfile(profile) {
  const normalizedProfile = normalizeChatProfile(profile);
  return normalizedProfile === 'answerSheet' || normalizedProfile === 'subjectiveGrading' ? 'siliconflow' : 'doubao';
}

function getModelCandidates(settings, profile, cachedModel) {
  const profileConfig = getProfileConfig(settings, profile);
  return Array.from(
    new Set([cachedModel, profileConfig.preferredModel, ...(MODEL_FALLBACKS[profileConfig.profile] || [])].filter(Boolean)),
  );
}

function getPayloadMessage(payload) {
  return payload?.error?.message || payload?.message || '豆包接口调用失败';
}

function isModelAccessError(status, message) {
  if (![403, 404].includes(status)) return false;
  return /do not have access|does not exist|requested resource/i.test(String(message || ''));
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestOpenAICompatibleCompletion({ apiKey, baseUrl, model, messages, temperature = 0, maxTokens = 120 }) {
  const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!normalizedBaseUrl) {
    throw new Error('模型接口地址未配置。');
  }
  if (!apiKey) {
    throw new Error('API Key 未配置。');
  }
  if (!model) {
    throw new Error('模型名称未配置。');
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    let payload = {};

    try {
      response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          messages,
        }),
      });
      payload = await response.json().catch(() => ({}));
    } catch (error) {
      if (attempt < 2) {
        await wait(800 * (attempt + 1));
        continue;
      }
      throw error;
    }

    if (response.ok) {
      payload.__selectedModel = model;
      return payload;
    }

    const message = getPayloadMessage(payload);
    if (isRetryableStatus(response.status) && attempt < 2) {
      await wait(800 * (attempt + 1));
      continue;
    }

    throw new Error(message);
  }

  throw new Error('接口调用失败，请稍后重试。');
}

function resolveConnectionConfig(settings, target) {
  const normalizedTarget = String(target || '').trim();

  if (normalizedTarget === 'answerSheet') {
    const apiKey = String(settings?.answerSheetApiKey ?? '').trim();
    if (!apiKey) {
      throw new Error('请先填写答题卡识别（硅基流动）的 API Key。');
    }

    return {
      target: 'answerSheet',
      label: '答题卡专用',
      provider: 'siliconflow',
      apiKey,
      model: String(settings?.answerSheetModel ?? 'PaddlePaddle/PaddleOCR-VL').trim() || 'PaddlePaddle/PaddleOCR-VL',
      baseUrl: SILICONFLOW_BASE_URL,
    };
  }

  if (normalizedTarget === 'subjectiveGrading') {
    const apiKey = String(settings?.subjectiveGradingApiKey ?? '').trim();
    if (!apiKey) {
      throw new Error('请先填写主观题阅卷（硅基流动）的 API Key。');
    }

    return {
      target: 'subjectiveGrading',
      label: '阅卷专用',
      provider: 'siliconflow',
      apiKey,
      model: String(settings?.subjectiveGradingModel ?? 'Pro/deepseek-ai/DeepSeek-R1').trim() || 'Pro/deepseek-ai/DeepSeek-R1',
      baseUrl: SILICONFLOW_BASE_URL,
    };
  }

  if (normalizedTarget === 'normal' || normalizedTarget === 'strong') {
    const profileConfig = getProfileConfig(settings, normalizedTarget);
    return {
      target: normalizedTarget,
      label: normalizedTarget === 'strong' ? '强力模型' : '普通模型',
      provider: getProviderForProfile(normalizedTarget),
      apiKey: profileConfig.apiKey,
      model: profileConfig.preferredModel,
      baseUrl: profileConfig.baseUrl,
    };
  }

  const apiKey = String(settings?.generalApiKey ?? '').trim();
  if (!apiKey) {
    throw new Error('请先填写综合模型（豆包）的 API Key。');
  }

  return {
    target: 'general',
    label: '综合模型',
    provider: getProviderForProfile('general'),
    apiKey,
    model: String(settings?.generalModel ?? 'Doubao-Seed-2.0-pro').trim() || 'Doubao-Seed-2.0-pro',
    baseUrl: String(settings?.apiBaseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3').trim() || 'https://ark.cn-beijing.volces.com/api/v3',
  };
}

async function chatCompletion({ settings, profile, messages, temperature = 0.2, maxTokens = 2600 }) {
  const { apiKey, baseUrl, profile: resolvedProfile, preferredModel } = getProfileConfig(settings, profile);
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  const cacheKey = `${resolvedProfile}:${apiKey}:${normalizedBaseUrl}:${preferredModel}`;
  const candidateModels = getModelCandidates(settings, profile, resolvedModelCache.get(cacheKey));
  let lastError = null;

  for (const model of candidateModels) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response;
      let payload = {};

      try {
        response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature,
            max_tokens: maxTokens,
            messages,
          }),
        });
        payload = await response.json().catch(() => ({}));
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await wait(800 * (attempt + 1));
          continue;
        }
        throw error;
      }

      if (response.ok) {
        resolvedModelCache.set(cacheKey, model);
        payload.__selectedModel = model;
        return payload;
      }

      const message = getPayloadMessage(payload);
      lastError = new Error(message);

      if (isModelAccessError(response.status, message)) {
        if (resolvedModelCache.get(cacheKey) === model) {
          resolvedModelCache.delete(cacheKey);
        }
        break;
      }

      if (isRetryableStatus(response.status) && attempt < 2) {
        await wait(800 * (attempt + 1));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError || new Error('豆包接口调用失败');
}

function getContentFromCompletion(payload) {
  return payload?.choices?.[0]?.message?.content ?? '';
}

function sanitizeArtifactName(value, fallback = 'unknown') {
  const normalized = String(value ?? '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || fallback;
}

function extractJsonBlock(raw) {
  const fenced = raw.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1];

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return raw.slice(start, end + 1);
  }
  if (start >= 0) {
    return raw.slice(start).trim();
  }

  throw new Error('模型返回内容中没有找到 JSON。');
}

function cleanupJsonCandidate(raw) {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/\u2028|\u2029/g, ' ');
}

function escapeInvalidJsonStringChars(raw) {
  let inString = false;
  let escaped = false;
  let changed = false;
  let output = '';

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const code = raw.charCodeAt(index);

    if (inString) {
      if (escaped) {
        output += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        output += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        output += char;
        inString = false;
        continue;
      }
      if (code <= 0x1f) {
        changed = true;
        if (char === '\n') output += '\\n';
        else if (char === '\r') output += '\\r';
        else if (char === '\t') output += '\\t';
        else if (char === '\b') output += '\\b';
        else if (char === '\f') output += '\\f';
        else output += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      output += char;
      continue;
    }

    if (char === '"') {
      output += char;
      inString = true;
      escaped = false;
      continue;
    }

    output += char;
  }

  return changed ? output : raw;
}

function getJsonErrorPosition(error) {
  const match = String(error?.message || '').match(/position (\d+)/i);
  return match ? Number(match[1]) : null;
}

function findNextNonWhitespace(text, startIndex) {
  for (let index = Math.max(0, startIndex); index < text.length; index += 1) {
    if (!/\s/.test(text[index])) {
      return index;
    }
  }
  return -1;
}

function findPreviousNonWhitespace(text, startIndex) {
  for (let index = Math.min(text.length - 1, startIndex); index >= 0; index -= 1) {
    if (!/\s/.test(text[index])) {
      return index;
    }
  }
  return -1;
}

function isEscapedCharacter(text, index) {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function findPreviousUnescapedQuote(text, startIndex) {
  for (let index = Math.min(text.length - 1, startIndex); index >= 0; index -= 1) {
    if (text[index] === '"' && !isEscapedCharacter(text, index)) {
      return index;
    }
  }
  return -1;
}

function isJsonValueStartCharacter(char) {
  return char === '{'
    || char === '['
    || char === '"'
    || char === '-'
    || char === 't'
    || char === 'f'
    || char === 'n'
    || /[0-9]/.test(char);
}

function tryInsertMissingColon(candidate, error) {
  const message = String(error?.message || '');
  const position = getJsonErrorPosition(error);
  if (!/Expected ':' after property name/i.test(message) || !Number.isInteger(position)) {
    return '';
  }

  const valueStart = findNextNonWhitespace(candidate, position);
  if (valueStart < 0 || !isJsonValueStartCharacter(candidate[valueStart])) {
    return '';
  }

  const propertyEnd = findPreviousUnescapedQuote(candidate, valueStart - 1);
  if (propertyEnd < 0) {
    return '';
  }
  const propertyStart = findPreviousUnescapedQuote(candidate, propertyEnd - 1);
  if (propertyStart < 0) {
    return '';
  }

  const rawPropertyName = candidate.slice(propertyStart + 1, propertyEnd);
  const propertyName = rawPropertyName.trim();
  if (!propertyName || !/^[A-Za-z0-9_-]+$/.test(propertyName)) {
    return '';
  }

  const previousTokenIndex = findPreviousNonWhitespace(candidate, propertyStart - 1);
  if (previousTokenIndex >= 0 && candidate[previousTokenIndex] !== '{' && candidate[previousTokenIndex] !== ',') {
    return '';
  }

  return `${candidate.slice(0, propertyStart)}"${propertyName}": ${candidate.slice(valueStart)}`;
}

function shouldCloseJsonString(raw, quoteIndex) {
  const nextIndex = findNextNonWhitespace(raw, quoteIndex + 1);
  if (nextIndex < 0) {
    return true;
  }

  const nextChar = raw[nextIndex];
  if (nextChar === ':' || nextChar === '}' || nextChar === ']') {
    return true;
  }
  if (nextChar !== ',') {
    return false;
  }

  const afterCommaIndex = findNextNonWhitespace(raw, nextIndex + 1);
  if (afterCommaIndex < 0) {
    return true;
  }

  const afterCommaChar = raw[afterCommaIndex];
  return afterCommaChar === '"'
    || afterCommaChar === '}'
    || afterCommaChar === ']'
    || isJsonValueStartCharacter(afterCommaChar);
}

function escapeLikelyInnerJsonQuotes(raw) {
  let inString = false;
  let escaped = false;
  let changed = false;
  let output = '';

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaped) {
        output += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        output += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        if (shouldCloseJsonString(raw, index)) {
          output += char;
          inString = false;
        } else {
          output += '\\"';
          changed = true;
        }
        continue;
      }
      output += char;
      continue;
    }

    if (char === '"') {
      output += char;
      inString = true;
      escaped = false;
      continue;
    }

    output += char;
  }

  return changed ? output : raw;
}

function tryInsertMissingComma(candidate, error) {
  const message = String(error?.message || '');
  const position = getJsonErrorPosition(error);
  if (!Number.isInteger(position)) {
    return '';
  }

  const insertionIndex = findNextNonWhitespace(candidate, position);
  if (insertionIndex < 0) {
    return '';
  }

  const nextChar = candidate[insertionIndex];
  if (/Expected ',' or '\]' after array element/i.test(message) && isJsonValueStartCharacter(nextChar)) {
    return `${candidate.slice(0, insertionIndex)},${candidate.slice(insertionIndex)}`;
  }

  if (/Expected ',' or '\}' after property value/i.test(message) && nextChar === '"') {
    return `${candidate.slice(0, insertionIndex)},${candidate.slice(insertionIndex)}`;
  }

  return '';
}

function closeUnbalancedJsonStructures(candidate) {
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < candidate.length; index += 1) {
    const char = candidate[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      escaped = false;
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }

    if (char === '}' || char === ']') {
      const expectedOpen = char === '}' ? '{' : '[';
      if (!stack.length || stack[stack.length - 1] !== expectedOpen) {
        return '';
      }
      stack.pop();
    }
  }

  if (!inString && !stack.length) {
    return '';
  }

  const suffix = [];
  if (inString) {
    suffix.push('"');
  }
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    suffix.push(stack[index] === '{' ? '}' : ']');
  }
  return suffix.length ? `${candidate}${suffix.join('')}` : '';
}

function collectJsonErrorHeuristicRepairs(candidate, error) {
  const repairs = [];
  const seen = new Set();

  const enqueue = (value) => {
    if (typeof value !== 'string' || !value.length || value === candidate || seen.has(value)) {
      return;
    }
    seen.add(value);
    repairs.push(value);
  };

  enqueue(escapeInvalidJsonStringChars(candidate));
  enqueue(tryInsertMissingColon(candidate, error));
  enqueue(escapeLikelyInnerJsonQuotes(candidate));
  enqueue(tryInsertMissingComma(candidate, error));
  enqueue(closeUnbalancedJsonStructures(candidate));

  return repairs;
}

function tryParseJsonCandidates(candidates) {
  const queue = [];
  const seen = new Set();
  const attempted = [];
  let lastError = null;

  const enqueue = (value) => {
    if (typeof value !== 'string' || !value.length || seen.has(value)) {
      return;
    }
    seen.add(value);
    queue.push(value);
  };

  (Array.isArray(candidates) ? candidates : []).forEach(enqueue);

  while (queue.length && attempted.length < 24) {
    const candidate = queue.shift();
    attempted.push(candidate);

    try {
      return {
        parsed: JSON.parse(candidate),
        attempted,
        lastError: null,
      };
    } catch (error) {
      lastError = error;
      collectJsonErrorHeuristicRepairs(candidate, error).forEach(enqueue);
    }
  }

  return {
    parsed: null,
    attempted,
    lastError,
  };
}

function tryExtractJsonBlock(raw) {
  try {
    return extractJsonBlock(raw);
  } catch {
    return '';
  }
}

function saveModelJsonDebugArtifact({
  debugContext,
  raw,
  extracted,
  firstPassAttempts,
  repairedRaw,
  secondPassAttempts,
  schemaHint,
  lastError,
}) {
  try {
    const flowDir = sanitizeArtifactName(debugContext?.flow, 'model-json');
    const taskDir = sanitizeArtifactName(debugContext?.taskId || debugContext?.taskName, 'unknown-task');
    const artifactDir = path.join(generatedModelDebugDir, flowDir, taskDir);
    fs.mkdirSync(artifactDir, { recursive: true });

    const questionSuffix = Array.isArray(debugContext?.questionNos) && debugContext.questionNos.length
      ? `q-${debugContext.questionNos.map((item) => sanitizeArtifactName(item, 'unknown')).join('-')}`
      : 'q-unknown';
    const studentSuffix = sanitizeArtifactName(debugContext?.studentName, 'unknown-student');
    const passSuffix = sanitizeArtifactName(debugContext?.passLabel, 'default-pass');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${stamp}__${studentSuffix}__${questionSuffix}__${passSuffix}.json`;
    const artifactPath = path.join(artifactDir, fileName);

    fs.writeFileSync(
      artifactPath,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        debugContext: debugContext || null,
        lastErrorMessage: lastError?.message || '',
        schemaHint: schemaHint || '',
        raw: String(raw || ''),
        extracted: String(extracted || ''),
        firstPassAttempts: Array.isArray(firstPassAttempts) ? firstPassAttempts : [],
        repairedRaw: String(repairedRaw || ''),
        repairedExtracted: tryExtractJsonBlock(repairedRaw),
        secondPassAttempts: Array.isArray(secondPassAttempts) ? secondPassAttempts : [],
      }, null, 2),
      'utf8',
    );

    return artifactPath;
  } catch {
    return '';
  }
}

async function repairJsonWithModel({ settings, profile, raw, schemaHint }) {
  const payload = await chatCompletion({
    settings,
    profile,
    temperature: 0,
    maxTokens: 1800,
    messages: [
      {
        role: 'system',
        content: '你是 JSON 修复助手。你的任务是把一段损坏的 JSON 修复成严格合法的 JSON。只输出 JSON 本体，不要输出解释。',
      },
      {
        role: 'user',
        content: `请把下面这段本应是 JSON 的文本修复成严格 JSON，不改变原意。${schemaHint ? `\n目标结构提示：${schemaHint}` : ''}\n\n${raw.slice(0, 24000)}`,
      },
    ],
  });

  return getContentFromCompletion(payload);
}

async function parseModelJson({ settings, profile, raw, schemaHint, debugContext = null }) {
  let extracted = '';

  try {
    extracted = extractJsonBlock(raw);
  } catch (error) {
    const artifactPath = saveModelJsonDebugArtifact({
      debugContext,
      raw,
      extracted: '',
      firstPassAttempts: [],
      repairedRaw: '',
      secondPassAttempts: [],
      schemaHint,
      lastError: error,
    });
    if (artifactPath) {
      console.warn(`[model-json] invalid response saved: ${artifactPath}`);
    }
    const wrappedError = new Error(`豆包返回的 JSON 解析失败：${error?.message || '模型返回内容中没有找到 JSON。'}`);
    wrappedError.debugArtifactPath = artifactPath;
    throw wrappedError;
  }

  const firstPass = tryParseJsonCandidates([
    extracted,
    cleanupJsonCandidate(extracted),
    escapeInvalidJsonStringChars(cleanupJsonCandidate(extracted)),
  ]);
  if (firstPass.parsed) {
    return firstPass.parsed;
  }

  let repairedRaw = '';
  let secondPass = { parsed: null, attempted: [], lastError: null };

  try {
    repairedRaw = await repairJsonWithModel({ settings, profile, raw: extracted, schemaHint });
    const repairedExtracted = extractJsonBlock(repairedRaw);
    secondPass = tryParseJsonCandidates([
      repairedExtracted,
      cleanupJsonCandidate(repairedExtracted),
      escapeInvalidJsonStringChars(cleanupJsonCandidate(repairedExtracted)),
    ]);
    if (secondPass.parsed) {
      return secondPass.parsed;
    }
  } catch (error) {
    secondPass = {
      parsed: null,
      attempted: secondPass.attempted || [],
      lastError: error,
    };
  }

  const lastError = secondPass.lastError || firstPass.lastError || new Error('未知错误');
  const artifactPath = saveModelJsonDebugArtifact({
    debugContext,
    raw,
    extracted,
    firstPassAttempts: firstPass.attempted,
    repairedRaw,
    secondPassAttempts: secondPass.attempted,
    schemaHint,
    lastError,
  });
  if (artifactPath) {
    console.warn(`[model-json] invalid response saved: ${artifactPath}`);
  }
  const wrappedError = new Error(`豆包返回的 JSON 解析失败，自动修复后仍无效：${lastError?.message || '未知错误'}`);
  wrappedError.debugArtifactPath = artifactPath;
  throw wrappedError;
}

function getChoiceExplanationSchema() {
  return `{
  "questions": [
    {
      "questionNo": "2",
      "title": "唐太宗的治国思想",
      "correctAnswer": "A",
      "promptStem": "题干的核心主题或一句简短概括",
      "thinkingSteps": [
        { "label": "第一步：抓关键词", "content": "..." },
        { "label": "第二步：调用知识", "content": "..." },
        { "label": "第三步：建立逻辑链并得出答案", "content": "..." }
      ],
      "wrongOptionAnalyses": [
        { "option": "B", "reasonType": "无中生有", "analysis": "..." },
        { "option": "C", "reasonType": "表意偏差", "analysis": "..." },
        { "option": "D", "reasonType": "偷换概念", "analysis": "..." }
      ],
      "summary": "一句收束性的教师讲评总结"
    }
  ],
  "warnings": []
}`;
}

function buildChoiceExplanationQuestionPrompt(questionSummaries, standardAnswerMap) {
  return questionSummaries.map((item) => {
    const standardAnswer = String(standardAnswerMap.get(item.questionNo) || item.standardAnswer || '')
      .toUpperCase()
      .replace(/[^A-D]/g, '')
      .slice(0, 1);
    return [
      `题号：${item.questionNo}`,
      `标准答案：${standardAnswer || '未提供'}`,
      `正确率：${item.correctRate == null ? '暂无' : `${Math.round(item.correctRate * 100)}%`}`,
      `答对人数：${Number(item.correctCount || 0)}`,
      `答错人数：${Number(item.wrongCount || 0)}`,
      `空白人数：${Number(item.blankCount || 0)}`,
      `高频误选：${Array.isArray(item.optionStats)
        ? item.optionStats
          .filter((option) => ['A', 'B', 'C', 'D'].includes(String(option.option || '')) && String(option.option || '') !== standardAnswer && Number(option.count || 0) > 0)
          .sort((left, right) => Number(right.count || 0) - Number(left.count || 0))
          .slice(0, 2)
          .map((option) => `${option.option}(${option.count}人)`)
          .join('、') || '暂无'
        : '暂无'}`,
    ].join('\n');
  }).join('\n\n');
}

async function generateChoiceQuestionExplanations({
  settings,
  profile,
  task,
  questionUploadRecords,
  selectedQuestionNos,
  questionSummaries,
}) {
  const normalizedQuestionNos = Array.from(
    new Set(
      (Array.isArray(selectedQuestionNos) ? selectedQuestionNos : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => String(left).localeCompare(String(right), 'zh-CN', { numeric: true, sensitivity: 'base' }));

  if (!normalizedQuestionNos.length) {
    throw new Error('请选择至少一道需要解析的选择题。');
  }
  if (!Array.isArray(questionUploadRecords) || !questionUploadRecords.length) {
    throw new Error('步骤二未找到题目文件，请先上传题目 PDF。');
  }

  const enabledChoiceQuestions = (task?.questions || [])
    .filter((item) => item.type === 'choice' && item.enabled !== false)
    .map((item) => ({
      questionNo: String(item.questionNo || '').trim(),
      standardAnswer: String(item.standardAnswer || '').trim(),
    }))
    .filter((item) => item.questionNo);
  const standardAnswerMap = new Map(enabledChoiceQuestions.map((item) => [item.questionNo, item.standardAnswer]));
  const summaryMap = new Map((Array.isArray(questionSummaries) ? questionSummaries : []).map((item) => [String(item.questionNo || '').trim(), item]));
  const selectedSummaries = normalizedQuestionNos.map((questionNo) => summaryMap.get(questionNo)).filter(Boolean);

  if (!selectedSummaries.length) {
    throw new Error('当前没有可用于解析的选择题统计结果，请先完成步骤四批阅。');
  }

  const imageParts = [];
  for (const upload of questionUploadRecords) {
    const ext = path.extname(String(upload?.originalName || '')).toLowerCase();
    const mimeType = String(upload?.mimeType || '').trim().toLowerCase();
    if (mimeType === 'application/pdf' || ext === '.pdf') {
      const pageUrls = await renderPdfPagesAsDataUrls(upload.storedPath);
      pageUrls.forEach((url, index) => {
        imageParts.push({
          type: 'image_url',
          image_url: { url },
        });
        imageParts.push({
          type: 'text',
          text: `上方是题目文件《${upload.originalName}》第 ${index + 1} 页。`,
        });
      });
    } else if (mimeType.startsWith('image/')) {
      imageParts.push({
        type: 'image_url',
        image_url: { url: fileToDataUrl(upload.storedPath, upload.mimeType || 'image/jpeg') },
      });
      imageParts.push({
        type: 'text',
        text: `上方是题目图片《${upload.originalName}》。`,
      });
    }
  }

  const userParts = [
    {
      type: 'text',
      text: [
        `当前任务：${task?.name || '未命名任务'}`,
        `题目范围：${task?.questionScope || '未填写'}`,
        `需要解析的题号：${normalizedQuestionNos.join('、')}`,
        '',
        '请直接阅读后续提供的原始题目 PDF 页面图像，自己定位这些题目，尤其要保留历史试卷中的地图、图片、表格、时间轴和排版关系，不要只凭统计信息猜题。',
        '输出要求：',
        '1. 只输出 JSON，不要输出 markdown 或额外说明。',
        '2. 每一道题都必须写成老师讲题口吻，像课堂讲解，而不是简单答案说明。',
        '3. thinkingSteps 必须固定写三步：第一步抓关键词，第二步调用知识，第三步建立逻辑链并得出答案。',
        '4. wrongOptionAnalyses 必须尽量覆盖每个错误选项，不能只讲一两个。',
        '5. reasonType 请尽量使用以下错因类型之一：无中生有、偷换概念、表意偏差、材料无依据、以偏概全、张冠李戴。',
        '6. 如果某题在原始题目中定位不稳定，请不要编造，在 warnings 中说明题号与原因。',
        '',
        '下面是这些题的标准答案和班级统计：',
        buildChoiceExplanationQuestionPrompt(selectedSummaries, standardAnswerMap),
        '',
        `JSON 模板如下：\n${getChoiceExplanationSchema()}`,
      ].join('\n'),
    },
    ...imageParts,
  ];

  const payload = await chatCompletion({
    settings,
    profile,
    temperature: 0.2,
    maxTokens: 5200,
    messages: [
      {
        role: 'system',
        content: '你是一位经验丰富的高中历史老师。你的任务是根据原始试卷页面、标准答案和班级作答统计，为指定选择题生成详细课堂解析。你必须保持严谨，不能捏造看不到的题面信息；若定位不稳定，要明确写入 warnings。只输出 JSON。',
      },
      {
        role: 'user',
        content: userParts,
      },
    ],
  });
  const raw = getContentFromCompletion(payload);
  const parsed = await parseModelJson({
    settings,
    profile,
    raw,
    schemaHint: getChoiceExplanationSchema(),
    debugContext: {
      feature: 'choice-explanation',
      taskId: task?.id || '',
      studentName: 'classwide',
      questionNo: normalizedQuestionNos.join('-'),
      passLabel: 'single-pass',
    },
  });

  return {
    questions: Array.isArray(parsed?.questions) ? parsed.questions : [],
    warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.map((item) => String(item ?? '').trim()).filter(Boolean) : [],
    selectedModel: payload.__selectedModel || getProfileConfig(settings, profile).preferredModel,
  };
}

function getModeSchema(mode) {
  if (mode === 'choice') {
    return `{
  "questions": [
    {
      "questionNo": "1",
      "type": "choice",
      "score": 2,
      "standardAnswer": "A"
    }
  ],
  "warnings": []
}`;
  }

  if (mode === 'subjective') {
    return `{
  "questions": [
    {
      "questionNo": "26",
      "type": "subjective",
      "score": 12,
      "content": "原题目",
      "standardAnswer": "参考答案",
      "gradingRule": "阅卷要求"
    }
  ],
  "warnings": []
}`;
  }

  return `{
  "questions": [
    {
      "questionNo": "1",
      "type": "choice",
      "score": 2,
      "standardAnswer": "A"
    },
    {
      "questionNo": "26",
      "type": "subjective",
      "score": 12,
      "content": "原题目",
      "standardAnswer": "参考答案",
      "gradingRule": "阅卷要求"
    }
  ],
  "warnings": []
}`;
}

function getSortedQuestionNos(questions) {
  return Array.from(new Set((questions || []).map((item) => String(item?.questionNo ?? '').trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, 'zh-CN', { numeric: true }),
  );
}

function getTaskQuestionBuckets(task) {
  const questions = Array.isArray(task?.questions) ? task.questions : [];
  return {
    choiceQuestionNos: getSortedQuestionNos(questions.filter((item) => item.type === 'choice')),
    subjectiveQuestionNos: getSortedQuestionNos(questions.filter((item) => item.type !== 'choice')),
  };
}

function getAnswerSheetSchema(mode) {
  if (mode === 'choice') {
    return `{
  "studentName": "student full name",
  "observedNames": ["raw name 1", "raw name 2"],
  "choiceAnswers": [
    {
      "questionNo": "1",
      "answer": "A"
    }
  ],
  "warnings": []
}`;
  }

  if (mode === 'subjective') {
    return `{
  "studentName": "student full name",
  "observedNames": ["raw name 1", "raw name 2"],
  "subjectiveAnswers": [
    {
      "questionNo": "51",
      "content": "学生作答原文"
    }
  ],
  "warnings": []
}`;
  }

  return `{
  "studentName": "student full name",
  "observedNames": ["raw name 1", "raw name 2"],
  "choiceAnswers": [
    {
      "questionNo": "1",
      "answer": "A"
    }
  ],
  "subjectiveAnswers": [
    {
      "questionNo": "51",
      "content": "学生作答原文"
    }
  ],
  "warnings": []
}`;
}

function buildAnswerSheetPrompt({ task, classroomStudents = [], sheetName }) {
  {
    const { choiceQuestionNos, subjectiveQuestionNos } = getTaskQuestionBuckets(task);
    const modeLabel =
      task.mode === 'choice' ? '选择题模式' : task.mode === 'subjective' ? '主观题模式' : '综合模式（含选择题和主观题）';
    const rosterText = classroomStudents.length
      ? `班级名单候选：${classroomStudents.join('、')}\n如果姓名书写不清，只能从候选名单中选择你有把握的名字；如果仍然不能确定，请留空并写入 warnings。`
      : '未提供班级名单候选；如果姓名看不清，请留空并写入 warnings。';

    return [
      '你将收到 1 张学生答题卡图片，请只做 OCR 识别，不要评分，不要解释，不要补写学生没有写出的内容。',
      `当前任务模式：${modeLabel}。`,
      `当前页面：${sheetName}。`,
      '优先识别学生姓名。页面上如果出现多个“姓名”栏位，请以最清晰、最一致的姓名为准；如果提供了班级名单，请优先在名单中匹配最可能的姓名。',
      rosterText,
      '如果姓名疑似不在名单中、或只能勉强猜到，请保持 studentName 为空，不要为了凑名单强行填一个名字。',
      'observedNames 要尽量保留你看到的原始手写姓名候选；即使最终无法归属，也要填写 observedNames。',
      '只有当你能稳定确认就是某个名单学生时，studentName 才填写最终姓名；否则把最终判断留空。',
      '姓名识别补充规则：',
      '1. 请重点查看每个“姓名：”印刷体后面的手写姓名，按从上到下顺序把最多 3 个原始识别结果写入 observedNames。',
      '2. studentName 只保留一个最终姓名；如果你无法稳定确定最终姓名，studentName 留空，但 observedNames 仍要尽量填写。',
      task.mode !== 'subjective'
        ? choiceQuestionNos.length
          ? `选择题题号提示：${choiceQuestionNos.join('、')}。只输出当前这一页上真正出现的选择题题号，不要把没有出现在本页的题号补成空项。如果本页上某题出现了但学生没作答或看不清，answer 置为 ""。`
          : '只输出当前这一页上真正出现的选择题题号；没有出现在本页的题号不要补空。'
        : '本页不需要输出 choiceAnswers。',
      task.mode !== 'choice'
        ? subjectiveQuestionNos.length
          ? `主观题题号提示：${subjectiveQuestionNos.join('、')}。只输出当前这一页上真正出现的主观题题号，不要把没有出现在本页的题号补成空项。如果本页上某题出现了但学生没作答或看不清，content 置为 ""。`
          : '只输出当前这一页上真正出现的主观题题号；没有出现在本页的题号不要补空。'
        : '本页不需要输出 subjectiveAnswers。',
      '选择题识别规则：',
      '1. 只识别学生手写的黑色或蓝色字迹，不要考虑任何红色字迹。',
      '2. 题号正下方的格子，就是该题的学生答案区域。',
      '3. 每道题最终只能输出一个答案字母 A/B/C/D，不能输出两个选项。',
      '4. 同一格内如果出现多个字母痕迹，要判断哪个是最终有效答案；无法确定时置空并写入 warnings。',
      '5. 带有明显划除、涂黑、打叉、重叠修改痕迹的字母，不要直接当作最终答案。',
      '主观题识别规则：',
      '1. 只识别学生手写文字，不识别题干、印刷说明或教师批注。',
      '2. 必须忠实保留学生原文，不增删、不润色、不改写。',
      '3. 如果某题区域出现了题号，但没有可辨认的学生作答内容，content 置为 ""。',
      '输出规则：',
      '1. 只能输出 JSON，不要输出 markdown、解释或额外文本。',
      '2. studentName 必须是字符串。',
      '3. choiceAnswers 中 answer 只能是 ""、"A"、"B"、"C"、"D" 之一。',
      '4. subjectiveAnswers 中 content 要尽量忠实保留学生原文，允许换行。',
      '5. warnings 用于记录姓名不确定、局部模糊、题号缺失、答案无法判断等问题。',
      '6. 只输出当前页面实际出现的题号；没出现在当前页面的题号不要输出，也不要补空。',
      `JSON 模板如下：\n${getAnswerSheetSchema(task.mode)}`,
    ].join('\n');
  }
  const { choiceQuestionNos, subjectiveQuestionNos } = getTaskQuestionBuckets(task);
  const modeLabel =
    task.mode === 'choice' ? '选择题模式' : task.mode === 'subjective' ? '主观题模式' : '综合模式（含选择题和主观题）';
  const rosterText = classroomStudents.length
    ? `班级名单候选：${classroomStudents.join('、')}\n若姓名书写不清，只能从候选名单中选择你有把握的名字；如果仍然不确定，请留空并写入 warnings。`
    : '未提供班级名单候选；如果姓名看不清，请留空并写入 warnings。';

  return [
    `你将收到 1 张学生答题卡图片，请只做 OCR 识别，不要评分，不要解释，不要补写学生没有写出的内容。`,
    `当前任务模式：${modeLabel}。`,
    `当前页面：${sheetName}。`,
    `优先识别学生姓名。页面上如果出现多个“姓名”栏位，请以最清晰、最一致的姓名为准。若提供了班级名单，请优先在名单中匹配最可能的姓名。`,
    rosterText,
    task.mode !== 'subjective'
      ? choiceQuestionNos.length
        ? `选择题题号（请按此顺序逐题输出）：${choiceQuestionNos.join('、')}。如果某题空白或看不清，answer 置为空字符串。`
        : '选择题题号未预先配置，请按页面可见题号输出 choiceAnswers。'
      : '本页不需要输出 choiceAnswers。',
    task.mode !== 'choice'
      ? subjectiveQuestionNos.length
        ? `主观题题号（请按此顺序逐题输出）：${subjectiveQuestionNos.join('、')}。如果某题没有作答或看不清，content 置为空字符串。`
        : '主观题题号未预先配置，请按页面可见题号输出 subjectiveAnswers。'
      : '本页不需要输出 subjectiveAnswers。',
    '选择题识别规则：',
    '1. 只识别学生手写的黑色或蓝色字迹，不要考虑任何红色字迹。',
    '2. 题号正下方的格子，就是该题的学生答案区域。',
    '3. 每道题最终只能输出一个答案字母 A/B/C/D，绝不能输出两个选项。',
    '4. 当同一格内出现两个或多个字母痕迹时，必须做二次特征对比，不可只认最显眼的字母。',
    '5. 凡是带有横线划除、大面积涂黑、画圈打叉、笔画严重重叠等修改痕迹的字母，都视为作废选项，必须忽略。',
    '6. 请在作废字母旁边寻找笔画清晰、完整、未被任何线条破坏的单一字母，把它作为唯一最终答案。',
    '7. 如果仍无法确定唯一最终答案，请输出空字符串，并在 warnings 中说明题号。',
    '主观题识别规则：',
    '1. 只识别学生手写文字，不识别任何打印文字、题干、题号说明或教师批注。',
    '2. 手写文字必须百分百忠实原文，不添加、不删减、不改写、不润色。',
    '3. 如果某题区域没有可辨认的学生手写内容，content 置为空字符串。',
    '输出规则：',
    '1. 只能输出 JSON，不要输出 markdown、说明或额外文本。',
    '2. studentName 必须是字符串。',
    '3. choiceAnswers 中 answer 只能是 ""、"A"、"B"、"C"、"D" 之一。',
    '4. subjectiveAnswers 中 content 要尽量忠实保留学生原文，允许换行，不要整理成标准答案。',
    '5. warnings 用于记录姓名不确定、局部模糊、题号缺失、答案无法判断等问题。',
    `JSON 模板如下：\n${getAnswerSheetSchema(task.mode)}`,
  ].join('\n');
}

function buildSourceParts({ mode, sourceKind, sources, scope }) {
  let sourceInstruction = '';
  if (mode === 'choice') {
    sourceInstruction = '当前任务是选择题批阅。只提取每道选择题的题号、分值和标准答案。standardAnswer 只能是 A、B、C、D 中的一个，不要返回题干。';
  } else if (mode === 'subjective' && sourceKind === 'question') {
    sourceInstruction = '当前任务是主观题批阅，而且这批材料是原题目。只提取非选择题，必须忽略所有 A/B/C/D 形式的选择题。返回题号、分值、原题目；如果是论述题，type 设为 essay，否则设为 subjective。standardAnswer 和 gradingRule 可以留空。';
  } else if (mode === 'subjective' && sourceKind === 'answer') {
    sourceInstruction = '当前任务是主观题批阅，而且这批材料是参考答案。只提取非选择题对应的题号、分值、参考答案和阅卷要求，必须忽略所有选择题答案。standardAnswer 必须填写参考答案正文，gradingRule 请填写得分点、扣分点或简短阅卷要求。';
  } else if (mode === 'mixed' && sourceKind === 'question') {
    sourceInstruction = '当前任务是综合批阅，这批材料是原题目。选择题只保留题号、分值和 type=choice，不要猜标准答案。主观题保留题号、分值、原题目，并标记为 subjective 或 essay。';
  } else {
    sourceInstruction = '当前任务是综合批阅，这批材料是参考答案。选择题请提取题号、分值、标准答案；主观题请提取题号、分值、参考答案和阅卷要求。';
  }

  const content = [
    {
      type: 'text',
      text: `题目范围提示：${scope || '未填写题目范围'}。\n${sourceInstruction}\n\n请严格输出 JSON，不要添加任何解释、markdown 或额外文本。JSON 模板如下：\n${getModeSchema(mode)}`,
    },
  ];

  for (const source of sources) {
    if (source.kind === 'text') {
      content.push({
        type: 'text',
        text: `文件名：${source.name}\n内容：\n${source.content.slice(0, 18000)}`,
      });
    } else {
      content.push({ type: 'text', text: `文件名：${source.name}` });
      content.push({ type: 'image_url', image_url: { url: source.content } });
    }
  }

  return content;
}

function normalizeChoiceAnswer(answer) {
  return String(answer ?? '')
    .toUpperCase()
    .replace(/[^A-D]/g, '')
    .slice(0, 1);
}

function normalizeChoiceMark(answer) {
  const letters = Array.from(new Set(String(answer ?? '').toUpperCase().match(/[A-D]/g) || [])).sort();
  return letters.length === 1 ? letters[0] : '';
}

function normalizeRecognizedChoiceAnswers(choiceAnswers, expectedQuestionNos) {
  {
    const normalizedExpected = getSortedQuestionNos((expectedQuestionNos || []).map((questionNo) => ({ questionNo })));
    const expectedSet = new Set(normalizedExpected);
    const answerMap = new Map();
    const warnings = [];

    (choiceAnswers || []).forEach((item, index) => {
      const questionNo = String(item?.questionNo ?? index + 1).trim();
      if (!questionNo) return;
      const rawAnswer = String(item?.answer ?? '').toUpperCase();
      const normalizedAnswer = normalizeChoiceMark(rawAnswer);

      if (!normalizedAnswer && /[A-D].*[A-D]/.test(rawAnswer.replace(/[^A-D]/g, ''))) {
        warnings.push(`第 ${questionNo} 题返回了多个候选字母，已自动置空，建议人工复核。`);
      }

      if (expectedSet.size > 0 && !expectedSet.has(questionNo)) {
        warnings.push(`第 ${questionNo} 题不在当前题目配置中，系统已保留该结果，请核对第 2 步题号配置。`);
      }

      answerMap.set(questionNo, {
        questionNo,
        answer: normalizedAnswer,
      });
    });

    return {
      answers: Array.from(answerMap.values())
        .filter((item) => item.questionNo)
        .sort((a, b) => a.questionNo.localeCompare(b.questionNo, 'zh-CN', { numeric: true })),
      warnings,
    };
  }
  const normalizedExpected = getSortedQuestionNos((expectedQuestionNos || []).map((questionNo) => ({ questionNo })));
  const answerMap = new Map();
  const warnings = [];

  normalizedExpected.forEach((questionNo) => {
    answerMap.set(questionNo, { questionNo, answer: '' });
  });

  (choiceAnswers || []).forEach((item, index) => {
    const questionNo = String(item?.questionNo ?? index + 1).trim();
    if (!questionNo) return;
    const rawAnswer = String(item?.answer ?? '').toUpperCase();
    const normalizedAnswer = normalizeChoiceMark(rawAnswer);

    if (!normalizedAnswer && /[A-D].*[A-D]/.test(rawAnswer.replace(/[^A-D]/g, ''))) {
      warnings.push(`第 ${questionNo} 题返回了多个候选字母，已自动置空，建议人工复核。`);
    }

    answerMap.set(questionNo, {
      questionNo,
      answer: normalizedAnswer,
    });
  });

  return {
    answers: Array.from(answerMap.values())
      .filter((item) => item.questionNo)
      .sort((a, b) => a.questionNo.localeCompare(b.questionNo, 'zh-CN', { numeric: true })),
    warnings,
  };
}

function normalizeRecognizedSubjectiveAnswers(subjectiveAnswers, expectedQuestionNos) {
  {
    const normalizedExpected = getSortedQuestionNos((expectedQuestionNos || []).map((questionNo) => ({ questionNo })));
    const expectedSet = new Set(normalizedExpected);
    const answerMap = new Map();

    (subjectiveAnswers || []).forEach((item, index) => {
      const questionNo = String(item?.questionNo ?? index + 1).trim();
      if (!questionNo) return;
      if (expectedSet.size > 0 && !expectedSet.has(questionNo)) {
        answerMap.set(questionNo, {
          questionNo,
          content: String(item?.content ?? '').trim(),
        });
        return;
      }

      answerMap.set(questionNo, {
        questionNo,
        content: String(item?.content ?? '').trim(),
      });
    });

    return Array.from(answerMap.values())
      .filter((item) => item.questionNo)
      .sort((a, b) => a.questionNo.localeCompare(b.questionNo, 'zh-CN', { numeric: true }));
  }
  const normalizedExpected = getSortedQuestionNos((expectedQuestionNos || []).map((questionNo) => ({ questionNo })));
  const answerMap = new Map();

  normalizedExpected.forEach((questionNo) => {
    answerMap.set(questionNo, { questionNo, content: '' });
  });

  (subjectiveAnswers || []).forEach((item, index) => {
    const questionNo = String(item?.questionNo ?? index + 1).trim();
    if (!questionNo) return;

    answerMap.set(questionNo, {
      questionNo,
      content: String(item?.content ?? '').trim(),
    });
  });

  return Array.from(answerMap.values())
    .filter((item) => item.questionNo)
    .sort((a, b) => a.questionNo.localeCompare(b.questionNo, 'zh-CN', { numeric: true }));
}

function isChoiceLikeRawItem(item) {
  const rawType = String(item?.type || '').toLowerCase();
  const answer = String(item?.standardAnswer ?? '').trim().toUpperCase();
  const content = String(item?.content ?? '').trim();

  if (rawType === 'choice') return true;
  if (/^[A-D]$/.test(answer) && !content) return true;
  if (/^[A-D](\s*[,，/]\s*[A-D])+$/.test(answer)) return true;
  if (/A[\.\s、．\)]|B[\.\s、．\)]|C[\.\s、．\)]|D[\.\s、．\)]/.test(content)) return true;
  if (/单项选择|多项选择|选择题/.test(content)) return true;
  return false;
}

function inferQuestionType(item, mode) {
  const rawType = String(item?.type || '').toLowerCase();
  const content = String(item?.content ?? '').trim();

  if (mode === 'choice') return 'choice';
  if (mode === 'subjective') {
    if (rawType === 'essay' || /论述|评述|结合材料/.test(content)) return 'essay';
    return 'subjective';
  }

  if (rawType === 'choice' || isChoiceLikeRawItem(item)) return 'choice';
  if (rawType === 'essay' || /论述|评述|结合材料/.test(content)) return 'essay';
  return 'subjective';
}

function normalizeQuestion(item, mode) {
  const type = inferQuestionType(item, mode);
  return {
    id: crypto.randomUUID(),
    questionNo: String(item?.questionNo ?? '').trim(),
    type,
    score: Number(item?.score ?? (type === 'choice' ? 2 : 0)),
    content: type === 'choice' ? '' : String(item?.content ?? '').trim(),
    standardAnswer: type === 'choice' ? normalizeChoiceAnswer(item?.standardAnswer) : String(item?.standardAnswer ?? '').trim(),
    analysis: String(item?.analysis ?? '').trim(),
    gradingRule: type === 'choice' ? '' : String(item?.gradingRule ?? '').trim(),
    gradingRuleTree: item?.gradingRuleTree ?? null,
    essayRuleTree: type === 'essay' ? normalizeEssayRuleTree(item?.essayRuleTree, item) : null,
    tags: Array.isArray(item?.tags) ? item.tags.filter(Boolean).map(String) : [],
    enabled: true,
    source: 'ai',
  };
}

function mergeQuestionSets(mode, questionJson, answerJson) {
  const merged = new Map();
  const questionItems = (questionJson.questions || []).map((item) => normalizeQuestion(item, mode));
  const answerItems = (answerJson.questions || []).map((item) => normalizeQuestion(item, mode));

  for (const item of [...questionItems, ...answerItems]) {
    const key = item.questionNo || crypto.randomUUID();
    const existing = merged.get(key) ?? {
      id: crypto.randomUUID(),
      questionNo: key,
      type: mode === 'choice' ? 'choice' : 'subjective',
      score: mode === 'choice' ? 2 : 0,
      content: '',
      standardAnswer: '',
      analysis: '',
      gradingRule: '',
      gradingRuleTree: null,
      essayRuleTree: null,
      tags: [],
      enabled: true,
      source: 'ai',
    };

    merged.set(key, {
      ...existing,
      type: item.type || existing.type,
      score: Number(item.score || existing.score || 0),
      content: item.content || existing.content,
      standardAnswer: item.standardAnswer || existing.standardAnswer,
      analysis: item.analysis || existing.analysis,
      gradingRule: item.gradingRule || existing.gradingRule,
      gradingRuleTree: item.gradingRuleTree || existing.gradingRuleTree || null,
      essayRuleTree: item.essayRuleTree || existing.essayRuleTree || null,
      tags: Array.from(new Set([...(existing.tags || []), ...(item.tags || [])])),
      enabled: true,
      source: 'ai',
    });
  }

  return Array.from(merged.values()).filter((item) => item.questionNo);
}

function postProcessQuestions(mode, questions) {
  const normalized = questions
    .filter((item) => item.questionNo)
    .map((item) => ({
      ...item,
      score: Number.isFinite(item.score) && item.score > 0 ? item.score : item.type === 'choice' ? 2 : 10,
    }))
    .map((item) => applyAutoSplitGradingRule(item));

  if (mode === 'choice') {
    return normalized
      .filter((item) => item.type === 'choice' && item.standardAnswer)
      .sort((a, b) => a.questionNo.localeCompare(b.questionNo, 'zh-CN', { numeric: true }));
  }

  if (mode === 'subjective') {
    return normalized
      .filter((item) => item.type !== 'choice')
      .filter((item) => item.content || item.standardAnswer || item.gradingRule)
      .filter((item) => !isChoiceLikeRawItem(item))
      .sort((a, b) => a.questionNo.localeCompare(b.questionNo, 'zh-CN', { numeric: true }));
  }

  return normalized
    .filter((item) => (item.type === 'choice' ? item.standardAnswer : item.content || item.standardAnswer || item.gradingRule))
    .sort((a, b) => a.questionNo.localeCompare(b.questionNo, 'zh-CN', { numeric: true }));
}

async function testConnection(settings, profile) {
  const config = resolveConnectionConfig(settings, profile);
  const payload = await requestOpenAICompatibleCompletion({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    maxTokens: 120,
    messages: [
      { role: 'system', content: '你是接口连通性测试助手。' },
      { role: 'user', content: `请只用一句中文回复：${config.label}连接成功。` },
    ],
  });

  return {
    ok: true,
    message: `${config.label}连接成功（模型：${payload.__selectedModel || config.model}）`,
    preview: getContentFromCompletion(payload),
  };
}

async function extractMaterialDrafts({ settings, profile, questionSources, answerSources, scope, mode }) {
  if (!questionSources.length && !answerSources.length) {
    throw new Error('请先上传题目或参考答案文件。');
  }

  const systemPrompt = '你是高中历史命题整理助手。请把材料整理成结构化 JSON，禁止输出 JSON 之外的任何解释。';
  const schemaHint = getModeSchema(mode);

  if (mode === 'choice') {
    const primarySources = answerSources.length ? answerSources : questionSources;
    const payload = await chatCompletion({
      settings,
      profile,
      maxTokens: 3200,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildSourceParts({ mode, sourceKind: 'answer', sources: primarySources, scope }) },
      ],
    });

    const parsed = await parseModelJson({
      settings,
      profile,
      raw: getContentFromCompletion(payload),
      schemaHint,
    });

    const questions = await Promise.all(
      postProcessQuestions(mode, mergeQuestionSets(mode, parsed, { questions: [], warnings: [] }))
        .map((question) => hydrateEssayRuleTreeDefaults({ settings, question })),
    );

    return {
      provider: 'doubao',
      questions,
      warnings: parsed.warnings || [],
    };
  }

  const [questionPayload, answerPayload] = await Promise.all([
    questionSources.length
      ? chatCompletion({
          settings,
          profile,
          maxTokens: 4200,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: buildSourceParts({ mode, sourceKind: 'question', sources: questionSources, scope }) },
          ],
        })
      : Promise.resolve(null),
    answerSources.length
      ? chatCompletion({
          settings,
          profile,
          maxTokens: 4200,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: buildSourceParts({ mode, sourceKind: 'answer', sources: answerSources, scope }) },
          ],
        })
      : Promise.resolve(null),
  ]);

  const [questionJson, answerJson] = await Promise.all([
    questionPayload
      ? parseModelJson({
          settings,
          profile,
          raw: getContentFromCompletion(questionPayload),
          schemaHint,
        })
      : Promise.resolve({ questions: [], warnings: [] }),
    answerPayload
      ? parseModelJson({
          settings,
          profile,
          raw: getContentFromCompletion(answerPayload),
          schemaHint,
        })
      : Promise.resolve({ questions: [], warnings: [] }),
  ]);

  const questions = await Promise.all(
    postProcessQuestions(mode, mergeQuestionSets(mode, questionJson, answerJson))
      .map((question) => hydrateEssayRuleTreeDefaults({ settings, question })),
  );

  return {
    provider: 'doubao',
    questions,
    warnings: [...(questionJson.warnings || []), ...(answerJson.warnings || [])],
  };
}

function getAnswerSheetRecognitionMaxTokens(task) {
  const { choiceQuestionNos, subjectiveQuestionNos } = getTaskQuestionBuckets(task);
  const promptQuestionCount = choiceQuestionNos.length + subjectiveQuestionNos.length;
  return Math.min(3200, Math.max(1400, 900 + promptQuestionCount * 180));
}

const NAME_OBSERVATION_LIMIT = 3;
const NAME_AUTO_ASSIGN_THRESHOLD = 0.9;
const NAME_AUTO_ASSIGN_GAP = 0.05;
const NAME_SUGGEST_THRESHOLD = 0.62;

function normalizeRosterNameText(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/[，。、；;:："'`~!！?？\-.()（）【】[\]<>《》\/\\|]/g, '')
    .toLowerCase();
}

function dedupeObservedNames(values) {
  const unique = [];
  const seen = new Set();
  for (const item of Array.isArray(values) ? values : []) {
    const text = String(item ?? '').trim();
    const normalized = normalizeRosterNameText(text);
    if (!text || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(text);
    if (unique.length >= NAME_OBSERVATION_LIMIT) break;
  }
  return unique;
}

function levenshteinDistance(left, right) {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;

  const matrix = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let row = 0; row <= left.length; row += 1) matrix[row][0] = row;
  for (let col = 0; col <= right.length; col += 1) matrix[0][col] = col;

  for (let row = 1; row <= left.length; row += 1) {
    for (let col = 1; col <= right.length; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost,
      );
    }
  }

  return matrix[left.length][right.length];
}

function getNameSimilarity(left, right) {
  const normalizedLeft = normalizeRosterNameText(left);
  const normalizedRight = normalizeRosterNameText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return 0.96;
  const distance = levenshteinDistance(normalizedLeft, normalizedRight);
  return 1 - distance / Math.max(normalizedLeft.length, normalizedRight.length);
}

function resolveStudentNameFromRoster({ directName, observedNames, rosterNames }) {
  const nameReadings = dedupeObservedNames([directName, ...dedupeObservedNames(observedNames)]);
  if (!rosterNames.length) {
    return {
      studentName: String(directName ?? '').trim(),
      observedNames: nameReadings,
      suggestedStudentName: '',
      suggestedStudentConfidence: 0,
    };
  }

  for (const reading of nameReadings) {
    if (rosterNames.includes(reading)) {
      return {
        studentName: reading,
        observedNames: nameReadings,
        suggestedStudentName: reading,
        suggestedStudentConfidence: 1,
      };
    }
  }

  const scoredCandidates = rosterNames
    .map((name) => {
      let bestScore = 0;
      let supportCount = 0;

      for (const reading of nameReadings) {
        const similarity = getNameSimilarity(reading, name);
        if (similarity > bestScore) bestScore = similarity;
        if (similarity >= 0.72) supportCount += 1;
      }

      return {
        name,
        bestScore,
        score: Math.min(1, bestScore + Math.max(0, supportCount - 1) * 0.04),
      };
    })
    .sort((left, right) => right.score - left.score);

  const best = scoredCandidates[0];
  const second = scoredCandidates[1];
  const gap = best ? best.score - (second?.score || 0) : 0;

  if (!best || best.score < NAME_SUGGEST_THRESHOLD) {
    return {
      studentName: '',
      observedNames: nameReadings,
      suggestedStudentName: '',
      suggestedStudentConfidence: best?.score || 0,
    };
  }

  if (best.score >= NAME_AUTO_ASSIGN_THRESHOLD && gap >= NAME_AUTO_ASSIGN_GAP) {
    return {
      studentName: best.name,
      observedNames: nameReadings,
      suggestedStudentName: best.name,
      suggestedStudentConfidence: best.score,
    };
  }

  return {
    studentName: '',
    observedNames: nameReadings,
    suggestedStudentName: best.name,
    suggestedStudentConfidence: best.score,
  };
}

function buildAnswerSheetRecognitionCacheKey({ settings, profile, task, sheet, classroomStudents }) {
  const profileConfig = getProfileConfig(settings, profile);
  const questionHints = (Array.isArray(task?.questions) ? task.questions : [])
    .map((question) => ({
      questionNo: String(question?.questionNo || '').trim(),
      type: String(question?.type || '').trim(),
      enabled: question?.enabled !== false,
    }))
    .filter((question) => question.questionNo)
    .sort((left, right) => String(left.questionNo).localeCompare(String(right.questionNo), 'zh-CN', { numeric: true }));
  const fileStat = fs.statSync(sheet.storedPath);

  return JSON.stringify({
    profile: normalizeChatProfile(profile),
    model: profileConfig.preferredModel,
    baseUrl: profileConfig.baseUrl,
    mode: task?.mode || '',
    className: String(task?.className || '').trim(),
    classroomStudents: Array.from(
      new Set((Array.isArray(classroomStudents) ? classroomStudents : []).map((item) => String(item || '').trim()).filter(Boolean)),
    ).sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true })),
    questionHints,
    storedPath: path.resolve(sheet.storedPath),
    mimeType: String(sheet?.mimeType || '').trim(),
    size: Number(fileStat.size || 0),
    mtimeMs: Number(fileStat.mtimeMs || 0),
  });
}

function storeAnswerSheetRecognitionCache(cacheKey, result) {
  if (answerSheetRecognitionCache.has(cacheKey)) {
    answerSheetRecognitionCache.delete(cacheKey);
  }
  answerSheetRecognitionCache.set(cacheKey, result);

  while (answerSheetRecognitionCache.size > ANSWER_SHEET_CACHE_LIMIT) {
    const oldestKey = answerSheetRecognitionCache.keys().next().value;
    if (!oldestKey) break;
    answerSheetRecognitionCache.delete(oldestKey);
  }
}

async function recognizeAnswerSheetUncached({ settings, profile, engine, task, sheet, classroomStudents }) {
  const profileConfig = getProfileConfig(settings, profile);
  const payload = await chatCompletion({
    settings,
    profile,
    temperature: 0,
    maxTokens: getAnswerSheetRecognitionMaxTokens(task),
    messages: [
      {
        role: 'system',
        content: '你是高中历史阅卷系统中的答题卡 OCR 助手。你只负责忠实识别姓名和学生作答，并严格输出 JSON。',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: buildAnswerSheetPrompt({
              task,
              classroomStudents,
              sheetName: sheet.displayName || sheet.sourceOriginalName || '学生答题卡',
            }),
          },
          {
            type: 'image_url',
            image_url: {
              url: fileToDataUrl(sheet.storedPath, sheet.mimeType || 'image/jpeg'),
            },
          },
        ],
      },
    ],
  });

  const parsed = await parseModelJson({
    settings,
    profile,
    raw: getContentFromCompletion(payload),
    schemaHint: getAnswerSheetSchema(task.mode),
  });
  const { choiceQuestionNos, subjectiveQuestionNos } = getTaskQuestionBuckets(task);
  const modelStudentName = String(parsed?.studentName ?? '').trim();
  const observedNames = dedupeObservedNames(parsed?.observedNames);
  const nameResolution = resolveStudentNameFromRoster({
    directName: modelStudentName,
    observedNames,
    rosterNames: classroomStudents,
  });
  const studentName = nameResolution.studentName || (!classroomStudents.length ? modelStudentName : '');
  const normalizedChoice =
    task.mode === 'subjective'
      ? {
          answers: [],
          warnings: [],
        }
      : normalizeRecognizedChoiceAnswers(parsed?.choiceAnswers || [], choiceQuestionNos);
  const nameWarnings = [];

  if (!studentName) {
    if (nameResolution.suggestedStudentName) {
      nameWarnings.push('姓名已给出名单猜测，请人工确认后归属。');
    } else if (nameResolution.observedNames.length) {
      nameWarnings.push('识别到了姓名字样，但暂时无法和班级名单稳定匹配。');
    } else {
      nameWarnings.push('姓名未识别出来，建议打开答题卡切片后手动确认。');
    }
  }

  return {
    engine: 'doubao',
    provider: getProviderForProfile(profile),
    selectedModel: payload.__selectedModel || profileConfig.preferredModel,
    studentName,
    observedNames: nameResolution.observedNames,
    suggestedStudentName: studentName ? '' : nameResolution.suggestedStudentName,
    suggestedStudentConfidence: studentName ? 0 : nameResolution.suggestedStudentConfidence,
    choiceAnswers: normalizedChoice.answers,
    subjectiveAnswers:
      task.mode === 'choice'
        ? []
        : normalizeRecognizedSubjectiveAnswers(parsed?.subjectiveAnswers || [], subjectiveQuestionNos),
    warnings: [
      ...(Array.isArray(parsed?.warnings) ? parsed.warnings.filter(Boolean).map(String) : []),
      ...nameWarnings,
      ...normalizedChoice.warnings,
    ],
  };
}

const DEFAULT_SUBJECTIVE_ORDINARY_RULE_PROMPT = `普通型主观题
1、要求AI先读题目，再读参考答案，对题目有充分理解。
2、有采分点的句子（老师会在阅卷要求中列出），学生必须答到采分点才能给分，所有表达都要围绕采分点。
3、如果没有相应采分点的句子，意思相近即可得分。
4、如果某一点意思到位了，但出现轻微史实错误，扣1分；如果这一点本来就是1分，则该点不得分。
5、学生写的其他和参考答案不符合的话，不扣分。
6、要关注每一点的给分，常见是一点2分，也可能一点1分。
7、优先参考题目的阅卷要求；如果阅卷要求与这些原则冲突，以阅卷要求为准；如果没有阅卷要求，则以这些原则为主。
AI约束：只能依据学生作答原文评分；不能补充学生未写出的观点；不能因为文采好就替代知识点命中。`;

const DEFAULT_SUBJECTIVE_ESSAY_RULE_PROMPT = `论述型主观题
1、按“论题-三段论述过程-结论”四个层次进行结构化阅卷。优先参考题目的阅卷要求；如果阅卷要求与这些原则冲突，以阅卷要求为准。
2、论题部分要先判断“是否有论题”，再判断“是否符合题意、是否合适”。论题是否合适不能只机械参考模板，还要结合题目要求与学生原文进行 AI 独立判断。没有论题时返回红色标签“缺少论题”，并生成建议论题；跑题或论题不合适时返回红色标签并给出建议论题或修改后的论题。
3、三段论述过程逐段判断，每段至少检查：是否围绕论题、是否有小标题、是否有具体史实、是否围绕史实展开合理说明、是否史实准确。围绕论题展开返回绿色标签“围绕论题展开”，否则返回红色标签“没有围绕论题展开”并执行全扣分；缺少小标题扣 1 分；缺少必要史实扣 2 分；说明和解释不准确不合理扣 2 分；史实错误按 1 个扣 1 分计数。
4、结论部分至少检查：是否有结论、是否有升华。有结论返回绿色标签“有结论”，没有结论返回红色标签“缺少结论”并生成一段结论；有升华返回绿色标签“有升华”，没有升华返回红色标签“缺少升华”并生成一段带升华的结论。
5、AI 必须输出结构化结果：每个二级标准都按“是否……”返回绿色或红色标签。红色标签不仅要说明问题，还要给出修改建议；只要某一段论述出现任何红色标签，就必须基于学生原回答生成该段修改版，修正错误但尽量保留学生原有思路和材料。
AI约束：只能依据学生作答原文评分；不能补充学生未写出的观点；不能因为文采好就替代知识点命中。`;

async function recognizeAnswerSheet(args) {
  const { settings, profile, task, sheet, classroomStudents } = args;
  const cacheKey = buildAnswerSheetRecognitionCacheKey({ settings, profile, task, sheet, classroomStudents });

  if (answerSheetRecognitionCache.has(cacheKey)) {
    return structuredClone(answerSheetRecognitionCache.get(cacheKey));
  }

  if (answerSheetRecognitionInFlight.has(cacheKey)) {
    return structuredClone(await answerSheetRecognitionInFlight.get(cacheKey));
  }

  const recognitionPromise = recognizeAnswerSheetUncached(args).then((result) => {
    storeAnswerSheetRecognitionCache(cacheKey, result);
    return result;
  });

  answerSheetRecognitionInFlight.set(cacheKey, recognitionPromise);

  try {
    return structuredClone(await recognitionPromise);
  } finally {
    answerSheetRecognitionInFlight.delete(cacheKey);
  }
}

function normalizeFreeText(value) {
  return String(value ?? '').replace(/\r/g, '').trim();
}

function uniqueTextItems(values, limit = 6) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(normalizeFreeText).filter(Boolean))).slice(0, limit);
}

function sanitizeAliasSuggestions(values, existingAliases = [], pointLabel = '') {
  const blocked = new Set(
    [normalizeFreeText(pointLabel), ...uniqueTextItems(existingAliases, 30)]
      .map((item) => item.toLowerCase())
      .filter(Boolean),
  );
  const seen = new Set();

  return (Array.isArray(values) ? values : [])
    .map((item) => normalizeFreeText(item).replace(/^[（(]?\d+[）).、\s-]*/, '').replace(/[。；;]+$/g, '').trim())
    .filter(Boolean)
    .filter((item) => item.length <= 36)
    .filter((item) => {
      const normalized = item.toLowerCase();
      if (!normalized || blocked.has(normalized) || seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    })
    .slice(0, 8);
}

function sanitizeEssayThesisSuggestions(values, existingTemplates = []) {
  const blocked = new Set(
    uniqueTextItems(existingTemplates, 20)
      .map((item) => item.toLowerCase())
      .filter(Boolean),
  );
  const seen = new Set();

  return (Array.isArray(values) ? values : [])
    .map((item) => normalizeFreeText(item).replace(/^[（(]?\d+[）).、\s-]*/, '').replace(/[。；;]+$/g, '').trim())
    .filter(Boolean)
    .filter((item) => item.length <= 48)
    .filter((item) => {
      const normalized = item.toLowerCase();
      if (!normalized || blocked.has(normalized) || seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    })
    .slice(0, 8);
}

function sanitizeEssayKeywordGroups(values, existingGroups = []) {
  const existingTexts = new Set(
    (Array.isArray(existingGroups) ? existingGroups : [])
      .flatMap((group) => [
        normalizeFreeText(group?.label).toLowerCase(),
        ...uniqueTextItems(group?.expressions, 20).map((item) => item.toLowerCase()),
      ])
      .filter(Boolean),
  );

  const seenLabels = new Set();

  return (Array.isArray(values) ? values : [])
    .map((item) => {
      const label = normalizeFreeText(item?.label);
      const type = ['judgment', 'object', 'scope'].includes(normalizeFreeText(item?.type))
        ? normalizeFreeText(item?.type)
        : 'judgment';
      const expressions = uniqueTextItems(item?.expressions, 8)
        .map((entry) => normalizeFreeText(entry).replace(/^[（(]?\d+[）).、\s-]*/, '').trim())
        .filter(Boolean)
        .filter((entry) => !existingTexts.has(entry.toLowerCase()));

      if (!label && !expressions.length) return null;
      const normalizedLabel = (label || expressions[0] || '').toLowerCase();
      if (!normalizedLabel || seenLabels.has(normalizedLabel) || existingTexts.has(normalizedLabel)) {
        return null;
      }
      seenLabels.add(normalizedLabel);

      return {
        label: label || expressions[0] || '未命名关键词组',
        type,
        expressions: expressions.length ? expressions : (label ? [label] : []),
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function splitChineseSentences(value) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .split(/[\n。！？!?；;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferEssayTemplateFromReferenceAnswer(standardAnswer) {
  const sentences = splitChineseSentences(standardAnswer);
  if (!sentences.length) return [];

  const preferred = sentences.find((sentence) => {
    const length = sentence.length;
    if (length < 8 || length > 60) return false;
    return /[是为将会促使体现反映说明表明推动加速深化强化弱化凸显折射具有]/.test(sentence)
      || /原因|影响|特点|实质|趋势|评价|作用|变化|意义|背景/.test(sentence);
  });

  const fallback = sentences.find((sentence) => sentence.length >= 8 && sentence.length <= 60);
  return preferred ? [preferred] : (fallback ? [fallback] : []);
}

function inferEssayKeywordGroupsHeuristically({ questionContent, standardAnswer }) {
  const text = `${normalizeFreeText(questionContent)}\n${normalizeFreeText(standardAnswer)}`;
  if (!text.trim()) return [];

  const groups = [];
  const addGroup = (label, type, expressions, required = type === 'judgment') => {
    groups.push({
      label,
      type,
      required,
      expressions,
    });
  };

  if (/原因|背景|动因|根源/.test(text)) {
    addGroup('原因背景', 'judgment', ['原因', '背景', '动因', '根源']);
  }
  if (/影响|作用|意义|后果/.test(text)) {
    addGroup('影响作用', 'judgment', ['影响', '作用', '意义', '后果']);
  }
  if (/特点|特征/.test(text)) {
    addGroup('特点特征', 'judgment', ['特点', '特征']);
  }
  if (/实质|本质/.test(text)) {
    addGroup('实质本质', 'judgment', ['实质', '本质']);
  }
  if (/趋势|走向|变化|演变|转型/.test(text)) {
    addGroup('趋势变化', 'judgment', ['趋势', '走向', '变化', '演变', '转型']);
  }
  if (/评价|看待|认识/.test(text)) {
    addGroup('评价认识', 'judgment', ['评价', '看待', '认识']);
  }

  const scopeMatches = Array.from(new Set(text.match(/\d{2,4}年(?:至\d{2,4}年)?|近代|现代|古代|明清|晚清|民国|新中国/g) || []));
  if (scopeMatches.length) {
    addGroup('时空范围', 'scope', scopeMatches.slice(0, 4), false);
  }

  const objectCandidates = Array.from(new Set(
    splitChineseSentences(text)
      .flatMap((sentence) => sentence.match(/[\u4e00-\u9fa5]{2,12}(?:制度|改革|革命|战争|运动|政策|道路|秩序|体制|社会|经济|政治|思想|文化)/g) || []),
  ));
  if (objectCandidates.length) {
    addGroup('核心对象', 'object', objectCandidates.slice(0, 4), false);
  }

  const sanitized = sanitizeEssayKeywordGroups(groups, []);
  return sanitized.slice(0, 6).map((group) => ({
    ...group,
    required: group.type === 'judgment',
  }));
}

async function hydrateEssayRuleTreeDefaults({ settings, question }) {
  if (question?.type !== 'essay') {
    return question;
  }

  const essayRuleTree = normalizeEssayRuleTree(question.essayRuleTree, question);
  const hasTemplates = Array.isArray(essayRuleTree?.thesis?.templates) && essayRuleTree.thesis.templates.some((item) => normalizeFreeText(item));
  const hasKeywordGroups = Array.isArray(essayRuleTree?.thesis?.keywordGroups) && essayRuleTree.thesis.keywordGroups.some((group) =>
    normalizeFreeText(group?.label) || (Array.isArray(group?.expressions) && group.expressions.some((entry) => normalizeFreeText(entry?.text))),
  );

  if (hasTemplates && hasKeywordGroups) {
    const normalizedTree = normalizeEssayRuleTree(essayRuleTree, question);
    return {
      ...question,
      essayRuleTree: normalizedTree,
      gradingRule: buildEssayRuleSummary(normalizedTree, question),
      score: getEssayRuleTreeTotalScore(normalizedTree, question) || Number(question?.score || 0),
    };
  }

  const inferredTemplates = hasTemplates ? [] : inferEssayTemplateFromReferenceAnswer(question?.standardAnswer);
  const inferredKeywordGroups = hasKeywordGroups ? [] : inferEssayKeywordGroupsHeuristically({
    questionContent: question?.content,
    standardAnswer: question?.standardAnswer,
  });

  let aiTemplates = [];
  let aiKeywordGroups = [];
  if ((!hasTemplates || !hasKeywordGroups) && normalizeFreeText(question?.content)) {
    try {
      const suggestions = await generateEssayThesisSuggestions({
        settings,
        questionNo: question?.questionNo,
        questionContent: question?.content,
        standardAnswer: question?.standardAnswer,
        existingTemplates: inferredTemplates,
        existingKeywordGroups: inferredKeywordGroups,
        notes: question?.gradingRule,
      });
      aiTemplates = hasTemplates ? [] : (suggestions?.theses || []);
      aiKeywordGroups = hasKeywordGroups ? [] : (suggestions?.keywordGroups || []);
    } catch {
      // Keep heuristic defaults if AI suggestion generation fails during extraction.
    }
  }

  const normalizedKeywordGroups = [...inferredKeywordGroups, ...aiKeywordGroups].map((group) => ({
    ...group,
    expressions: (Array.isArray(group?.expressions) ? group.expressions : []).map((expression) => ({
      id: crypto.randomUUID(),
      text: expression,
    })),
  }));

  const nextTree = normalizeEssayRuleTree({
    ...essayRuleTree,
    thesis: {
      ...essayRuleTree.thesis,
      templates: hasTemplates
        ? essayRuleTree.thesis.templates
        : [...inferredTemplates, ...aiTemplates],
      keywordGroups: hasKeywordGroups
        ? essayRuleTree.thesis.keywordGroups
        : normalizedKeywordGroups,
    },
  }, question);

  return {
    ...question,
    essayRuleTree: nextTree,
    gradingRule: buildEssayRuleSummary(nextTree, question),
    score: getEssayRuleTreeTotalScore(nextTree, question) || Number(question?.score || 0),
  };
}

function sanitizeAnnotationErrors(values) {
  return (Array.isArray(values) ? values : [])
    .map((item) => ({
      excerpt: normalizeFreeText(item?.excerpt),
      reason: normalizeFreeText(item?.reason),
    }))
    .filter((item) => item.excerpt && item.reason)
    .slice(0, 6);
}

function sanitizeSubReview(item, index) {
  const label = normalizeFreeText(item?.label) || `Point ${index + 1}`;
  const fullScoreRaw = Number(item?.fullScore ?? 0);
  const fullScore = Number.isFinite(fullScoreRaw) ? Math.max(0, fullScoreRaw) : 0;
  const scoreRaw = Number(item?.score ?? 0);
  const score = fullScore > 0
    ? Math.max(0, Math.min(fullScore, Number.isFinite(scoreRaw) ? scoreRaw : 0))
    : (Number.isFinite(scoreRaw) ? Math.max(0, scoreRaw) : 0);

  return {
    label,
    score,
    fullScore,
    comment: normalizeFreeText(item?.comment),
    matchedExcerpts: uniqueTextItems(item?.matchedExcerpts, 4),
  };
}

function sanitizePointReview(item, index) {
  const pointLabel = normalizeFreeText(item?.pointLabel || item?.label) || `Point ${index + 1}`;
  const sectionLabel = normalizeFreeText(item?.sectionLabel);
  const subquestionIndexRaw = Number(item?.subquestionIndex ?? 0);
  const subquestionIndex = Number.isFinite(subquestionIndexRaw) && subquestionIndexRaw > 0 ? Math.trunc(subquestionIndexRaw) : null;
  const fullScoreRaw = Number(item?.fullScore ?? 0);
  const fullScore = Number.isFinite(fullScoreRaw) ? Math.max(0, fullScoreRaw) : 0;
  const scoreRaw = Number(item?.score ?? 0);
  const score = fullScore > 0
    ? Math.max(0, Math.min(fullScore, Number.isFinite(scoreRaw) ? scoreRaw : 0))
    : (Number.isFinite(scoreRaw) ? Math.max(0, scoreRaw) : 0);

  return {
    subquestionIndex,
    sectionLabel,
    pointLabel,
    score,
    fullScore,
    comment: normalizeFreeText(item?.comment),
    matchedExcerpts: uniqueTextItems(item?.matchedExcerpts, 6),
  };
}

function sanitizeSectionComment(item) {
  return {
    subquestionIndex: Number.isFinite(Number(item?.subquestionIndex)) && Number(item?.subquestionIndex) > 0
      ? Math.trunc(Number(item?.subquestionIndex))
      : null,
    sectionLabel: normalizeFreeText(item?.sectionLabel),
    comment: normalizeFreeText(item?.comment),
  };
}

function sanitizeIndexedAwardedPoint(item, index, answerUnits) {
  const unitMap = new Map((Array.isArray(answerUnits) ? answerUnits : []).map((unit) => [unit.id, unit]));
  const unitIds = Array.from(
    new Set(
      (Array.isArray(item?.unitIds) ? item.unitIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value >= 0)
        .map((value) => Math.trunc(value)),
    ),
  );
  const referencedUnits = unitIds.map((id) => unitMap.get(id)).filter(Boolean);
  const scoreRaw = Number(item?.score ?? 0);
  const score = Number.isFinite(scoreRaw) ? Math.max(0, scoreRaw) : 0;
  const excerpt = normalizeFreeText(item?.excerpt);
  const pointLabel = normalizeFreeText(item?.pointLabel || item?.label) || `Point ${index + 1}`;
  const explicitSubquestionIndex = Number(item?.subquestionIndex ?? 0);
  const referencedSubquestions = Array.from(
    new Set(referencedUnits.map((unit) => Number(unit?.subquestionIndex || 0)).filter((value) => value > 0)),
  );
  const resolvedSubquestionIndex =
    Number.isFinite(explicitSubquestionIndex) && explicitSubquestionIndex > 0
      ? Math.trunc(explicitSubquestionIndex)
      : (referencedSubquestions.length === 1 ? referencedSubquestions[0] : null);

  if (!score || !excerpt || !referencedUnits.length || resolvedSubquestionIndex == null) {
    return null;
  }

  if (referencedSubquestions.length && !referencedSubquestions.includes(resolvedSubquestionIndex)) {
    return null;
  }

  const matchedUnit = referencedUnits.find((unit) => String(unit?.text || '').includes(excerpt));
  if (!matchedUnit) {
    return null;
  }

  const fullScoreRaw = Number(item?.fullScore ?? score);
  const fullScore = Number.isFinite(fullScoreRaw) ? Math.max(score, fullScoreRaw) : score;
  const sectionLabel = normalizeFreeText(item?.sectionLabel)
    || normalizeFreeText(matchedUnit.sectionLabel)
    || `（${resolvedSubquestionIndex}）小题`;

  return {
    subquestionIndex: resolvedSubquestionIndex,
    sectionLabel,
    pointLabel,
    score,
    fullScore,
    unitIds,
    excerpt,
  };
}

function sanitizeIndexedError(item, answerUnits) {
  const unitMap = new Map((Array.isArray(answerUnits) ? answerUnits : []).map((unit) => [unit.id, unit]));
  const unitIds = Array.from(
    new Set(
      (Array.isArray(item?.unitIds) ? item.unitIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value >= 0)
        .map((value) => Math.trunc(value)),
    ),
  );
  const referencedUnits = unitIds.map((id) => unitMap.get(id)).filter(Boolean);
  const excerpt = normalizeFreeText(item?.excerpt);
  const reason = normalizeFreeText(item?.reason);

  if (!excerpt || !reason || !referencedUnits.length) {
    return null;
  }

  const matchedUnit = referencedUnits.find((unit) => String(unit?.text || '').includes(excerpt));
  if (!matchedUnit) {
    return null;
  }

  const explicitSubquestionIndex = Number(item?.subquestionIndex ?? 0);
  const resolvedSubquestionIndex =
    Number.isFinite(explicitSubquestionIndex) && explicitSubquestionIndex > 0
      ? Math.trunc(explicitSubquestionIndex)
      : Number(matchedUnit.subquestionIndex || 0) || null;

  return {
    subquestionIndex: resolvedSubquestionIndex,
    unitIds,
    excerpt,
    reason,
  };
}

function legacySubReviewToPointReview(review, index) {
  return sanitizePointReview({
    sectionLabel: normalizeFreeText(review?.label),
    pointLabel: normalizeFreeText(review?.label),
    score: review?.score,
    fullScore: review?.fullScore,
    comment: review?.comment,
    matchedExcerpts: review?.matchedExcerpts,
  }, index);
}

function pointReviewToLegacySubReview(pointReview, index) {
  return sanitizeSubReview({
    label: normalizeFreeText(pointReview?.pointLabel) || `Point ${index + 1}`,
    score: pointReview?.score,
    fullScore: pointReview?.fullScore,
    comment: pointReview?.comment,
    matchedExcerpts: pointReview?.matchedExcerpts,
  }, index);
}

function toChineseNumber(value) {
  const map = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };

  if (!value) return null;
  if (value === '十') return 10;
  if (value.startsWith('十')) return 10 + (map[value.slice(1)] || 0);
  if (value.endsWith('十')) return (map[value[0]] || 0) * 10;
  if (value.includes('十')) {
    const [left, right] = value.split('十');
    return (map[left] || 0) * 10 + (map[right] || 0);
  }
  return map[value] || null;
}

function extractSubquestionIndex(value) {
  const text = normalizeFreeText(value);
  if (!text) return null;

  const bracketMatch = text.match(/[（(]([1-9]\d*)[）)]/);
  if (bracketMatch) return Number(bracketMatch[1]);

  const ordinalDigitMatch = text.match(/第\s*([1-9]\d*)\s*(?:小题|题|点|方面)?/);
  if (ordinalDigitMatch) return Number(ordinalDigitMatch[1]);

  const ordinalChineseMatch = text.match(/第\s*([一二三四五六七八九十]+)\s*(?:小题|题|点|方面)?/);
  if (ordinalChineseMatch) return toChineseNumber(ordinalChineseMatch[1]);

  const circledNumbers = '①②③④⑤⑥⑦⑧⑨⑩';
  for (let index = 0; index < circledNumbers.length; index += 1) {
    if (text.includes(circledNumbers[index])) {
      return index + 1;
    }
  }

  const chineseMatch = text.match(/([一二三四五六七八九十]+)(?:小题)?/);
  if (chineseMatch) return toChineseNumber(chineseMatch[1]);

  return null;
}

function collectSubquestionRanges(answer) {
  const source = normalizeFreeText(answer).replace(/\n{3,}/g, '\n\n');
  if (!source) return [];

  const patterns = [
    /(^|\n)(\s*)(（([1-9]\d*)）|\(([1-9]\d*)\))/g,
    /(^|\n)(\s*)([①②③④⑤⑥⑦⑧⑨⑩])/g,
    /(^|\n)(\s*)([一二三四五六七八九十]+[、.．])/g,
  ];

  for (const pattern of patterns) {
    const markers = Array.from(source.matchAll(pattern)).map((match, index) => {
      const prefix = `${match[1] || ''}${match[2] || ''}`;
      const marker = match[3] || '';
      const start = (match.index || 0) + prefix.length;
      return {
        marker,
        index: extractSubquestionIndex(marker) || index + 1,
        start,
      };
    });

    if (markers.length >= 2) {
      return markers.map((marker, index) => ({
        marker: marker.marker,
        index: marker.index,
        start: index === 0 ? 0 : marker.start,
        end: markers[index + 1] ? markers[index + 1].start : source.length,
      }));
    }
  }

  return source ? [{ marker: '', index: 1, start: 0, end: source.length }] : [];
}

function locateExcerptGroup(answer, excerpt, ranges) {
  const source = normalizeFreeText(answer);
  const needle = normalizeFreeText(excerpt);
  if (!source || !needle || !ranges.length) return null;

  const index = source.indexOf(needle);
  if (index === -1) return null;

  const matchedRange = ranges.find((range) => index >= range.start && index < range.end);
  return matchedRange ? matchedRange.index : null;
}

function formatSubquestionLabel(index) {
  return `（${index}）小题`;
}

function mergeReviewComments(reviews) {
  const comments = Array.from(new Set(reviews.map((review) => normalizeFreeText(review.comment)).filter(Boolean)));
  if (!comments.length) return '本小题暂未生成点评。';
  if (comments.length === 1) return comments[0];
  return comments.join('；');
}

function buildMergedReview(label, reviews) {
  const fullScore = reviews.reduce((sum, review) => sum + Math.max(0, Number(review.fullScore || 0)), 0);
  const score = reviews.reduce((sum, review) => sum + Number(review.score || 0), 0);
  return {
    label,
    score,
    fullScore,
    comment: mergeReviewComments(reviews),
    matchedExcerpts: uniqueTextItems(reviews.flatMap((review) => review.matchedExcerpts || []), 6),
  };
}

function mergeOrdinaryDisplaySubReviews(question, subReviews) {
  const ranges = collectSubquestionRanges(question?.studentAnswer);
  if (!subReviews.length) return [];
  if (!ranges.length) {
    return [buildMergedReview('（1）小题', subReviews)];
  }

  const groups = new Map();
  let fallbackCursor = 0;

  subReviews.forEach((review) => {
    const explicitIndex = extractSubquestionIndex(review.label) || extractSubquestionIndex(review.comment);
    const excerptIndex = explicitIndex
      ? null
      : (review.matchedExcerpts || [])
        .map((excerpt) => locateExcerptGroup(question?.studentAnswer, excerpt, ranges))
        .find(Boolean);
    const fallbackIndex = ranges[Math.min(fallbackCursor, ranges.length - 1)]?.index || 1;
    const groupIndex = explicitIndex || excerptIndex || fallbackIndex;
    const key = String(groupIndex);

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(review);

    if (!explicitIndex && !excerptIndex && fallbackCursor < ranges.length - 1) {
      fallbackCursor += 1;
    }
  });

  return Array.from(groups.entries())
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([groupIndex, reviews]) => buildMergedReview(formatSubquestionLabel(Number(groupIndex) || 1), reviews));
}

function inferEssayDisplayKey(review) {
  const label = normalizeFreeText(review?.label);
  const comment = normalizeFreeText(review?.comment);
  const source = `${label} ${comment}`;

  if (/论题|标题|观点/.test(source)) return '论题';
  if (/方面一|第一方面|方面1|第一点|角度一|第1方面/.test(source)) return '方面一';
  if (/方面二|第二方面|方面2|第二点|角度二|第2方面/.test(source)) return '方面二';
  if (/方面三|第三方面|方面3|第三点|角度三|第3方面/.test(source)) return '方面三';
  if (/结论|总结|启示|认识|升华/.test(source)) return '结论';
  return label || '补充点评';
}

function mergeEssayDisplaySubReviews(subReviews) {
  const groups = new Map();
  subReviews.forEach((review) => {
    const key = inferEssayDisplayKey(review);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(review);
  });

  const order = ['论题', '方面一', '方面二', '方面三', '结论'];
  return Array.from(groups.entries())
    .sort((left, right) => {
      const leftIndex = order.indexOf(left[0]);
      const rightIndex = order.indexOf(right[0]);
      if (leftIndex === -1 && rightIndex === -1) return left[0].localeCompare(right[0], 'zh-CN');
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    })
    .map(([label, reviews]) => buildMergedReview(label, reviews));
}

function buildDisplaySubReviews(question, subReviews) {
  if (!Array.isArray(subReviews) || !subReviews.length) return [];
  return question?.type === 'essay'
    ? mergeEssayDisplaySubReviews(subReviews)
    : mergeOrdinaryDisplaySubReviews(question, subReviews);
}

function splitAnswerSectionIntoUnits(source, offset, subquestionIndex, sectionLabel) {
  const units = [];
  const matcher = /[^。！？；\n]+[。！？；]?/g;
  let match;

  while ((match = matcher.exec(source))) {
    const raw = String(match[0] || '');
    const leading = (raw.match(/^\s*/) || [''])[0].length;
    const trailing = (raw.match(/\s*$/) || [''])[0].length;
    const trimmed = raw.slice(leading, raw.length - trailing);
    const text = normalizeFreeText(trimmed);
    if (!text) continue;

    const start = offset + match.index + leading;
    const end = offset + match.index + raw.length - trailing;
    units.push({
      start,
      end,
      subquestionIndex,
      sectionLabel,
      text,
    });
  }

  if (units.length) {
    return units;
  }

  const fallbackText = normalizeFreeText(source);
  if (!fallbackText) return [];

  return [{
    start: offset,
    end: offset + source.length,
    subquestionIndex,
    sectionLabel,
    text: fallbackText,
  }];
}

function buildIndexedAnswerUnits(question, answer) {
  const source = normalizeFreeText(answer);
  if (!source || question?.type === 'essay') {
    return [];
  }

  const sectionContext = buildOrdinarySectionContext({ question, answer: source });
  const sections = Array.isArray(sectionContext?.resolvedSections) && sectionContext.resolvedSections.length
    ? sectionContext.resolvedSections
    : [{
        order: 1,
        label: '本题',
        start: 0,
        end: source.length,
      }];

  const units = [];
  sections.forEach((section) => {
    const subquestionIndex = Number(section?.order || 0) > 0 ? Number(section.order) : 1;
    const sectionLabel = normalizeFreeText(section?.label) || `（${subquestionIndex}）小题`;
    const start = Math.max(0, Number(section?.start || 0));
    const end = Math.min(source.length, Number(section?.end || source.length));
    const sectionSource = source.slice(start, end);
    splitAnswerSectionIntoUnits(sectionSource, start, subquestionIndex, sectionLabel).forEach((unit) => units.push(unit));
  });

  return units.map((unit, index) => ({
    id: index,
    start: unit.start,
    end: unit.end,
    subquestionIndex: unit.subquestionIndex,
    sectionLabel: unit.sectionLabel,
    text: unit.text,
  }));
}

function buildLooseSearchIndex(text) {
  const source = String(text || '');
  const normalizedChars = [];
  const indexMap = [];

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (/[\s,，。；;、:：!！?？"'“”‘’（）()\[\]【】《》<>·\-—]/.test(char)) {
      continue;
    }
    normalizedChars.push(char);
    indexMap.push(index);
  }

  return {
    source,
    normalized: normalizedChars.join(''),
    indexMap,
  };
}

function findLooseTextExcerpt(source, needle) {
  const normalizedNeedle = buildLooseSearchIndex(needle).normalized;
  if (!source || !normalizedNeedle) return '';

  const haystack = buildLooseSearchIndex(source);
  if (!haystack.normalized) return '';

  const normalizedIndex = haystack.normalized.indexOf(normalizedNeedle);
  if (normalizedIndex === -1) return '';

  const start = haystack.indexMap[normalizedIndex];
  const end = haystack.indexMap[normalizedIndex + normalizedNeedle.length - 1] + 1;
  return String(haystack.source.slice(start, end) || '').trim();
}

function buildConceptBigrams(text) {
  const compact = normalizeFreeText(text).replace(/[^\u4E00-\u9FFFA-Za-z0-9]/g, '');
  if (!compact) return new Set();
  if (compact.length <= 2) return new Set([compact]);

  const grams = new Set();
  for (let index = 0; index < compact.length - 1; index += 1) {
    grams.add(compact.slice(index, index + 2));
  }
  return grams;
}

function computeConceptSimilarity(left, right) {
  const leftSet = buildConceptBigrams(left);
  const rightSet = buildConceptBigrams(right);
  if (!leftSet.size || !rightSet.size) return 0;

  let shared = 0;
  leftSet.forEach((token) => {
    if (rightSet.has(token)) {
      shared += 1;
    }
  });

  return shared / Math.max(1, Math.min(leftSet.size, rightSet.size));
}

function buildStructuredOrdinaryPointCatalog(question) {
  if (question?.type === 'essay') {
    return [];
  }

  const tree = normalizeOrdinaryGradingRuleTree(question?.gradingRuleTree, question);
  if (!tree?.sections?.length) {
    return [];
  }

  const catalog = [];
  let subquestionCursor = 0;

  tree.sections.forEach((section, sectionIndex) => {
    const sectionLabel = normalizeFreeText(section?.label) || `（${sectionIndex + 1}）小题`;
    section.subquestions.forEach((subquestion, subquestionIndex) => {
      subquestionCursor += 1;
      const structuredSubquestionIndex = subquestionCursor;
      const subquestionLabel = normalizeFreeText(subquestion?.label) || `${sectionLabel}子问题${subquestionIndex + 1}`;
      const subquestionScore = Math.max(0, Number(subquestion?.score || 0));

      (Array.isArray(subquestion?.points) ? subquestion.points : []).forEach((point, pointIndex) => {
        const pointLabel = normalizeFreeText(point?.label) || `采分点${pointIndex + 1}`;
        const aliases = uniqueTextItems(point?.aliases, 12);
        const notes = uniqueTextItems(point?.notes, 12);
        catalog.push({
          pointId: String(point?.id || `${structuredSubquestionIndex}-${pointIndex + 1}`),
          sectionId: String(section?.id || `section-${sectionIndex + 1}`),
          sectionLabel,
          structuredSubquestionIndex,
          structuredSubquestionLabel: subquestionLabel,
          structuredSubquestionScore: subquestionScore,
          pointOrder: pointIndex + 1,
          pointLabel,
          pointScore: Math.max(0, Number(point?.score || 0)),
          aliases,
          notes,
          allowSimilar: point?.allowSimilar !== false,
        });
      });
    });
  });

  return catalog;
}

function buildStructuredPointCandidateTexts(point) {
  const values = [...uniqueTextItems(point?.aliases, 12)];
  if (String(point?.pointLabel || '').trim().length <= 28) {
    values.push(point.pointLabel);
  }
  return uniqueTextItems(values, 12).sort((left, right) => right.length - left.length);
}

function looksLikeStructuredPointCovered(existingPointReviews, point) {
  const candidateTexts = [
    point?.pointLabel,
    point?.structuredSubquestionLabel,
    ...(Array.isArray(point?.aliases) ? point.aliases : []),
  ]
    .map((item) => normalizeFreeText(item))
    .filter(Boolean);

  if (!candidateTexts.length) {
    return false;
  }

  return (Array.isArray(existingPointReviews) ? existingPointReviews : []).some((review) => {
    if (Number(review?.score || 0) <= 0) {
      return false;
    }

    const reviewTexts = [
      normalizeFreeText(review?.pointLabel),
      ...uniqueTextItems(review?.matchedExcerpts, 6),
    ].filter(Boolean);

    return reviewTexts.some((reviewText) =>
      candidateTexts.some((candidateText) => computeConceptSimilarity(reviewText, candidateText) >= 0.34),
    );
  });
}

function buildStructuredRepairPointReview(point, matchedExcerpts) {
  const excerpts = uniqueTextItems(matchedExcerpts, 3);
  if (!excerpts.length || Number(point?.pointScore || 0) <= 0) {
    return null;
  }

  return sanitizePointReview({
    subquestionIndex: point.structuredSubquestionIndex,
    sectionLabel: `（${point.structuredSubquestionIndex}）小题`,
    pointLabel: point.pointLabel,
    score: point.pointScore,
    fullScore: point.pointScore,
    comment: '',
    matchedExcerpts: excerpts,
  }, point.pointOrder);
}

function buildDirectStructuredAliasRepairs({ answer, pointCatalog, existingPointReviews }) {
  const repairs = [];

  (Array.isArray(pointCatalog) ? pointCatalog : []).forEach((point) => {
    if (!point.aliases.length) {
      return;
    }
    if (looksLikeStructuredPointCovered([...existingPointReviews, ...repairs], point)) {
      return;
    }

    const matchedExcerpt = buildStructuredPointCandidateTexts(point)
      .map((candidate) => findLooseTextExcerpt(answer, candidate))
      .find(Boolean);

    const repair = buildStructuredRepairPointReview(point, matchedExcerpt ? [matchedExcerpt] : []);
    if (repair) {
      repairs.push(repair);
    }
  });

  return repairs;
}

function getPointRepairSchemaHint() {
  return '{"hits":[{"pointId":"point-1","matchedExcerpts":["学生原文中的精确证据片段1","学生原文中的精确证据片段2"]}]}';
}

async function repairStructuredOrdinaryPointReviews({
  settings,
  profile,
  task,
  student,
  question,
  answer,
  existingPointReviews,
}) {
  if (question?.type === 'essay') {
    return [];
  }

  const pointCatalog = buildStructuredOrdinaryPointCatalog(question);
  if (!pointCatalog.length) {
    return [];
  }

  const directRepairs = buildDirectStructuredAliasRepairs({
    answer,
    pointCatalog,
    existingPointReviews,
  });
  const coveredPointReviews = [...existingPointReviews, ...directRepairs];
  const candidates = pointCatalog.filter((point) =>
    (point.aliases.length || point.allowSimilar || point.notes.length)
    && !looksLikeStructuredPointCovered(coveredPointReviews, point),
  );

  if (!candidates.length) {
    return directRepairs;
  }

  const prompt = [
    '你正在执行一轮“漏判复核”。请只判断下面这些尚未命中的普通型主观题采分点，看看学生原文是否其实已经答到。',
    '硬性规则：',
    '1. 只能依据学生原文作答判断。',
    '2. 对每个候选采分点独立判断；如果学生原文表达与采分点或别名语义等价，也可以命中。',
    '3. matchedExcerpts 必须是从 studentAnswer 中逐字连续复制出的原文片段，可以返回 1-3 个片段共同支撑同一个采分点。',
    '4. 如果没有把握，就不要返回该采分点。',
    '5. 严格输出 JSON，不要解释。',
    `JSON schema: ${getPointRepairSchemaHint()}`,
    '',
    `taskName: ${normalizeFreeText(task?.name) || '(unnamed task)'}`,
    `studentName: ${normalizeFreeText(student?.studentName) || '(unknown student)'}`,
    `questionNo: ${normalizeFreeText(question?.questionNo) || '(unknown question)'}`,
    'questionContent:',
    normalizeFreeText(question?.content) || '(empty)',
    'standardAnswer:',
    normalizeFreeText(question?.standardAnswer) || '(empty)',
    'gradingRule:',
    normalizeFreeText(question?.gradingRule) || '(empty)',
    'alreadyAwarded:',
    JSON.stringify(
      (Array.isArray(coveredPointReviews) ? coveredPointReviews : []).map((review) => ({
        pointLabel: review.pointLabel,
        matchedExcerpts: review.matchedExcerpts,
        score: review.score,
      })),
      null,
      2,
    ),
    'candidatePoints:',
    JSON.stringify(
      candidates.map((point) => ({
        pointId: point.pointId,
        subquestionIndex: point.structuredSubquestionIndex,
        subquestionLabel: point.structuredSubquestionLabel,
        pointLabel: point.pointLabel,
        score: point.pointScore,
        aliases: point.aliases,
        notes: point.notes,
        allowSimilar: point.allowSimilar,
      })),
      null,
      2,
    ),
    'studentAnswer:',
    normalizeFreeText(answer) || '(blank)',
  ].join('\n');

  try {
    const payload = await chatCompletion({
      settings,
      profile,
      temperature: 0,
      maxTokens: 1400,
      messages: [
        {
          role: 'system',
          content: '你是高中历史主观题漏判复核助手，只能依据学生原文判断是否命中采分点，并严格输出 JSON。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });
    const parsed = await parseModelJson({
      settings,
      profile,
      raw: getContentFromCompletion(payload),
      schemaHint: getPointRepairSchemaHint(),
    });
    const pointMap = new Map(candidates.map((point) => [point.pointId, point]));
    const repairs = [];

    (Array.isArray(parsed?.hits) ? parsed.hits : []).forEach((item) => {
      const point = pointMap.get(String(item?.pointId || '').trim());
      if (!point) {
        return;
      }
      if (looksLikeStructuredPointCovered([...coveredPointReviews, ...repairs], point)) {
        return;
      }

      const matchedExcerpts = uniqueTextItems(item?.matchedExcerpts, 3)
        .map((excerpt) => findLooseTextExcerpt(answer, excerpt))
        .filter(Boolean);
      const repair = buildStructuredRepairPointReview(point, matchedExcerpts);
      if (repair) {
        repairs.push(repair);
      }
    });

    return [...directRepairs, ...repairs];
  } catch (error) {
    console.warn('[subjective-grading] structured point repair skipped:', error?.message || error);
    return directRepairs;
  }
}

function formatIndexedAnswerUnits(answerUnits) {
  if (!Array.isArray(answerUnits) || !answerUnits.length) {
    return '[0] (subquestion 1) (blank)';
  }

  return answerUnits
    .map((unit) => `[${unit.id}] (subquestion ${unit.subquestionIndex}) ${unit.text}`)
    .join('\n');
}

function getSubjectiveSchemaHint() {
  return `{
  "overallComment": "对该生本次主观题作答的整体评价",
  "questionGrades": [
    {
      "questionNo": "26",
      "earnedScore": 8,
      "questionComment": "对本题给分的简要说明",
      "requiresReview": false,
      "subReviews": [
        {
          "label": "（1）小题",
          "score": 2,
          "fullScore": 2,
          "comment": "对第（1）小题的整体点评，只点评这一个小题，不要逐句点评",
          "matchedExcerpts": ["必须是学生原文中的精确片段", "同一小题中另外一个命中片段"]
        },
        {
          "label": "（2）小题",
          "score": 1,
          "fullScore": 2,
          "comment": "对第（2）小题的整体点评，只点评这一个小题，不要逐句点评",
          "matchedExcerpts": ["第（2）小题中命中的学生原文精确片段"]
        }
      ],
      "annotations": {
        "matches": ["学生原文中的命中片段，用于绿色波浪线、打勾和加分展示"],
        "errors": [
          {
            "excerpt": "学生原文中的错误片段，用于红框标注",
            "reason": "错误原因，只解释该片段"
          }
        ]
      }
    }
  ]
}`;
}

function getRoleTonePrompt(settings) {
  const customRolePrompt = normalizeFreeText(settings?.customRolePrompt);
  const withCustomTone = (base) => (customRolePrompt ? `${base} 额外风格要求：${customRolePrompt}` : base);

  if (settings?.rolePreset === 'strict') {
    return withCustomTone('保持教师阅卷口吻，结论明确，但不要夸张或讽刺。');
  }
  if (settings?.rolePreset === 'gentle') {
    return withCustomTone('评价语气可以温和、鼓励，像有耐心的历史老师或助教，但分数必须严格。');
  }
  if (settings?.rolePreset === 'custom' && customRolePrompt) {
    return customRolePrompt;
  }
  return withCustomTone('保持客观、克制、专业的阅卷口吻。');
}

function getRoleBasedQuestionFallback(settings) {
  const customRolePrompt = normalizeFreeText(settings?.customRolePrompt);
  const isWarmCustom = /(温柔|鼓励|支持|信心|勇气|陪伴|助教|亲切|耐心)/.test(customRolePrompt);

  if (settings?.rolePreset === 'strict') {
    return '本题已完成评分。请根据失分点尽快回到教材，补齐关键史实与概念。';
  }
  if (settings?.rolePreset === 'gentle' || isWarmCustom) {
    return '本题已完成评分。你已经有基础，再把失分点逐条补齐会进步很快。';
  }
  if (settings?.rolePreset === 'custom' && customRolePrompt) {
    return '本题已完成评分。请结合失分点继续针对性复习，把关键采分点答得更完整。';
  }
  return '本题已完成评分。建议围绕失分采分点进行针对性复习。';
}

function getRoleBasedOverallFallback(settings) {
  const customRolePrompt = normalizeFreeText(settings?.customRolePrompt);
  const isWarmCustom = /(温柔|鼓励|支持|信心|勇气|陪伴|助教|亲切|耐心)/.test(customRolePrompt);

  if (settings?.rolePreset === 'strict') {
    return '本轮主观题批改已完成。请按失分最多的知识点优先复习，并在下次作答时按要点分句呈现。';
  }
  if (settings?.rolePreset === 'gentle' || isWarmCustom) {
    return '本轮主观题批改已完成。你已经有不错基础，建议先抓最薄弱的要点，逐条巩固。';
  }
  if (settings?.rolePreset === 'custom' && customRolePrompt) {
    return '本轮主观题批改已完成。请按失分点梳理复习顺序，把最容易漏掉的知识先补上。';
  }
  return '本轮主观题批改已完成。建议按失分点制定复习优先级，逐条查漏补缺。';
}

function buildSubjectivePrompt({ settings, task, student, questions }) {
  const ordinaryRule = normalizeFreeText(settings?.subjectiveOrdinaryRulePrompt) || DEFAULT_SUBJECTIVE_ORDINARY_RULE_PROMPT;
  const essayRule = normalizeFreeText(settings?.subjectiveEssayRulePrompt) || DEFAULT_SUBJECTIVE_ESSAY_RULE_PROMPT;
  const questionBlocks = questions
    .map((question, index) => {
      const typeLabel = question.type === 'essay' ? '论述题' : '普通型主观题';
      const backendRule = question.type === 'essay' ? essayRule : ordinaryRule;
      return [
        `【题目 ${index + 1}】`,
        `题号：${question.questionNo}`,
        `题型：${typeLabel}`,
        `满分：${question.score}`,
        '题目：',
        normalizeFreeText(question.content) || '未填写题目原文',
        '参考答案：',
        normalizeFreeText(question.standardAnswer) || '未填写参考答案',
        '阅卷要求：',
        normalizeFreeText(question.gradingRule) || '未单独填写阅卷要求',
        '后台规则：',
        backendRule,
        '学生作答原文：',
        normalizeFreeText(question.studentAnswer) || '未作答',
      ].join('\n');
    })
    .join('\n\n');

  return [
    `任务名称：${normalizeFreeText(task?.name) || '未命名任务'}`,
    `班级：${normalizeFreeText(task?.className) || '未选择班级'}`,
    `学生：${normalizeFreeText(student?.studentName) || '未命名学生'}`,
    '你要批改的是高中历史主观题。',
    '必须先读题目，再读参考答案，再读阅卷要求和后台规则，最后只依据学生原文评分。',
    '禁止补写学生未写出的观点，禁止因为文采好就替代知识点命中。',
    '如果题目阅卷要求与后台规则冲突，以题目阅卷要求为准。',
    getRoleTonePrompt(settings),
    '输出要求：',
    '1. 只能输出 JSON，不要输出任何解释。',
    '2. annotations.matches 和 annotations.errors[*].excerpt 必须是学生原文中的精确片段。',
    '3. annotations 只负责句子或词语级标注：命中片段放进 annotations.matches，错误片段放进 annotations.errors。不要把点评写进 annotations。',
    '4. 普通型主观题的 subReviews 只能按“小题”返回，不能按一句话、一个采分点、一个短语分别写点评。如果题目有（1）（2）（3），就只返回（1）小题、（2）小题、（3）小题这几条点评。',
    '5. 普通型主观题每个 subReview.comment 必须是对应整道小题的总评，不得逐句点评；该小题命中的多个得分点、存在的问题，都合并写进这一条 comment。',
    '6. 普通型主观题的 subReview.label 必须优先写成“（1）小题”“（2）小题”“（3）小题”这种格式；matchedExcerpts 可以列出该小题里命中的多个学生原文片段。',
    '7. 论述题的 subReviews 只按“论题、方面一、方面二、方面三、结论”这些结构返回，不要按单句拆开；逻辑或史实问题优先并入对应部分的 comment，只有确实无法并入时才额外增加扣分项。',
    '8. earnedScore 必须是最终得分，不能超过满分，也不能低于 0。',
    '9. subReviews[*].comment、questionComment、overallComment 必须统一使用后台角色风格（严厉导师/温和助教/客观考官/自定义角色）。',
    '10. 小题点评与总评都要可指导学习：先肯定亮点，再指出薄弱点，并给出至少 1 条可执行复习建议。',
    `JSON 模板：\n${getSubjectiveSchemaHint()}`,
    '',
    questionBlocks,
  ].join('\n');
}

function getSubjectiveSchemaHintV2() {
  return `{
  "overallComment": "本轮主观题总评（结合优点、短板与复习建议）",
  "questionGrades": [
    {
      "questionNo": "26",
      "earnedScore": 8,
      "questionComment": "本题总评（学习导向）",
      "requiresReview": false,
      "awardedPoints": [
        {
          "subquestionIndex": 1,
          "pointLabel": "户籍管理",
          "score": 1,
          "unitIds": [0],
          "excerpt": "查核百姓户口"
        }
      ],
      "errors": [
        {
          "subquestionIndex": 2,
          "unitIds": [3],
          "excerpt": "错误表述原文",
          "reason": "错误原因"
        }
      ],
      "sectionComments": [
        {
          "subquestionIndex": 1,
          "sectionLabel": "（1）小题",
          "comment": "本小题点评（先肯定，再指出不足，再给可执行建议）"
        }
      ],
      "pointReviews": [
        {
          "subquestionIndex": 1,
          "sectionLabel": "（1）小题",
          "pointLabel": "加强皇权",
          "score": 2,
          "fullScore": 2,
          "comment": "该采分点点评",
          "matchedExcerpts": ["学生原文中的精确命中片段"]
        }
      ],
      "annotations": {
        "matches": ["学生原文中的命中片段"],
        "errors": [
          {
            "excerpt": "学生原文中的错误片段",
            "reason": "错误原因"
          }
        ]
      }
    }
  ]
}`;
}

function buildQuestionSubquestionSchema(question) {
  const sections = extractQuestionSubquestionCatalog(question);
  return JSON.stringify(
    sections.map((section) => ({
      subquestionIndex: Number(section.order || 0),
      sectionLabel: normalizeFreeText(section.label) || `（${Number(section.order || 1)}）小题`,
      fullScore: Number(section.fullScore || 0),
      prompt: normalizeFreeText(section.prompt) || '',
    })),
    null,
    2,
  );
}

function getSubjectiveStructuredSchemaHint() {
  return `{
  "overallComment": "整轮主观题总评",
  "questionGrades": [
    {
      "questionNo": "26",
      "earnedScore": 8,
      "questionComment": "本题总评",
      "requiresReview": false,
      "awardedPoints": [
        {
          "subquestionIndex": 1,
          "pointLabel": "户籍管理",
          "score": 1,
          "unitIds": [0],
          "excerpt": "查核百姓户口"
        }
      ],
      "errors": [
        {
          "subquestionIndex": 2,
          "unitIds": [3],
          "excerpt": "错误表述原文",
          "reason": "错误原因"
        }
      ],
      "sectionComments": [
        {
          "subquestionIndex": 1,
          "sectionLabel": "（1）小题",
          "comment": "本小题点评"
        }
      ],
      "pointReviews": [
        {
          "subquestionIndex": 1,
          "sectionLabel": "（1）小题",
          "pointLabel": "加强皇权",
          "score": 2,
          "fullScore": 2,
          "comment": "采分点点评",
          "matchedExcerpts": ["学生原文中的精确命中片段"]
        }
      ],
      "annotations": {
        "matches": ["学生原文中的命中片段"],
        "errors": [
          {
            "excerpt": "学生原文中的错误片段",
            "reason": "错误原因"
          }
        ]
      }
    },
    {
      "questionNo": "52",
      "earnedScore": 5,
      "questionComment": "论题明确，第1段缺少小标题引导。",
      "requiresReview": false,
      "essayReview": {
        "thesis": {
          "label": "论题",
          "score": 2,
          "fullScore": 2,
          "excerpt": "论题：中华文明具有创新性。",
          "comment": "有论题，论题切题，但还可以进一步写得更聚焦。",
          "tags": ["有论题", "论题切题、合适"],
          "issues": ["论题表述不够聚焦"],
          "factualErrors": [],
          "criteriaResults": [
            {
              "code": "has_thesis",
              "label": "是否有论题",
              "passed": true,
              "positiveTag": "有论题",
              "negativeTag": "缺少论题",
              "suggestion": ""
            },
            {
              "code": "object_correct",
              "label": "对象是否正确",
              "passed": true,
              "positiveTag": "对象准确",
              "negativeTag": "对象有误",
              "suggestion": ""
            },
            {
              "code": "judgment_correct",
              "label": "判断是否正确",
              "passed": false,
              "positiveTag": "判断到位",
              "negativeTag": "判断不到位",
              "suggestion": "可改为：中华文明在传承中不断吸收外来因素并形成创新发展。"
            }
          ],
          "keywordGroupMatches": [
            {
              "id": "group-1",
              "label": "创新发展",
              "type": "judgment",
              "required": true,
              "matched": true,
              "matchedExpressions": ["创新性"],
              "missingExpressions": []
            },
            {
              "id": "group-2",
              "label": "传承与发展",
              "type": "judgment",
              "required": true,
              "matched": false,
              "matchedExpressions": [],
              "missingExpressions": ["传承中发展"]
            }
          ],
          "suggestedText": "中华文明在传承中不断吸收外来因素并形成创新发展。",
          "replacementThesis": "中华文明在长期传承中不断吸收外来因素，实现了持续创新发展。",
          "checks": {
            "hasThesis": true,
            "isObjectCorrect": true,
            "isJudgmentCorrect": false,
            "factualErrorCount": 0,
            "matchedObjectGroupCount": 0,
            "matchedJudgmentGroupCount": 1
          }
        },
        "bodySections": [
          {
            "label": "第1段",
            "score": 2,
            "fullScore": 3,
            "excerpt": "第一，……",
            "comment": "本段围绕论题展开，也有史实支撑，但段首缺少小标题，解释还能再落到论题上。",
            "tags": ["围绕论题展开", "史料充分"],
            "issues": ["缺少小标题引导"],
            "factualErrors": [],
            "criteriaResults": [
              {
                "code": "focus_on_thesis",
                "label": "是否围绕论题",
                "passed": true,
                "positiveTag": "围绕论题展开",
                "negativeTag": "没有围绕论题展开",
                "suggestion": ""
              },
              {
                "code": "within_scope",
                "label": "是否符合时空范围",
                "passed": true,
                "positiveTag": "时空范围准确",
                "negativeTag": "超出时空范围",
                "suggestion": ""
              },
              {
                "code": "has_heading",
                "label": "是否有本段落小标题",
                "passed": false,
                "positiveTag": "有小标题",
                "negativeTag": "缺少小标题",
                "suggestion": "可补一个能概括本段核心意思的小标题。"
              },
              {
                "code": "has_evidence",
                "label": "是否有具体史实",
                "passed": true,
                "positiveTag": "史料充分",
                "negativeTag": "缺少必要史实",
                "suggestion": ""
              },
              {
                "code": "has_argument",
                "label": "是否围绕史实展开合理说明",
                "passed": false,
                "positiveTag": "说明和解释准确合理",
                "negativeTag": "不准确不合理的论述过程",
                "suggestion": "需要把史实和“中华文明具有创新性”之间的关系解释得更直接。"
              },
              {
                "code": "factual_error",
                "label": "是否史实准确",
                "passed": true,
                "positiveTag": "史实准确无硬伤",
                "negativeTag": "有史实错误",
                "suggestion": "",
                "count": 0
              }
            ],
            "suggestedText": "第一段（创新吸收）：“丝绸之路开通后，中原王朝不断吸收西域物产与技术，并把外来因素转化为本土制度和文化成果。这说明中华文明不是封闭停滞的，而是在交流中持续创新发展。”",
            "checks": {
              "focusedOnThesis": true,
              "isWithinScope": true,
              "matchedScopeGroupCount": 0,
              "hasHeading": false,
              "hasHistoricalEvidence": true,
              "hasReasonableExplanation": false,
              "hasAnalysis": false,
              "isFactuallyAccurate": true,
              "factualErrorCount": 0
            }
          }
        ],
        "conclusion": {
          "label": "结论",
          "score": 1,
          "fullScore": 2,
          "excerpt": "综上，……",
          "comment": "已有结论，但结尾缺少进一步升华。",
          "tags": ["有结论"],
          "issues": ["缺少升华"],
          "factualErrors": [],
          "criteriaResults": [
            {
              "code": "has_summary",
              "label": "是否有结论",
              "passed": true,
              "positiveTag": "有结论",
              "negativeTag": "缺少结论",
              "suggestion": ""
            },
            {
              "code": "has_elevation",
              "label": "是否有升华",
              "passed": false,
              "positiveTag": "有升华",
              "negativeTag": "缺少升华",
              "suggestion": "可补上一句：这说明中华文明能够在传承中不断创新，也是其绵延不绝的重要原因。"
            }
          ],
          "suggestedText": "综上所述，中华文明并不是一成不变的，而是在长期发展中不断吸收、整合并创新外来与本土因素。这说明中华文明具有强大的延续力与创造力，也启示我们应以开放包容的态度看待文明发展。",
          "checks": {
            "hasConclusion": true,
            "hasSummary": true,
            "hasElevation": false,
            "factualErrorCount": 0
          }
        }
      },
      "annotations": {
        "matches": [],
        "errors": [
          {
            "excerpt": "学生原文中的史实错误片段",
            "reason": "史实错误"
          }
        ]
      }
    }
  ]
}`;
}

function formatEssayCriteriaForPrompt(criteria = []) {
  return (Array.isArray(criteria) ? criteria : []).map((criterion) => ({
    code: normalizeFreeText(criterion?.code) || 'custom',
    label: normalizeFreeText(criterion?.label) || '(empty)',
    penaltyMode: normalizeFreeText(criterion?.penaltyMode) || 'deduct',
    penaltyValue: Math.max(0, Number(criterion?.penaltyValue || 0)),
    penaltyMeasure: normalizeFreeText(criterion?.penaltyMeasure) || 'once',
  }));
}

function buildEssaySectionSchema(question) {
  const plan = buildEssaySectionPlan(question, question?.studentAnswer || '');
  const essayRuleTree = question?.essayRuleTree ? normalizeEssayRuleTree(question.essayRuleTree, question) : null;
  return JSON.stringify(
    {
      globalOffTopicCap: Math.max(0, Number(plan.globalOffTopicCap || essayRuleTree?.globalOffTopicCap || 0)),
      thesis: {
        label: '论题',
        fullScore: plan.thesisFullScore,
        thesisTemplates: plan.thesisTemplates || essayRuleTree?.thesis?.templates || [],
        keywordGroups: (essayRuleTree?.thesis?.keywordGroups || [])
          .filter((group) => group?.enabled !== false)
          .map((group) => ({
            id: normalizeFreeText(group?.id) || '',
            label: normalizeFreeText(group?.label) || '',
            type: normalizeFreeText(group?.type) || 'judgment',
            required: group?.required !== false,
            expressions: uniqueTextItems((group?.expressions || []).map((item) => normalizeFreeText(item?.text || '')), 10),
          })),
        criteria: formatEssayCriteriaForPrompt(plan.thesisCriteria || essayRuleTree?.thesis?.criteria || []),
      },
      bodySections: plan.bodySectionScores.map((score, index) => ({
        label: plan.bodySectionLabels?.[index] || `第${index + 1}段`,
        fullScore: score,
        scopeKeywordGroups: (essayRuleTree?.body?.paragraphs?.[index]?.scopeKeywordGroups || [])
          .filter((group) => group?.enabled !== false)
          .map((group) => ({
            id: normalizeFreeText(group?.id) || '',
            label: normalizeFreeText(group?.label) || '',
            type: 'scope',
            required: group?.required !== false,
            expressions: uniqueTextItems((group?.expressions || []).map((item) => normalizeFreeText(item?.text || '')), 10),
          })),
        criteria: formatEssayCriteriaForPrompt(plan.bodyCriteria?.[index] || essayRuleTree?.body?.paragraphs?.[index]?.criteria || []),
      })),
      conclusion: {
        label: '结论',
        fullScore: plan.conclusionFullScore,
        criteria: formatEssayCriteriaForPrompt(plan.conclusionCriteria || essayRuleTree?.conclusion?.criteria || []),
      },
    },
    null,
    2,
  );
}

function buildSubjectivePromptV2({ settings, task, student, questions }) {
  const ordinaryRule = normalizeFreeText(settings?.subjectiveOrdinaryRulePrompt) || DEFAULT_SUBJECTIVE_ORDINARY_RULE_PROMPT;
  const essayRule = normalizeFreeText(settings?.subjectiveEssayRulePrompt) || DEFAULT_SUBJECTIVE_ESSAY_RULE_PROMPT;
  const questionBlocks = questions
    .map((question, index) => {
      const typeLabel = question.type === 'essay' ? 'essay' : 'subjective';
      const backendRule = question.type === 'essay' ? essayRule : ordinaryRule;
      const answerUnits = question.type === 'essay' ? [] : buildIndexedAnswerUnits(question, question.studentAnswer);
      return [
        `[Question ${index + 1}]`,
        `questionNo: ${question.questionNo}`,
        `questionType: ${typeLabel}`,
        `fullScore: ${question.score}`,
        question.type === 'essay' ? 'essaySectionSchema:' : 'subquestionSchema:',
        question.type === 'essay' ? buildEssaySectionSchema(question) : buildQuestionSubquestionSchema(question),
        'questionContent:',
        normalizeFreeText(question.content) || '(empty)',
        'standardAnswer:',
        normalizeFreeText(question.standardAnswer) || '(empty)',
        'gradingRule:',
        normalizeFreeText(question.gradingRule) || '(empty)',
        question.type === 'essay' ? 'essayRuleTree:' : 'gradingRuleTree:',
        JSON.stringify(question.type === 'essay' ? (question.essayRuleTree || null) : (question.gradingRuleTree || null), null, 2),
        'backendRule:',
        backendRule,
        question.type === 'essay' ? 'studentAnswer:' : 'answerUnits:',
        question.type === 'essay' ? (normalizeFreeText(question.studentAnswer) || '(blank)') : formatIndexedAnswerUnits(answerUnits),
      ].join('\n');
    })
    .join('\n\n');

  return [
    `taskName: ${normalizeFreeText(task?.name) || '(unnamed task)'}`,
    `className: ${normalizeFreeText(task?.className) || '(unknown class)'}`,
    `studentName: ${normalizeFreeText(student?.studentName) || '(unknown student)'}`,
    `roleStyle: ${getRoleTonePrompt(settings)}`,
    'You are grading high-school history subjective answers.',
    'Hard constraints:',
    '1. Output strict JSON only (no markdown / no explanation).',
    '2. Score only by student original text; do not add missing viewpoints.',
    '3. For ordinary subjective questions, grade by answerUnits. Use awardedPoints and errors as the primary output.',
    '4. Every awardedPoints[*].unitIds value must reference the provided answerUnits ids.',
    '5. Every awardedPoints[*].excerpt must be an exact continuous substring copied from one referenced answer unit.',
    '6. If one answer unit hits multiple scoring points, return multiple awardedPoints for that same unit.',
    '7. Do not award any ordinary-question score unless it is grounded in a specific answer unit.',
    '8. errors are markup only: mark wrong expressions, but do not deduct score for ordinary subjective questions.',
    '9. For essay questions, return essayReview as the main structure instead of ordinary pointReviews.',
    '10. essayReview must contain thesis, bodySections, and conclusion. The number of bodySections must follow essaySectionSchema / essayRuleTree.',
    '11. essayReview.thesis/bodySections[*]/conclusion.excerpt must each be an exact continuous substring copied from studentAnswer.',
    '12. For essay questions, respect essaySectionSchema fullScore values and each section criteria when assigning thesis/body/conclusion scores.',
    '13. For thesis, explicitly judge: whether there is a thesis, whether it matches the prompt, whether the historical object is correct, whether the required historical judgment is correct, and whether the thesis sentence itself hits required object/judgment keyword groups in essaySectionSchema.thesis.keywordGroups. Do not judge thesis time-space scope.',
    '14. For each essay body section, explicitly judge: whether it stays on thesis, whether it stays within the required time-space scope using essaySectionSchema.bodySections[*].scopeKeywordGroups when provided, whether it has a heading, whether it has specific historical evidence, whether it explains the evidence through effect/mechanism/causality, whether it links that explanation back to the thesis or paragraph claim, and whether there are factual errors.',
    '15. For conclusion, explicitly judge whether there is a conclusion and whether there is elevation/insight.',
    '16. essayReview.thesis/bodySections[*]/conclusion must return criteriaResults. Each failed criterion must include a concrete suggestion. For thesis, missing/off-topic/inappropriate thesis should produce a suggestedText. For any body section with one or more failed criteria, suggestedText must contain a revised paragraph based on the student answer. For conclusion, missing conclusion or missing elevation should produce a suggestedText.',
    '17. If the thesis is off-topic or clearly triggers the configured off-topic cap, mark that in checks/tags/issues/criteriaResults and keep the final score within the configured total cap.',
    '18. If a body paragraph is off-topic or beyond the required time-space scope, its score should be 0. Otherwise follow the configured criteria penalties: no heading, no evidence, no effect/mechanism/causality explanation, no link back to thesis, factual errors, and any teacher-added custom criteria.',
    '19. Essay comments must stay within 1-2 sentences: brief evaluation plus one concrete suggestion. Do not restate the full excerpt.',
    '20. Do NOT repeat scoring-point labels, scores, point-by-point explanations, matched excerpts, or text like "采分点 2/2 分" inside sectionComments.',
    '21. If pointReviews already show the scoring points, sectionComments should not restate them.',
    '22. pointReviews[*].pointLabel and awardedPoints[*].pointLabel should be short semantic phrases such as "加强皇权" or "推动经济发展"; do NOT use labels like "采分点1/2/3".',
    `JSON schema:\n${getSubjectiveStructuredSchemaHint()}`,
    '',
    questionBlocks,
  ].join('\n');
}

function buildSubjectivePromptStructuredV2({ settings, task, student, questions }) {
  const ordinaryRule = normalizeFreeText(settings?.subjectiveOrdinaryRulePrompt) || DEFAULT_SUBJECTIVE_ORDINARY_RULE_PROMPT;
  const essayRule = normalizeFreeText(settings?.subjectiveEssayRulePrompt) || DEFAULT_SUBJECTIVE_ESSAY_RULE_PROMPT;
  const questionBlocks = questions
    .map((question, index) => {
      const typeLabel = question.type === 'essay' ? 'essay' : 'subjective';
      const backendRule = question.type === 'essay' ? essayRule : ordinaryRule;
      const answerUnits = question.type === 'essay' ? [] : buildIndexedAnswerUnits(question, question.studentAnswer);
      return [
        `[Question ${index + 1}]`,
        `questionNo: ${question.questionNo}`,
        `questionType: ${typeLabel}`,
        `fullScore: ${question.score}`,
        question.type === 'essay' ? 'essaySectionSchema:' : 'subquestionSchema:',
        question.type === 'essay' ? buildEssaySectionSchema(question) : buildQuestionSubquestionSchema(question),
        'questionContent:',
        normalizeFreeText(question.content) || '(empty)',
        'standardAnswer:',
        normalizeFreeText(question.standardAnswer) || '(empty)',
        'gradingRule:',
        normalizeFreeText(question.gradingRule) || '(empty)',
        question.type === 'essay' ? 'essayRuleTree:' : 'gradingRuleTree:',
        JSON.stringify(question.type === 'essay' ? (question.essayRuleTree || null) : (question.gradingRuleTree || null), null, 2),
        'backendRule:',
        backendRule,
        question.type === 'essay' ? 'studentAnswer:' : 'answerUnits:',
        question.type === 'essay' ? (normalizeFreeText(question.studentAnswer) || '(blank)') : formatIndexedAnswerUnits(answerUnits),
      ].join('\n');
    })
    .join('\n\n');

  return [
    `taskName: ${normalizeFreeText(task?.name) || '(unnamed task)'}`,
    `className: ${normalizeFreeText(task?.className) || '(unknown class)'}`,
    `studentName: ${normalizeFreeText(student?.studentName) || '(unknown student)'}`,
    `roleStyle: ${getRoleTonePrompt(settings)}`,
    'You are grading high-school history subjective answers.',
    'Hard constraints:',
    '1. Output strict JSON only (no markdown / no explanation).',
    '2. Score only by student original text; do not add missing viewpoints.',
    '3. For ordinary subjective questions, grade by answerUnits. Use awardedPoints and errors as the primary output.',
    '4. Every awardedPoints[*].unitIds value must reference the provided answerUnits ids.',
    '5. Every awardedPoints[*].excerpt must be an exact continuous substring copied from one referenced answer unit.',
    '6. If one answer unit hits multiple scoring points, return multiple awardedPoints for that same unit.',
    '7. Do not award any ordinary-question score unless it is grounded in a specific answer unit.',
    '8. errors are markup only: mark wrong expressions, but do not deduct score for ordinary subjective questions.',
    '9. For essay questions, return essayReview as the main structure instead of ordinary pointReviews.',
    '10. essayReview must contain thesis, bodySections, and conclusion. The number of bodySections must follow essaySectionSchema / essayRuleTree.',
    '11. essayReview.thesis/bodySections[*]/conclusion.excerpt must each be an exact continuous substring copied from studentAnswer.',
    '12. For essay questions, respect essaySectionSchema fullScore values and each section criteria when assigning thesis/body/conclusion scores.',
    '13. For thesis, explicitly judge only these configured thesis criteria: whether there is a thesis, whether the historical object is correct, and whether the required historical judgment is correct. Do not judge thesis time-space scope.',
    '14. For each essay body section, explicitly judge: whether it stays on thesis, whether it stays within the required time-space scope using essaySectionSchema.bodySections[*].scopeKeywordGroups when provided, whether it has a heading, whether it has specific historical evidence, whether it explains the evidence through effect/mechanism/causality, whether it links that explanation back to the thesis or paragraph claim, and whether there are factual errors.',
    '15. For conclusion, explicitly judge whether there is a conclusion and whether there is elevation/insight.',
    '16. Always fill essayReview.thesis.checks.hasThesis/isObjectCorrect/isJudgmentCorrect/matchedObjectGroupCount/matchedJudgmentGroupCount, each bodySections[*].checks.focusedOnThesis/isWithinScope/matchedScopeGroupCount/hasHeading/hasHistoricalEvidence/explainsEvidence/linksBackToThesis/hasReasonableExplanation/hasAnalysis/isFactuallyAccurate/factualErrorCount, and conclusion.checks.hasConclusion/hasSummary/hasElevation explicitly. Use true/false/0 even when the criterion passes.',
    '17. essayReview.thesis must return keywordGroupMatches. Each keywordGroupMatches item should say whether that keyword group is matched, which expressions are matched, and which are still missing. Only judge keyword matches inside the thesis excerpt itself; do not use body paragraphs to help the thesis pass.',
    '18. essayReview.thesis/bodySections[*]/conclusion must return criteriaResults. Each item should be yes/no style, include positiveTag and negativeTag, and every failed item must include a concrete suggestion. criteriaResults[*].code should match essaySectionSchema criteria code whenever possible.',
    '19. For thesis, missing thesis, wrong object, wrong judgment, or missing keyword groups should produce suggestedText and replacementThesis. For any body section with one or more failed criteria, including beyond-scope body content, suggestedText must contain a revised paragraph based on the student answer. For conclusion, missing conclusion or missing elevation should produce a suggestedText.',
    '20. If thesis clearly triggers the configured off-topic cap, mark that in checks/tags/issues/criteriaResults and keep the final score within the configured total cap.',
    '21. If the thesis does not hit any judgment keyword group, thesis score cannot be full score. If object keyword groups are configured but none are hit, thesis should also not receive full score.',
    '22. If a body paragraph is off-topic or beyond the required time-space scope, its score should be 0. Otherwise follow the configured criteria penalties: no heading, no evidence, no effect/mechanism/causality explanation, no link back to thesis, factual errors, and any teacher-added custom criteria.',
    '23. Essay tags must not hide passed criteria. Keep short positive tags for satisfied criteria and short negative tags or issues for failed criteria, so the frontend can show all thesis/body/conclusion standards clearly.',
    '24. Essay comments must stay within 1-2 sentences: brief evaluation plus one concrete suggestion. Do not restate the full excerpt.',
    '25. annotations.matches and annotations.errors[*].excerpt must be exact spans from studentAnswer.',
    '26. For essay questions, annotations.matches can be empty because the frontend no longer displays inline scoring marks.',
    '27. annotations.errors must only cover wrong expressions; do not swallow nearby correct snippets.',
    '28. The final earnedScore must equal the sum of essayReview.thesis/bodySections/conclusion scores or awardedPoints scores, and it must not exceed fullScore.',
    `JSON schema:\n${getSubjectiveStructuredSchemaHint()}`,
    '',
    questionBlocks,
  ].join('\n');
}

function buildMissingSubjectiveResult(questionNo, reason) {
  return {
    questionNo,
    earnedScore: 0,
    questionComment: reason,
    requiresReview: /复核|冲突/.test(reason),
    pointReviews: [],
    sectionComments: [],
    subReviews: [],
    displaySubReviews: [],
    annotations: {
      matches: [],
      errors: [],
    },
  };
}

async function requestSubjectiveGradingPass({ settings, profile, task, student, questions, passLabel }) {
  const payload = await chatCompletion({
    settings,
    profile,
    temperature: 0,
    maxTokens: 4200,
    messages: [
      {
        role: 'system',
        content:
          '你是高中历史主观题阅卷助手。你只能依据学生作答原文评分，不能补写学生没有写出的观点，不能用文采代替知识点命中，必须严格输出 JSON。',
      },
      {
        role: 'user',
        content: buildSubjectivePromptStructuredV2({
          settings,
          task,
          student,
          questions,
        }),
      },
    ],
  });

  const parsed = await parseModelJson({
    settings,
    profile,
    raw: getContentFromCompletion(payload),
    schemaHint: getSubjectiveStructuredSchemaHint(),
    debugContext: {
      flow: 'subjective-grading',
      taskId: task?.id,
      taskName: task?.name,
      studentName: student?.studentName,
      questionNos: questions.map((question) => question.questionNo),
      selectedModel: payload.__selectedModel || '',
      passLabel,
    },
  });

  return {
    payload,
    parsed,
  };
}

async function buildSubjectiveGradingResult({
  settings,
  profile,
  task,
  student,
  questions,
  fallbackMap,
  parsed,
  selectedModel,
}) {
  const parsedMap = new Map(
    (Array.isArray(parsed?.questionGrades) ? parsed.questionGrades : [])
      .map((item) => [String(item?.questionNo ?? '').trim(), item])
      .filter(([questionNo]) => questionNo),
  );

  const questionGrades = [];
  for (const question of questions) {
    const parsedItem = parsedMap.get(question.questionNo);
    if (!parsedItem) {
      questionGrades.push(
        fallbackMap.get(question.questionNo) || buildMissingSubjectiveResult(question.questionNo, '模型未返回该题结构化评分结果，建议人工复核。'),
      );
      continue;
    }

    const earnedScoreRaw = Number(parsedItem?.earnedScore ?? 0);
    const answerUnits = question.type === 'essay' ? [] : buildIndexedAnswerUnits(question, question.studentAnswer);
    const rawIndexedAwardedPoints = question.type === 'essay'
      ? []
      : (Array.isArray(parsedItem?.awardedPoints) ? parsedItem.awardedPoints : []);
    const indexedAwardedPoints = question.type === 'essay'
      ? []
      : rawIndexedAwardedPoints
        .map((item, index) => sanitizeIndexedAwardedPoint(item, index, answerUnits))
        .filter(Boolean);
    const rawIndexedErrors = question.type === 'essay'
      ? []
      : (Array.isArray(parsedItem?.errors) ? parsedItem.errors : []);
    const indexedErrors = question.type === 'essay'
      ? []
      : rawIndexedErrors
        .map((item) => sanitizeIndexedError(item, answerUnits))
        .filter(Boolean);
    const useIndexedOrdinaryOutput =
      question.type !== 'essay' && (Array.isArray(parsedItem?.awardedPoints) || Array.isArray(parsedItem?.errors));

    if (useIndexedOrdinaryOutput) {
      const invalidAwardedPointCount = Math.max(0, rawIndexedAwardedPoints.length - indexedAwardedPoints.length);
      const invalidErrorCount = Math.max(0, rawIndexedErrors.length - indexedErrors.length);
      const basePointReviews = indexedAwardedPoints.map((point, index) => sanitizePointReview({
        subquestionIndex: point.subquestionIndex,
        sectionLabel: point.sectionLabel,
        pointLabel: point.pointLabel,
        score: point.score,
        fullScore: point.fullScore,
        comment: '',
        matchedExcerpts: [point.excerpt],
      }, index));
      const repairedPointReviews = await repairStructuredOrdinaryPointReviews({
        settings,
        profile,
        task,
        student,
        question,
        answer: question.studentAnswer,
        existingPointReviews: basePointReviews,
      });
      const pointReviews = [...basePointReviews, ...repairedPointReviews];
      const subReviews = pointReviews.map((review, index) => pointReviewToLegacySubReview(review, index));
      const indexedPointScoreSum = pointReviews.reduce((sum, item) => sum + Number(item.score || 0), 0);
      const indexedRequiresReview =
        Boolean(parsedItem?.requiresReview)
        || invalidAwardedPointCount > 0
        || invalidErrorCount > 0
        || (earnedScoreRaw > 0 && pointReviews.length === 0);
      const ordinaryQuestionComment = indexedRequiresReview
        ? '模型已返回部分评分信息，但结构不完整，建议人工复核。'
        : '';

      questionGrades.push({
        questionNo: question.questionNo,
        earnedScore: Math.max(0, Math.min(question.score, indexedPointScoreSum)),
        questionComment: ordinaryQuestionComment,
        requiresReview: indexedRequiresReview,
        pointReviews,
        sectionComments: [],
        subReviews,
        displaySubReviews: buildDisplaySubReviews(question, subReviews),
        annotations: {
          matches: uniqueTextItems(pointReviews.flatMap((review) => review.matchedExcerpts || []), 6),
          errors: sanitizeAnnotationErrors(indexedErrors),
        },
      });
      continue;
    }

    if (question.type === 'essay') {
      const parsedSubReviews = (Array.isArray(parsedItem?.subReviews) ? parsedItem.subReviews : []).map(sanitizeSubReview);
      const parsedPointReviews = (Array.isArray(parsedItem?.pointReviews) ? parsedItem.pointReviews : []).map(sanitizePointReview);
      const sectionComments = (Array.isArray(parsedItem?.sectionComments) ? parsedItem.sectionComments : [])
        .map(sanitizeSectionComment)
        .filter((item) => item.comment);
      const subReviews = parsedSubReviews.length
        ? parsedSubReviews
        : parsedPointReviews.map((review, index) => pointReviewToLegacySubReview(review, index));
      const hasEssayReview = parsedItem?.essayReview && typeof parsedItem.essayReview === 'object';
      const essayRequiresReview = Boolean(parsedItem?.requiresReview) || !hasEssayReview;

      questionGrades.push({
        questionNo: question.questionNo,
        earnedScore: Math.max(0, Math.min(question.score, Number.isFinite(earnedScoreRaw) ? earnedScoreRaw : 0)),
        questionComment: normalizeFreeText(parsedItem?.questionComment)
          || (essayRequiresReview ? '模型未返回该题完整结构化评分结果，建议人工复核。' : getRoleBasedQuestionFallback(settings)),
        requiresReview: essayRequiresReview,
        essayReview: hasEssayReview ? parsedItem.essayReview : null,
        pointReviews: parsedPointReviews,
        sectionComments,
        subReviews,
        displaySubReviews: buildDisplaySubReviews(question, subReviews),
        annotations: {
          matches: uniqueTextItems(parsedItem?.annotations?.matches, 8),
          errors: sanitizeAnnotationErrors(parsedItem?.annotations?.errors),
        },
      });
      continue;
    }

    const parsedSubReviews = (Array.isArray(parsedItem?.subReviews) ? parsedItem.subReviews : []).map(sanitizeSubReview);
    const parsedPointReviews = (Array.isArray(parsedItem?.pointReviews) ? parsedItem.pointReviews : []).map(sanitizePointReview);
    const basePointReviews = parsedPointReviews.length
      ? parsedPointReviews
      : parsedSubReviews.map((review, index) => legacySubReviewToPointReview(review, index));
    const repairedPointReviews = await repairStructuredOrdinaryPointReviews({
      settings,
      profile,
      task,
      student,
      question,
      answer: question.studentAnswer,
      existingPointReviews: basePointReviews,
    });
    const pointReviews = [...basePointReviews, ...repairedPointReviews];
    const sectionComments = (Array.isArray(parsedItem?.sectionComments) ? parsedItem.sectionComments : [])
      .map(sanitizeSectionComment)
      .filter((item) => item.comment);
    const subReviews = parsedSubReviews.length
      ? parsedSubReviews
      : pointReviews.map((review, index) => pointReviewToLegacySubReview(review, index));

    questionGrades.push({
      questionNo: question.questionNo,
      earnedScore: Math.max(
        0,
        Math.min(
          question.score,
          pointReviews.length
            ? pointReviews.reduce((sum, item) => sum + Number(item.score || 0), 0)
            : (Number.isFinite(earnedScoreRaw) ? earnedScoreRaw : 0),
        ),
      ),
      questionComment: normalizeFreeText(parsedItem?.questionComment) || getRoleBasedQuestionFallback(settings),
      requiresReview: Boolean(parsedItem?.requiresReview),
      pointReviews,
      sectionComments,
      subReviews,
      displaySubReviews: buildDisplaySubReviews(question, subReviews),
      annotations: {
        matches: uniqueTextItems([
          ...uniqueTextItems(parsedItem?.annotations?.matches, 6),
          ...pointReviews.flatMap((review) => review.matchedExcerpts || []),
        ], 8),
        errors: sanitizeAnnotationErrors(parsedItem?.annotations?.errors),
      },
    });
  }

  return {
    provider: 'doubao',
    selectedModel: selectedModel || getProfileConfig(settings, profile).preferredModel,
    overallComment: normalizeFreeText(parsed?.overallComment) || getRoleBasedOverallFallback(settings),
    questionGrades,
  };
}

async function gradeSubjectiveQuestions({ settings, profile, task, student, questions }) {
  const gradableQuestions = questions.filter((question) => normalizeFreeText(question.studentAnswer));
  const fallbackMap = new Map(
    questions
      .filter((question) => !normalizeFreeText(question.studentAnswer))
      .map((question) => [question.questionNo, buildMissingSubjectiveResult(question.questionNo, '学生该题未作答，本题记 0 分。')]),
  );

  if (!gradableQuestions.length) {
    return {
      provider: 'doubao',
      selectedModel: getProfileConfig(settings, profile).preferredModel,
      overallComment: getRoleBasedOverallFallback(settings),
      questionGrades: questions.map((question) => fallbackMap.get(question.questionNo) || buildMissingSubjectiveResult(question.questionNo, '当前题目暂无可批改内容。')),
    };
  }

  try {
    const { payload, parsed } = await requestSubjectiveGradingPass({
      settings,
      profile,
      task,
      student,
      questions: gradableQuestions,
      passLabel: 'batch',
    });

    return buildSubjectiveGradingResult({
      settings,
      profile,
      task,
      student,
      questions,
      fallbackMap,
      parsed,
      selectedModel: payload.__selectedModel,
    });
  } catch (batchError) {
    if (gradableQuestions.length <= 1) {
      throw batchError;
    }

    console.warn(
      `[subjective-grading] batch parse failed for ${student?.studentName || 'unknown student'}, retrying per question: ${batchError?.message || batchError}`,
      batchError?.debugArtifactPath ? `(artifact: ${batchError.debugArtifactPath})` : '',
    );

    const recoveredGradeMap = new Map();
    const perQuestionFailures = new Map();
    let recoveredSelectedModel = '';

    for (const question of gradableQuestions) {
      try {
        const { payload, parsed } = await requestSubjectiveGradingPass({
          settings,
          profile,
          task,
          student,
          questions: [question],
          passLabel: `single-q${question.questionNo}`,
        });
        const singleResult = await buildSubjectiveGradingResult({
          settings,
          profile,
          task,
          student,
          questions: [question],
          fallbackMap,
          parsed,
          selectedModel: payload.__selectedModel,
        });
        const singleGrade = (singleResult.questionGrades || []).find((item) => item?.questionNo === question.questionNo);
        if (singleGrade) {
          recoveredGradeMap.set(question.questionNo, singleGrade);
        }
        if (!recoveredSelectedModel) {
          recoveredSelectedModel = singleResult.selectedModel || payload.__selectedModel || '';
        }
      } catch (questionError) {
        perQuestionFailures.set(question.questionNo, questionError);
        console.warn(
          `[subjective-grading] single-question recovery failed for ${student?.studentName || 'unknown student'} q${question.questionNo}: ${questionError?.message || questionError}`,
          questionError?.debugArtifactPath ? `(artifact: ${questionError.debugArtifactPath})` : '',
        );
      }
    }

    if (!recoveredGradeMap.size) {
      throw batchError;
    }

    const questionGrades = questions.map((question) => {
      if (fallbackMap.has(question.questionNo)) {
        return fallbackMap.get(question.questionNo);
      }
      if (recoveredGradeMap.has(question.questionNo)) {
        return recoveredGradeMap.get(question.questionNo);
      }
      const questionError = perQuestionFailures.get(question.questionNo);
      return buildMissingSubjectiveResult(
        question.questionNo,
        `模型单题重试失败：${questionError?.message || batchError?.message || '未知错误'}，建议人工复核。`,
      );
    });

    return {
      provider: 'doubao',
      selectedModel: recoveredSelectedModel || getProfileConfig(settings, profile).preferredModel,
      overallComment: perQuestionFailures.size
        ? '本轮主观题已完成部分补救批改，仍有题目需要人工复核。'
        : '本轮主观题已通过单题补救完成批改。',
      questionGrades,
    };
  }
}

async function generatePointAliasSuggestions({
  settings,
  questionNo,
  questionContent,
  standardAnswer,
  sectionLabel,
  subquestionLabel,
  pointLabel,
  existingAliases = [],
  notes = [],
}) {
  const normalizedPointLabel = normalizeFreeText(pointLabel);
  if (!normalizedPointLabel) {
    throw new Error('请先填写三级采分点名称，再生成候选别名。');
  }

  const normalizedExistingAliases = uniqueTextItems(existingAliases, 20);
  const normalizedNotes = uniqueTextItems(notes, 12);
  const prompt = [
    '请只为当前这个三级采分点生成候选别名，供老师审核后采纳。',
    '要求：',
    '1. 只生成与当前采分点语义等价的学生常见表述。',
    '2. 不要扩展成新的采分点，不要把相邻采分点混进来。',
    '3. 优先给出短表达，不要写成长句点评。',
    '4. 不要重复采分点原名，也不要重复已有别名。',
    '5. 如果不适合生成，请返回空数组。',
    '',
    `题号：${normalizeFreeText(questionNo) || '未填写'}`,
    `题目：${normalizeFreeText(questionContent) || '未填写'}`,
    `参考答案：${normalizeFreeText(standardAnswer) || '未填写'}`,
    `一级小题：${normalizeFreeText(sectionLabel) || '未填写'}`,
    `二级子问题：${normalizeFreeText(subquestionLabel) || '未填写'}`,
    `三级采分点：${normalizedPointLabel}`,
    `已有别名：${normalizedExistingAliases.join('；') || '无'}`,
    `补充说明：${normalizedNotes.join('；') || '无'}`,
    '',
    '请严格输出 JSON 对象，例如：{"aliases":["表述1","表述2"]}',
  ].join('\n');

  const payload = await chatCompletion({
    settings,
    profile: 'general',
    temperature: 0.2,
    maxTokens: 1200,
    messages: [
      {
        role: 'system',
        content:
          '你是高中历史阅卷规则助手。你的任务是为单个采分点补充候选别名。只能输出严格 JSON，不要输出解释，不要新增采分点。',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const parsed = await parseModelJson({
    settings,
    profile: 'general',
    raw: getContentFromCompletion(payload),
    schemaHint: '{"aliases":["候选别名1","候选别名2"]}',
  });

  return {
    aliases: sanitizeAliasSuggestions(parsed?.aliases, normalizedExistingAliases, normalizedPointLabel),
  };
}

async function generateEssayThesisSuggestions({
  settings,
  questionNo,
  questionContent,
  standardAnswer,
  existingTemplates = [],
  existingKeywordGroups = [],
  notes = '',
}) {
  const normalizedQuestionContent = normalizeFreeText(questionContent);
  if (!normalizedQuestionContent) {
    throw new Error('请先填写原题目，再生成论题建议。');
  }

  const normalizedExistingTemplates = uniqueTextItems(existingTemplates, 20);
  const normalizedExistingKeywordGroups = (Array.isArray(existingKeywordGroups) ? existingKeywordGroups : []).map((group) => ({
    label: normalizeFreeText(group?.label),
    type: ['judgment', 'object', 'scope'].includes(normalizeFreeText(group?.type))
      ? normalizeFreeText(group?.type)
      : 'judgment',
    expressions: uniqueTextItems(group?.expressions, 8),
  }));
  const prompt = [
    '请为这道高中历史论述题同时生成“核心关键词组”和“范例论题”。',
    '要求：',
    '1. 先提炼 3-6 个核心关键词组，重点提炼“判断型关键词组”。',
    '2. 关键词组不能只抓名词，还要尽量抓住历史判断或关系词，如原因、影响、特点、实质、趋势、评价、作用、变化等。',
    '3. 每个关键词组都要给出 2-5 个可视为等价或近义的表达，学生命中组内任一表达即可视为命中该组。',
    '4. 关键词组的 type 只能是 judgment、object、scope，其中 judgment 最重要。',
    '5. 再基于这些关键词组生成 7-8 个可供老师参考的范例论题；范例论题必须是一句完整、明确、可论证的陈述句。',
    '6. 范例论题必须切题，不能跑题，不能超出题目要求的历史时空范围，不能只是照抄题干。',
    '7. 不要和已有关键词组、已有模板重复。',
    '8. 只输出严格 JSON，例如：{"keywordGroups":[{"label":"判断1","type":"judgment","expressions":["表达1","表达2"]}],"theses":["论题1","论题2"]}',
    '',
    `题号：${normalizeFreeText(questionNo) || '未填写'}`,
    `题目：${normalizedQuestionContent}`,
    `参考答案：${normalizeFreeText(standardAnswer) || '未填写'}`,
    `已有关键词组：${JSON.stringify(normalizedExistingKeywordGroups) || '[]'}`,
    `已有模板：${normalizedExistingTemplates.join('；') || '无'}`,
    `补充说明：${normalizeFreeText(notes) || '无'}`,
  ].join('\n');

  const payload = await chatCompletion({
    settings,
    profile: 'general',
    temperature: 0.2,
    maxTokens: 1200,
    messages: [
      {
        role: 'system',
        content: '你是高中历史论述题命题与阅卷助手。你的任务是只输出严格 JSON，为老师提供核心关键词组和可选论题模板。',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const parsed = await parseModelJson({
    settings,
    profile: 'general',
    raw: getContentFromCompletion(payload),
    schemaHint: '{"keywordGroups":[{"label":"判断1","type":"judgment","expressions":["表达1","表达2"]}],"theses":["论题1","论题2"]}',
  });

  return {
    keywordGroups: sanitizeEssayKeywordGroups(parsed?.keywordGroups, normalizedExistingKeywordGroups),
    theses: sanitizeEssayThesisSuggestions(parsed?.theses, normalizedExistingTemplates),
  };
}

module.exports = {
  testConnection,
  extractMaterialDrafts,
  recognizeAnswerSheet,
  generateChoiceQuestionExplanations,
  gradeSubjectiveQuestions,
  generateEssayThesisSuggestions,
  generatePointAliasSuggestions,
  clearModelResolutionCache,
  clearAnswerSheetRecognitionCache,
};
