const crypto = require('node:crypto');

const DEFAULT_GLOBAL_OFF_TOPIC_CAP = 4;
const DEFAULT_BODY_PARAGRAPH_COUNT = 3;
const DEFAULT_THESIS_SCORE = 2;

function createNodeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizeScore(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return Math.max(0, Number(fallback) || 0);
  }
  return numeric;
}

function normalizeInteger(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function normalizeParagraphCount(value) {
  const numeric = normalizeInteger(value, DEFAULT_BODY_PARAGRAPH_COUNT, 2, 3);
  return numeric === 3 ? 3 : 2;
}

function uniqueStrings(values) {
  return Array.from(
    new Set((Array.isArray(values) ? values : []).map((item) => String(item ?? '').trim()).filter(Boolean)),
  );
}

function normalizeKeywordGroupType(value) {
  return ['judgment', 'object', 'scope'].includes(String(value || '').trim()) ? String(value).trim() : 'judgment';
}

function createKeywordExpression(seed = {}) {
  return {
    id: seed.id || createNodeId('essay-keyword-expression'),
    text: String(seed.text ?? '').trim(),
  };
}

function normalizeKeywordExpressions(values) {
  const seen = new Set();
  const items = (Array.isArray(values) ? values : [])
    .map((item) => createKeywordExpression(item))
    .filter((item) => item.text)
    .filter((item) => {
      const key = item.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return items.length ? items : [createKeywordExpression({ text: '' })];
}

function createKeywordGroup(seed = {}) {
  return {
    id: seed.id || createNodeId('essay-keyword-group'),
    label: String(seed.label ?? '').trim(),
    type: normalizeKeywordGroupType(seed.type),
    required: seed.required !== false,
    enabled: seed.enabled !== false,
    expressions: normalizeKeywordExpressions(seed.expressions),
  };
}

function normalizeKeywordGroups(values) {
  return (Array.isArray(values) ? values : [])
    .map((item) => createKeywordGroup(item))
    .filter((item) => item.label || item.expressions.some((expression) => expression.text));
}

function filterKeywordGroupsByType(values, types) {
  const allowedTypes = new Set(Array.isArray(types) ? types : []);
  return normalizeKeywordGroups(values).filter((group) => allowedTypes.has(group.type));
}

function cloneKeywordGroups(values) {
  return normalizeKeywordGroups(values).map((group) => createKeywordGroup({
    ...group,
    id: createNodeId('essay-keyword-group'),
    expressions: group.expressions.map((expression) => createKeywordExpression({ text: expression.text })),
  }));
}

function normalizePenaltyMode(value, fallback) {
  return ['deduct', 'zero', 'cap_total'].includes(String(value || '').trim()) ? String(value).trim() : fallback;
}

function normalizePenaltyMeasure(value, fallback) {
  return String(value || '').trim() === 'per_item' ? 'per_item' : fallback;
}

const DEFAULT_THESIS_CRITERIA = [
  {
    code: 'has_thesis',
    label: '是否有论题（没有论题则本部分0分）',
    penaltyMode: 'zero',
    penaltyValue: 0,
    penaltyMeasure: 'once',
  },
  {
    code: 'object_correct',
    label: '对象是否正确',
    penaltyMode: 'deduct',
    penaltyValue: 1,
    penaltyMeasure: 'once',
  },
  {
    code: 'judgment_correct',
    label: '判断是否正确',
    penaltyMode: 'deduct',
    penaltyValue: 1,
    penaltyMeasure: 'once',
  },
];

const RETIRED_THESIS_CRITERIA_CODES = ['within_scope'];

const LEGACY_THESIS_CRITERIA_CODES = [
  'relevant_to_prompt',
  'appropriate_thesis',
  'keyword_groups_hit',
  'clear_expression',
  'complete_expression',
];

const THESIS_DEFAULT_CODES = DEFAULT_THESIS_CRITERIA.map((item) => item.code);

const DEFAULT_BODY_CRITERIA = [
  {
    code: 'focus_on_thesis',
    label: '是否围绕论题（跑题全扣）',
    penaltyMode: 'zero',
    penaltyValue: 0,
    penaltyMeasure: 'once',
  },
  {
    code: 'within_scope',
    label: '是否符合时空范围（超出本段全扣）',
    penaltyMode: 'zero',
    penaltyValue: 0,
    penaltyMeasure: 'once',
  },
  {
    code: 'has_heading',
    label: '是否有小标题（没有扣1分）',
    penaltyMode: 'deduct',
    penaltyValue: 1,
    penaltyMeasure: 'once',
  },
  {
    code: 'has_evidence',
    label: '是否有具体史实（缺少必要史实扣2分）',
    penaltyMode: 'deduct',
    penaltyValue: 2,
    penaltyMeasure: 'once',
  },
  {
    code: 'explains_evidence',
    label: '是否解释史实的作用、机制或因果（缺少扣1分）',
    penaltyMode: 'deduct',
    penaltyValue: 1,
    penaltyMeasure: 'once',
  },
  {
    code: 'links_back_to_thesis',
    label: '是否把分析回扣到论题或分论点（缺少扣1分）',
    penaltyMode: 'deduct',
    penaltyValue: 1,
    penaltyMeasure: 'once',
  },
  {
    code: 'factual_error',
    label: '是否有史实错误（有错误1个扣1分）',
    penaltyMode: 'deduct',
    penaltyValue: 1,
    penaltyMeasure: 'per_item',
  },
];

const DEFAULT_CONCLUSION_SCORE_ONE = [
  {
    code: 'has_summary',
    label: '是否有结论（缺少结论扣1分）',
    penaltyMode: 'deduct',
    penaltyValue: 1,
    penaltyMeasure: 'once',
  },
  {
    code: 'has_elevation',
    label: '是否有升华（缺少升华扣1分）',
    penaltyMode: 'deduct',
    penaltyValue: 1,
    penaltyMeasure: 'once',
  },
];

const DEFAULT_CONCLUSION_SCORE_TWO = [
  {
    code: 'has_summary',
    label: '是否有结论（缺少结论扣1分）',
    penaltyMode: 'deduct',
    penaltyValue: 1,
    penaltyMeasure: 'once',
  },
  {
    code: 'has_elevation',
    label: '是否有升华（缺少升华扣1分）',
    penaltyMode: 'deduct',
    penaltyValue: 1,
    penaltyMeasure: 'once',
  },
];

const LEGACY_BODY_CRITERIA_CODES = [
  'has_argument',
  'has_reasonable_explanation',
];

function createEssayCriterion(seed = {}, fallback = {}) {
  return {
    id: seed.id || createNodeId('essay-criterion'),
    code: String(seed.code ?? fallback.code ?? 'custom').trim() || 'custom',
    label: String(seed.label ?? fallback.label ?? '').trim(),
    penaltyMode: normalizePenaltyMode(seed.penaltyMode, fallback.penaltyMode || 'deduct'),
    penaltyValue: normalizeScore(seed.penaltyValue, fallback.penaltyValue ?? 1),
    penaltyMeasure: normalizePenaltyMeasure(seed.penaltyMeasure, fallback.penaltyMeasure || 'once'),
  };
}

function createDefaultCriteria(defaults, existingCriteria, offTopicCap = DEFAULT_GLOBAL_OFF_TOPIC_CAP) {
  return defaults.map((defaultCriterion) => {
    const matched = (existingCriteria || []).find((criterion) => criterion.code === defaultCriterion.code);
    return createEssayCriterion(
      {
        ...matched,
        penaltyValue: defaultCriterion.penaltyMode === 'cap_total'
          ? offTopicCap
          : (matched?.penaltyValue ?? defaultCriterion.penaltyValue),
      },
      {
        ...defaultCriterion,
        penaltyValue: defaultCriterion.penaltyMode === 'cap_total' ? offTopicCap : defaultCriterion.penaltyValue,
      },
    );
  });
}

function createCustomCriteria(existingCriteria, defaultCodes) {
  return (Array.isArray(existingCriteria) ? existingCriteria : [])
    .filter((criterion) => !defaultCodes.includes(String(criterion.code || '').trim()))
    .map((criterion) => createEssayCriterion(criterion));
}

function buildConclusionCriteria(score, existingCriteria) {
  const normalizedScore = normalizeInteger(score, 1, 1, 2);
  const defaults = normalizedScore >= 2 ? DEFAULT_CONCLUSION_SCORE_TWO : DEFAULT_CONCLUSION_SCORE_ONE;
  const defaultCodes = defaults.map((item) => item.code);
  return [
    ...createDefaultCriteria(defaults, existingCriteria),
    ...createCustomCriteria(existingCriteria, defaultCodes),
  ];
}

function buildThesisCriteria(existingCriteria, offTopicCap = DEFAULT_GLOBAL_OFF_TOPIC_CAP) {
  const activeExistingCriteria = Array.isArray(existingCriteria)
    ? existingCriteria.filter((criterion) => !RETIRED_THESIS_CRITERIA_CODES.includes(String(criterion?.code || '').trim()))
    : existingCriteria;
  const onlyRetiredCriteria = Array.isArray(existingCriteria)
    && existingCriteria.length > 0
    && Array.isArray(activeExistingCriteria)
    && activeExistingCriteria.length === 0;

  if (!Array.isArray(activeExistingCriteria)) {
    return createDefaultCriteria(DEFAULT_THESIS_CRITERIA, undefined, offTopicCap);
  }
  if (onlyRetiredCriteria) {
    return createDefaultCriteria(DEFAULT_THESIS_CRITERIA, undefined, offTopicCap);
  }

  const hasLegacyCodes = activeExistingCriteria.some((criterion) => LEGACY_THESIS_CRITERIA_CODES.includes(String(criterion?.code || '').trim()));
  if (hasLegacyCodes) {
    return [
      ...createDefaultCriteria(DEFAULT_THESIS_CRITERIA, activeExistingCriteria, offTopicCap),
      ...createCustomCriteria(activeExistingCriteria, [...THESIS_DEFAULT_CODES, ...LEGACY_THESIS_CRITERIA_CODES, ...RETIRED_THESIS_CRITERIA_CODES]),
    ];
  }

  return syncCapPenaltyValues(activeExistingCriteria.map((criterion) => createEssayCriterion(criterion)), offTopicCap);
}

function createBodyParagraph(partial = {}, index = 0, fallbackScopeKeywordGroups = []) {
  const defaultBodyCodes = DEFAULT_BODY_CRITERIA.map((item) => item.code);
  const existingScopeGroups = filterKeywordGroupsByType(partial.scopeKeywordGroups, ['scope']);
  const scopeKeywordGroups = existingScopeGroups.length
    ? existingScopeGroups
    : cloneKeywordGroups(fallbackScopeKeywordGroups);
  return {
    id: partial.id || createNodeId('essay-body'),
    label: String(partial.label ?? '').trim() || `第${index + 1}段`,
    score: normalizeScore(partial.score, 3),
    scopeKeywordGroups,
    criteria: [
      ...createDefaultCriteria(DEFAULT_BODY_CRITERIA, partial.criteria),
      ...createCustomCriteria(partial.criteria, [...defaultBodyCodes, ...LEGACY_BODY_CRITERIA_CODES]),
    ],
  };
}

function syncParagraphs(paragraphs, paragraphCount, fallbackScopeKeywordGroups = []) {
  const normalizedCount = normalizeParagraphCount(paragraphCount);
  const existing = Array.isArray(paragraphs) ? paragraphs.slice(0, normalizedCount) : [];
  const nextParagraphs = [...existing];
  while (nextParagraphs.length < normalizedCount) {
    nextParagraphs.push(createBodyParagraph({}, nextParagraphs.length, fallbackScopeKeywordGroups));
  }
  return nextParagraphs.map((paragraph, index) => createBodyParagraph(paragraph, index, fallbackScopeKeywordGroups));
}

function syncCapPenaltyValues(criteria, offTopicCap) {
  return (Array.isArray(criteria) ? criteria : []).map((criterion) =>
    criterion.penaltyMode === 'cap_total'
      ? createEssayCriterion({ ...criterion, penaltyValue: offTopicCap })
      : createEssayCriterion(criterion),
  );
}

function createDefaultEssayRuleTree(notes = '') {
  const bodyParagraphs = syncParagraphs([], DEFAULT_BODY_PARAGRAPH_COUNT);
  return {
    version: 1,
    notes: String(notes || '').trim(),
    globalOffTopicCap: DEFAULT_GLOBAL_OFF_TOPIC_CAP,
    thesis: {
      score: DEFAULT_THESIS_SCORE,
      templates: [],
      keywordGroups: [],
      criteria: createDefaultCriteria(DEFAULT_THESIS_CRITERIA, undefined, DEFAULT_GLOBAL_OFF_TOPIC_CAP),
    },
    body: {
      paragraphCount: DEFAULT_BODY_PARAGRAPH_COUNT,
      paragraphs: bodyParagraphs,
    },
    conclusion: {
      score: 1,
      criteria: buildConclusionCriteria(1, undefined),
    },
  };
}

function normalizeEssayRuleTree(tree, question = {}) {
  if (!tree) {
    return createDefaultEssayRuleTree(question?.gradingRule || '');
  }

  const globalOffTopicCap = normalizeInteger(tree.globalOffTopicCap, DEFAULT_GLOBAL_OFF_TOPIC_CAP, 0, 30);
  const paragraphCount = normalizeParagraphCount(tree?.body?.paragraphCount);
  const conclusionScore = normalizeInteger(tree?.conclusion?.score, 1, 1, 2);
  const normalizedThesisKeywordGroups = normalizeKeywordGroups(tree?.thesis?.keywordGroups);
  const thesisScopeKeywordGroups = normalizedThesisKeywordGroups.filter((group) => group.type === 'scope');

  return {
    version: 1,
    notes: String(tree.notes ?? question?.gradingRule ?? '').trim(),
    globalOffTopicCap,
    thesis: {
      score: normalizeInteger(tree?.thesis?.score, DEFAULT_THESIS_SCORE, 2, 3),
      templates: uniqueStrings(tree?.thesis?.templates),
      keywordGroups: normalizedThesisKeywordGroups.filter((group) => group.type !== 'scope'),
      criteria: buildThesisCriteria(tree?.thesis?.criteria, globalOffTopicCap),
    },
    body: {
      paragraphCount,
      paragraphs: syncParagraphs(tree?.body?.paragraphs, paragraphCount, thesisScopeKeywordGroups),
    },
    conclusion: {
      score: conclusionScore,
      criteria: buildConclusionCriteria(conclusionScore, tree?.conclusion?.criteria),
    },
  };
}

function getEssayRuleTreeTotalScore(tree, question = {}) {
  const normalized = normalizeEssayRuleTree(tree, question);
  return normalizeScore(normalized.thesis.score, 0)
    + normalized.body.paragraphs
      .slice(0, normalized.body.paragraphCount)
      .reduce((sum, paragraph) => sum + normalizeScore(paragraph.score, 0), 0)
    + normalizeScore(normalized.conclusion.score, 0);
}

function buildPenaltyDescription(criterion) {
  if (criterion.penaltyMode === 'zero') {
    return '不满足则本部分0分';
  }
  if (criterion.penaltyMode === 'cap_total') {
    return `触发则整题总分上限${normalizeScore(criterion.penaltyValue, DEFAULT_GLOBAL_OFF_TOPIC_CAP)}分`;
  }
  const scoreText = normalizeScore(criterion.penaltyValue, 1);
  return criterion.penaltyMeasure === 'per_item'
    ? `每项扣${scoreText}分`
    : `扣${scoreText}分`;
}

function buildCriterionLines(criteria) {
  return (Array.isArray(criteria) ? criteria : [])
    .map((criterion, index) => `${index + 1}. ${criterion.label}；${buildPenaltyDescription(criterion)}`)
    .join('\n');
}

function buildEssayRuleSummary(tree, question = {}) {
  const normalized = normalizeEssayRuleTree(tree, question);
  const parts = [
    '论述题结构化阅卷要求',
    `整题偏题/跑题总分上限：${normalized.globalOffTopicCap}分`,
    '',
    `一、论题（${normalized.thesis.score}分）`,
    buildCriterionLines(normalized.thesis.criteria),
  ];

  if (normalized.thesis.templates.length) {
    parts.push(`可选论题模板：${normalized.thesis.templates.join('；')}`);
  }

  if (normalized.thesis.keywordGroups.length) {
    parts.push(
      `核心关键词组：${normalized.thesis.keywordGroups
        .filter((group) => group.enabled)
        .map((group) => `${group.type === 'judgment' ? '判断' : '对象'}组「${group.label || '未命名'}」=${group.expressions.map((item) => item.text).filter(Boolean).join(' / ') || '未填写'}`)
        .join('；')}`,
    );
  }

  parts.push('');
  parts.push(`二、论述过程（共${normalized.body.paragraphs.slice(0, normalized.body.paragraphCount).reduce((sum, paragraph) => sum + paragraph.score, 0)}分）`);
  normalized.body.paragraphs.slice(0, normalized.body.paragraphCount).forEach((paragraph) => {
    parts.push(`${paragraph.label}（${paragraph.score}分）`);
    parts.push(buildCriterionLines(paragraph.criteria));
    if (paragraph.scopeKeywordGroups.length) {
      parts.push(
        `本段时空范围关键词组：${paragraph.scopeKeywordGroups
          .filter((group) => group.enabled)
          .map((group) => `范围组「${group.label || '未命名'}」=${group.expressions.map((item) => item.text).filter(Boolean).join(' / ') || '未填写'}`)
          .join('；')}`,
      );
    }
  });

  parts.push('');
  parts.push(`三、结论（${normalized.conclusion.score}分）`);
  parts.push(buildCriterionLines(normalized.conclusion.criteria));

  if (normalized.notes) {
    parts.push('');
    parts.push(`补充说明：${normalized.notes}`);
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
  DEFAULT_GLOBAL_OFF_TOPIC_CAP,
  createDefaultEssayRuleTree,
  normalizeEssayRuleTree,
  getEssayRuleTreeTotalScore,
  buildEssayRuleSummary,
};
