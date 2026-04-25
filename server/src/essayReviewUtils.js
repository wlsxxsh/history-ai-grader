const { normalizeEssayRuleTree } = require('./essayRuleTree');

function normalizeText(value) {
  return String(value || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function uniqueTextItems(values, limit = 12) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((item) => normalizeText(item)).filter(Boolean))).slice(0, limit);
}

function clampScore(score, fullScore) {
  const numeric = Number(score || 0);
  if (!Number.isFinite(numeric)) return 0;
  if (fullScore > 0) {
    return Math.max(0, Math.min(fullScore, numeric));
  }
  return Math.max(0, numeric);
}

function toChineseNumber(value) {
  const map = {
    '一': 1,
    '二': 2,
    '三': 3,
    '四': 4,
    '五': 5,
    '六': 6,
    '七': 7,
    '八': 8,
    '九': 9,
    '十': 10,
  };

  const text = normalizeText(value);
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  if (text === '十') return 10;
  if (text.startsWith('十')) return 10 + (map[text.slice(1)] || 0);
  if (text.endsWith('十')) return (map[text[0]] || 0) * 10;
  if (text.includes('十')) {
    const [left, right] = text.split('十');
    return (map[left] || 0) * 10 + (map[right] || 0);
  }
  return map[text] || null;
}

function sanitizePositiveInteger(value, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const integer = Math.trunc(numeric);
  if (integer < minimum || integer > maximum) return null;
  return integer;
}

function sanitizeCount(value, maximum = 5) {
  return sanitizePositiveInteger(value, 1, maximum);
}

function splitNonEmptyLines(source) {
  const text = String(source || '').replace(/\r/g, '');
  const lines = [];
  const matcher = /[^\n]+/g;
  let match;

  while ((match = matcher.exec(text))) {
    const raw = String(match[0] || '');
    const leading = (raw.match(/^\s*/) || [''])[0].length;
    const trailing = (raw.match(/\s*$/) || [''])[0].length;
    const start = match.index + leading;
    const end = match.index + raw.length - trailing;
    if (end <= start) continue;

    const excerpt = text.slice(start, end);
    const normalized = normalizeText(excerpt);
    if (!normalized) continue;

    lines.push({
      start,
      end,
      text: normalized,
      excerpt,
    });
  }

  return lines;
}

const ESSAY_KEYWORD_LINE_PATTERN = /^(?:答[:：]\s*)?(?:三个关键词|关键词|所选关键词)\s*[:：]/;
const ESSAY_THESIS_LINE_PATTERN = /^(?:答[:：]\s*)?(?:论题|标题|观点|问题)\s*[:：]/;
const ESSAY_CONCLUSION_LINE_PATTERN = /^(?:综上(?:所述)?|总之|因此|由此可见|可见|结论|总结|总而言之|所以|归根结底|由此看来)\s*[:：]?/;
const ESSAY_BODY_LINE_PATTERN = /^(?:(?:论述|阐述)\s*[:：]?$|(?:第[一二三四五六七八九十\d]+(?:段|部分|点|方面)?|[①②③④⑤⑥⑦⑧⑨⑩]|[（(][1-9]\d*[）)]|一是|二是|三是|首先|其次|再次|最后)[、，.．:：]?)/;
const ESSAY_INLINE_BODY_MARKER_PATTERN = /(^|[\n\s:：，；;。])((?:第[一二三四五六七八九十\d]+(?:段|部分|点|方面)?|[①②③④⑤⑥⑦⑧⑨⑩]|[（(][1-9]\d*[）)]|一是|二是|三是|首先|其次|再次|最后))[、，.．:：]?/g;

function lineIsStructureOnly(text) {
  return /^(?:论述|阐述)\s*[:：]?$/.test(normalizeText(text));
}

function lineLooksLikeKeyword(text) {
  return ESSAY_KEYWORD_LINE_PATTERN.test(normalizeText(text));
}

function lineLooksLikeThesis(text) {
  return ESSAY_THESIS_LINE_PATTERN.test(normalizeText(text));
}

function lineLooksLikeConclusion(text) {
  return ESSAY_CONCLUSION_LINE_PATTERN.test(normalizeText(text));
}

function lineLooksLikeBodyStart(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (lineLooksLikeThesis(normalized) || lineLooksLikeConclusion(normalized)) return false;
  return ESSAY_BODY_LINE_PATTERN.test(normalized);
}

function guessConclusionByLastLine(lines, thesisEndIndex) {
  if (!Array.isArray(lines) || lines.length < 3) return null;
  const lastIndex = lines.length - 1;
  if (lastIndex <= Number(thesisEndIndex || -1) + 1) {
    return null;
  }

  const lastText = normalizeText(lines[lastIndex]?.text);
  if (!lastText) return null;
  if (/(启示|认识|表明|说明|可见|因此|总之|综上)/.test(lastText)) {
    return { startIndex: lastIndex, endIndex: lastIndex };
  }

  return null;
}

function findEssayThesisRange(lines) {
  if (!Array.isArray(lines) || !lines.length) return null;

  const explicitIndex = lines.findIndex((line) => lineLooksLikeThesis(line.text));
  if (explicitIndex !== -1) {
    let startIndex = explicitIndex;
    while (startIndex > 0 && lineLooksLikeKeyword(lines[startIndex - 1]?.text)) {
      startIndex -= 1;
    }
    return { startIndex, endIndex: explicitIndex };
  }

  let keywordPrefixLength = 0;
  while (keywordPrefixLength < lines.length && lineLooksLikeKeyword(lines[keywordPrefixLength]?.text)) {
    keywordPrefixLength += 1;
  }
  if (keywordPrefixLength > 0) {
    const endIndex = Math.min(lines.length - 1, keywordPrefixLength);
    return { startIndex: 0, endIndex };
  }

  if (
    lines.length
    && !lineLooksLikeBodyStart(lines[0]?.text)
    && !lineLooksLikeConclusion(lines[0]?.text)
  ) {
    return { startIndex: 0, endIndex: 0 };
  }

  return null;
}

function findEssayConclusionRange(lines, thesisRange) {
  if (!Array.isArray(lines) || !lines.length) return null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lineLooksLikeConclusion(lines[index]?.text)) {
      return { startIndex: index, endIndex: lines.length - 1 };
    }
  }

  return guessConclusionByLastLine(lines, thesisRange?.endIndex);
}

function mergeRanges(ranges, desiredCount) {
  if (!Array.isArray(ranges) || !ranges.length) return [];
  const nextDesiredCount = sanitizeCount(desiredCount, ranges.length) || ranges.length;
  if (ranges.length <= nextDesiredCount) return ranges;

  const baseSize = Math.floor(ranges.length / nextDesiredCount);
  let remainder = ranges.length % nextDesiredCount;
  let cursor = 0;
  const merged = [];

  for (let index = 0; index < nextDesiredCount; index += 1) {
    const groupSize = baseSize + (remainder > 0 ? 1 : 0);
    const chunk = ranges.slice(cursor, cursor + groupSize).filter(Boolean);
    if (!chunk.length) continue;
    merged.push({
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
    });
    cursor += groupSize;
    remainder = Math.max(0, remainder - 1);
  }

  return merged;
}

function collectInlineBodyRanges(source, start, end, desiredCount) {
  if (!source || end <= start) return [];
  const slice = source.slice(start, end);
  const markers = [];
  let match;
  const matcher = new RegExp(ESSAY_INLINE_BODY_MARKER_PATTERN);

  while ((match = matcher.exec(slice))) {
    const prefix = match[1] || '';
    const markerStart = start + match.index + prefix.length;
    markers.push(markerStart);
  }

  const uniqueStarts = Array.from(new Set(markers)).filter((value) => value >= start && value < end);
  if (uniqueStarts.length < 2) return [];

  const ranges = uniqueStarts.map((markerStart, index) => ({
    start: markerStart,
    end: uniqueStarts[index + 1] || end,
  })).filter((item) => item.end > item.start);

  return mergeRanges(ranges, desiredCount);
}

function resolveRangeExcerpt(source, range) {
  if (!source || !range || Number(range.end || 0) <= Number(range.start || 0)) return '';
  return normalizeText(source.slice(Number(range.start || 0), Number(range.end || 0)));
}

function splitBodyRangesByLines(lines, desiredCount) {
  const ranges = (Array.isArray(lines) ? lines : []).map((line) => ({
    start: line.start,
    end: line.end,
  })).filter((item) => item.end > item.start);

  if (!ranges.length) return [];
  return mergeRanges(ranges, desiredCount);
}

function extractEssaySections(answer, options = {}) {
  const source = normalizeText(answer);
  if (!source) {
    return {
      thesis: null,
      bodySections: [],
      conclusion: null,
    };
  }

  const desiredBodyCount = sanitizeCount(options?.bodyCount, 5);
  const lines = splitNonEmptyLines(source);
  if (!lines.length) {
    return {
      thesis: null,
      bodySections: [],
      conclusion: null,
    };
  }

  const thesisRangeIndexes = findEssayThesisRange(lines);
  const conclusionRangeIndexes = findEssayConclusionRange(lines, thesisRangeIndexes);
  const thesis = thesisRangeIndexes
    ? {
      start: lines[thesisRangeIndexes.startIndex].start,
      end: lines[thesisRangeIndexes.endIndex].end,
      excerpt: resolveRangeExcerpt(source, {
        start: lines[thesisRangeIndexes.startIndex].start,
        end: lines[thesisRangeIndexes.endIndex].end,
      }),
    }
    : null;
  const conclusion = conclusionRangeIndexes
    ? {
      start: lines[conclusionRangeIndexes.startIndex].start,
      end: lines[conclusionRangeIndexes.endIndex].end,
      excerpt: resolveRangeExcerpt(source, {
        start: lines[conclusionRangeIndexes.startIndex].start,
        end: lines[conclusionRangeIndexes.endIndex].end,
      }),
    }
    : null;

  let bodyStartLineIndex = thesisRangeIndexes ? thesisRangeIndexes.endIndex + 1 : 0;
  const bodyEndLineIndex = conclusionRangeIndexes ? conclusionRangeIndexes.startIndex - 1 : lines.length - 1;
  while (
    bodyStartLineIndex <= bodyEndLineIndex
    && lineIsStructureOnly(lines[bodyStartLineIndex]?.text)
  ) {
    bodyStartLineIndex += 1;
  }

  const bodySections = [];
  if (bodyStartLineIndex <= bodyEndLineIndex) {
    const bodyLines = lines.slice(bodyStartLineIndex, bodyEndLineIndex + 1);
    const bodyStart = bodyLines[0]?.start ?? 0;
    const bodyEnd = bodyLines[bodyLines.length - 1]?.end ?? source.length;
    let ranges = collectInlineBodyRanges(source, bodyStart, bodyEnd, desiredBodyCount);

    if (!ranges.length) {
      const filteredBodyLines = bodyLines.filter((line) => !lineIsStructureOnly(line.text));
      const explicitStarts = filteredBodyLines.filter((line) => lineLooksLikeBodyStart(line.text));
      if (explicitStarts.length >= 2) {
        const explicitRanges = explicitStarts.map((line, index) => ({
          start: line.start,
          end: explicitStarts[index + 1]?.start ?? bodyEnd,
        })).filter((item) => item.end > item.start);
        ranges = mergeRanges(explicitRanges, desiredBodyCount);
      } else {
        ranges = splitBodyRangesByLines(filteredBodyLines, desiredBodyCount);
      }
    }

    ranges.forEach((range, index) => {
      const excerpt = resolveRangeExcerpt(source, range);
      if (!excerpt) return;
      bodySections.push({
        key: `essay-body-${index + 1}`,
        label: `第${index + 1}段`,
        order: index + 2,
        start: range.start,
        end: range.end,
        excerpt,
      });
    });
  }

  return {
    thesis: thesis ? { ...thesis, key: 'essay-thesis', label: '论题', order: 1 } : null,
    bodySections,
    conclusion: conclusion
      ? {
        ...conclusion,
        key: 'essay-conclusion',
        label: '结论',
        order: bodySections.length + 2,
      }
      : null,
  };
}

function detectEssayBodyCountFromText(value) {
  const text = normalizeText(value);
  if (!text) return null;

  if (/两段|两个方面|两方面|围绕两个方面|分成2段|分成两段/.test(text)) return 2;
  if (/三段|三个方面|三方面|围绕三个方面|至少围绕三个方面|分成3段|分成三段/.test(text)) return 3;

  const inlineMarkers = Array.from(new Set(
    (text.match(/第[一二三四五六七八九十\d]+(?:段|部分|点|方面)|[①②③④⑤⑥⑦⑧⑨⑩]|[（(][1-9]\d*[）)]/g) || [])
      .map((item) => normalizeText(item))
      .filter(Boolean),
  ));
  const markerCount = inlineMarkers.length;
  if (markerCount >= 3) return 3;
  if (markerCount === 2) return 2;
  return null;
}

function extractScoreByKeywords(texts, keywordPattern, allowedValues = []) {
  const patterns = [
    new RegExp(`(?:${keywordPattern})[^\\n。；;]{0,32}?([1-9]\\d*)\\s*分`),
    new RegExp(`([1-9]\\d*)\\s*分[^\\n。；;]{0,18}?(?:${keywordPattern})`),
  ];

  for (const value of (Array.isArray(texts) ? texts : [])) {
    const text = normalizeText(value);
    if (!text) continue;

    for (const pattern of patterns) {
      const match = text.match(pattern);
      const numeric = Number(match?.[1] || 0);
      if (!numeric) continue;
      if (Array.isArray(allowedValues) && allowedValues.length && !allowedValues.includes(numeric)) {
        continue;
      }
      return numeric;
    }
  }

  return null;
}

function distributeScores(totalScore, sectionCount) {
  const count = sanitizeCount(sectionCount, Math.max(1, Number(totalScore || 0))) || 1;
  if (totalScore <= 0) return Array.from({ length: count }, () => 0);
  const base = Math.floor(totalScore / count);
  let remainder = totalScore % count;
  return Array.from({ length: count }, () => {
    const value = base + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return value;
  });
}

function buildEssaySectionPlan(question = {}, answer = '', options = {}) {
  const essayRuleTree = question?.essayRuleTree ? normalizeEssayRuleTree(question.essayRuleTree, question) : null;
  if (essayRuleTree) {
    const paragraphs = (essayRuleTree.body?.paragraphs || [])
      .slice(0, essayRuleTree.body?.paragraphCount || 0)
      .map((paragraph, index) => ({
        label: normalizeText(paragraph?.label) || `第${index + 1}段`,
        score: Math.max(0, Number(paragraph?.score || 0)),
        criteria: Array.isArray(paragraph?.criteria) ? paragraph.criteria : [],
        scopeKeywordGroups: Array.isArray(paragraph?.scopeKeywordGroups) ? paragraph.scopeKeywordGroups : [],
      }));

    return {
      thesisFullScore: Math.max(0, Number(essayRuleTree.thesis?.score || 0)),
      conclusionFullScore: Math.max(0, Number(essayRuleTree.conclusion?.score || 0)),
      bodyTotalScore: paragraphs.reduce((sum, paragraph) => sum + paragraph.score, 0),
      bodySectionCount: paragraphs.length,
      bodySectionScores: paragraphs.map((paragraph) => paragraph.score),
      bodySectionLabels: paragraphs.map((paragraph, index) => paragraph.label || `第${index + 1}段`),
      bodyScopeKeywordGroups: paragraphs.map((paragraph) => paragraph.scopeKeywordGroups),
      globalOffTopicCap: Math.max(0, Number(essayRuleTree.globalOffTopicCap || 0)),
      essayRuleTree,
      thesisCriteria: Array.isArray(essayRuleTree.thesis?.criteria) ? essayRuleTree.thesis.criteria : [],
      bodyCriteria: paragraphs.map((paragraph) => paragraph.criteria),
      conclusionCriteria: Array.isArray(essayRuleTree.conclusion?.criteria) ? essayRuleTree.conclusion.criteria : [],
      thesisTemplates: Array.isArray(essayRuleTree.thesis?.templates) ? essayRuleTree.thesis.templates : [],
    };
  }

  const totalScore = Math.max(0, Number(question?.score || 0));
  const sources = [
    question?.gradingRule,
    question?.standardAnswer,
    question?.essayRule,
  ];
  const thesisFullScore = extractScoreByKeywords(sources, '论题|观点|标题', [2, 3])
    || Math.min(3, Math.max(1, totalScore >= 2 ? 2 : totalScore));

  let conclusionFullScore = extractScoreByKeywords(sources, '结论|总结|升华|启示|认识', [1, 2]);
  if (conclusionFullScore == null) {
    conclusionFullScore = Math.max(1, Math.min(2, totalScore - thesisFullScore - 8));
  }

  let bodyTotalScore = totalScore - thesisFullScore - conclusionFullScore;
  if (bodyTotalScore < 0) {
    conclusionFullScore = Math.max(0, conclusionFullScore + bodyTotalScore);
    bodyTotalScore = 0;
  }

  const explicitBodyCount = sanitizeCount(options?.bodySectionCount, 5)
    || detectEssayBodyCountFromText(answer)
    || detectEssayBodyCountFromText(question?.gradingRule)
    || detectEssayBodyCountFromText(question?.standardAnswer)
    || 3;
  let bodySectionCount = explicitBodyCount;
  if (bodyTotalScore > 0 && bodySectionCount > bodyTotalScore) {
    bodySectionCount = bodyTotalScore;
  }
  if (bodyTotalScore > 0 && bodySectionCount <= 0) {
    bodySectionCount = 1;
  }

  return {
    thesisFullScore,
    conclusionFullScore,
    bodyTotalScore,
    bodySectionCount,
    bodySectionScores: distributeScores(bodyTotalScore, bodySectionCount || 1),
    bodySectionLabels: Array.from({ length: bodySectionCount || 1 }, (_, index) => `第${index + 1}段`),
    bodyScopeKeywordGroups: Array.from({ length: bodySectionCount || 1 }, () => []),
    globalOffTopicCap: 0,
    essayRuleTree: null,
    thesisCriteria: [],
    bodyCriteria: [],
    conclusionCriteria: [],
    thesisTemplates: [],
  };
}

function resolveExactExcerpt(source, rawExcerpt, fallbackExcerpt) {
  const normalizedSource = String(source || '').replace(/\r/g, '');
  const candidate = String(rawExcerpt || '').replace(/\r/g, '').trim();
  if (candidate && normalizedSource.includes(candidate)) {
    return candidate;
  }

  const fallback = String(fallbackExcerpt || '').replace(/\r/g, '').trim();
  if (fallback && normalizedSource.includes(fallback)) {
    return fallback;
  }

  return candidate || fallback || '';
}

function sanitizeEssayChecks(rawChecks, partType) {
  const source = rawChecks && typeof rawChecks === 'object' ? rawChecks : {};
  const toBoolean = (value) => (typeof value === 'boolean' ? value : null);
  const numericFactualErrorCount = sanitizePositiveInteger(
    source?.factualErrorCount ?? source?.factErrorCount ?? source?.errorCount,
    0,
    20,
  );

  if (partType === 'body') {
    const hasReasonableExplanation = toBoolean(
      source?.hasReasonableExplanation ?? source?.hasAnalysis ?? source?.hasArgumentation ?? source?.hasExplanation,
    );
    const explainsEvidence = toBoolean(
      source?.explainsEvidence
      ?? source?.explainsHistoricalEvidence
      ?? source?.explainsFact
      ?? source?.explainsFacts
      ?? source?.explainsMechanism
      ?? source?.explainsCauseEffect,
    );
    const linksBackToThesis = toBoolean(
      source?.linksBackToThesis
      ?? source?.linksToThesis
      ?? source?.returnsToThesis
      ?? source?.supportsThesis
      ?? source?.connectsToClaim,
    );
    const factualErrorCount = numericFactualErrorCount;
    return {
      focusedOnThesis: toBoolean(source?.focusedOnThesis ?? source?.isRelevant ?? source?.relevantToThesis),
      isWithinScope: toBoolean(source?.isWithinScope ?? source?.withinScope),
      hasHeading: toBoolean(source?.hasHeading ?? source?.hasTitle ?? source?.hasSubtitle),
      hasHistoricalEvidence: toBoolean(source?.hasHistoricalEvidence ?? source?.hasEvidence ?? source?.hasFacts),
      hasReasonableExplanation,
      hasAnalysis: hasReasonableExplanation,
      explainsEvidence,
      linksBackToThesis,
      isFactuallyAccurate: toBoolean(source?.isFactuallyAccurate ?? source?.factsAccurate),
      factualErrorCount,
      matchedScopeGroupCount: sanitizePositiveInteger(source?.matchedScopeGroupCount, 0, 20),
    };
  }

  if (partType === 'conclusion') {
    const hasConclusion = toBoolean(source?.hasConclusion ?? source?.hasSummary ?? source?.summarizesArgument);
    return {
      hasConclusion,
      hasSummary: hasConclusion,
      hasElevation: toBoolean(source?.hasElevation ?? source?.isElevated ?? source?.hasInsight),
      factualErrorCount: numericFactualErrorCount,
    };
  }

  const hasThesis = toBoolean(source?.hasThesis ?? source?.hasClaim ?? source?.hasTopic);
  return {
    hasThesis,
    isObjectCorrect: toBoolean(source?.isObjectCorrect ?? source?.objectCorrect),
    isJudgmentCorrect: toBoolean(source?.isJudgmentCorrect ?? source?.judgmentCorrect ?? source?.isAppropriate ?? source?.isRelevant),
    factualErrorCount: numericFactualErrorCount,
    matchedObjectGroupCount: sanitizePositiveInteger(source?.matchedObjectGroupCount, 0, 20),
    matchedJudgmentGroupCount: sanitizePositiveInteger(source?.matchedJudgmentGroupCount ?? source?.matchedKeywordGroupCount, 0, 20),
  };
}

const BUILT_IN_ESSAY_CRITERION_CONFIG = {
  thesis: {
    has_thesis: { label: '是否有论题', positiveTag: '有论题', negativeTag: '缺少论题' },
    object_correct: { label: '对象是否正确', positiveTag: '对象准确', negativeTag: '对象有误' },
    judgment_correct: { label: '判断是否正确', positiveTag: '判断到位', negativeTag: '判断不到位' },
  },
  body: {
    focus_on_thesis: { label: '是否围绕论题', positiveTag: '围绕论题展开', negativeTag: '没有围绕论题展开' },
    within_scope: { label: '是否符合时空范围', positiveTag: '时空范围准确', negativeTag: '超出时空范围' },
    has_heading: { label: '是否有本段落小标题', positiveTag: '有小标题', negativeTag: '缺少小标题' },
    has_evidence: { label: '是否有具体史实', positiveTag: '史料充分', negativeTag: '缺少必要史实' },
    explains_evidence: { label: '是否解释史实的作用、机制或因果', positiveTag: '能解释史实作用', negativeTag: '缺少史实作用说明' },
    links_back_to_thesis: { label: '是否把分析回扣到论题或分论点', positiveTag: '能回扣论题', negativeTag: '缺少回扣论题' },
    has_argument: { label: '是否围绕史实展开合理说明', positiveTag: '说明和解释准确合理', negativeTag: '不准确不合理的论述过程' },
    has_reasonable_explanation: { label: '是否围绕史实展开合理说明', positiveTag: '说明和解释准确合理', negativeTag: '不准确不合理的论述过程' },
    factual_error: { label: '是否史实准确', positiveTag: '史实准确无硬伤', negativeTag: '有史实错误' },
  },
  conclusion: {
    has_summary: { label: '是否有结论', positiveTag: '有结论', negativeTag: '缺少结论' },
    has_conclusion: { label: '是否有结论', positiveTag: '有结论', negativeTag: '缺少结论' },
    has_elevation: { label: '是否有升华', positiveTag: '有升华', negativeTag: '缺少升华' },
  },
};

function stripCriterionLabel(label) {
  return normalizeText(label).replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
}

function buildCriterionDeductionText(criterion = {}) {
  const penaltyMode = normalizeText(criterion?.penaltyMode);
  if (penaltyMode === 'zero') {
    return '不满足则本部分0分';
  }
  if (penaltyMode === 'cap_total') {
    return `触发则整题总分上限${Math.max(0, Number(criterion?.penaltyValue || 0))}分`;
  }
  const penaltyValue = Math.max(0, Number(criterion?.penaltyValue || 0));
  if (!penaltyValue) return '';
  return normalizeText(criterion?.penaltyMeasure) === 'per_item'
    ? `每项扣${penaltyValue}分`
    : `扣${penaltyValue}分`;
}

function sanitizeEssayCriterionResult(item) {
  if (!item || typeof item !== 'object') return null;
  const code = normalizeText(item?.code);
  const label = stripCriterionLabel(item?.label);
  const positiveTag = normalizeText(item?.positiveTag);
  const negativeTag = normalizeText(item?.negativeTag);
  const suggestion = normalizeText(item?.suggestion);
  const deductionText = normalizeText(item?.deductionText);
  const count = sanitizePositiveInteger(item?.count, 0, 20);

  if (!code && !label && !positiveTag && !negativeTag) {
    return null;
  }

  return {
    code: code || label || `criterion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label,
    passed: typeof item?.passed === 'boolean' ? item.passed : null,
    positiveTag,
    negativeTag,
    suggestion,
    deductionText,
    count,
  };
}

function getBuiltInCriterionConfig(partType, code) {
  return BUILT_IN_ESSAY_CRITERION_CONFIG?.[partType]?.[code] || null;
}

function buildGenericCriterionConfig(label) {
  const cleanLabel = stripCriterionLabel(label) || '是否达标';
  if (/^是否/.test(cleanLabel)) {
    const core = cleanLabel.replace(/^是否/, '').trim() || cleanLabel;
    return {
      label: cleanLabel,
      positiveTag: core,
      negativeTag: `未满足${core}`,
    };
  }
  return {
    label: cleanLabel,
    positiveTag: cleanLabel,
    negativeTag: `未满足：${cleanLabel}`,
  };
}

function countMatchedKeywordGroupsByType(keywordGroupMatches = [], type) {
  return (Array.isArray(keywordGroupMatches) ? keywordGroupMatches : [])
    .filter((item) => normalizeText(item?.type) === type && item?.matched === true)
    .length;
}

function hasKeywordGroupsOfType(keywordGroupMatches = [], type) {
  return (Array.isArray(keywordGroupMatches) ? keywordGroupMatches : [])
    .some((item) => {
      if (normalizeText(item?.type) !== type) return false;
      const matchedCount = Array.isArray(item?.matchedExpressions) ? item.matchedExpressions.length : 0;
      const missingCount = Array.isArray(item?.missingExpressions) ? item.missingExpressions.length : 0;
      return matchedCount + missingCount > 0;
    });
}

function getCriterionPassedFromChecks(partType, code, checks, excerpt, factualErrorCount) {
  if (partType === 'body') {
    if (code === 'focus_on_thesis') return checks?.focusedOnThesis;
    if (code === 'within_scope') return checks?.isWithinScope;
    if (code === 'has_heading') return checks?.hasHeading;
    if (code === 'has_evidence') return checks?.hasHistoricalEvidence;
    if (code === 'explains_evidence') {
      return checks?.explainsEvidence ?? checks?.hasReasonableExplanation ?? checks?.hasAnalysis;
    }
    if (code === 'links_back_to_thesis') {
      return checks?.linksBackToThesis ?? checks?.hasReasonableExplanation ?? checks?.hasAnalysis;
    }
    if (code === 'has_argument' || code === 'has_reasonable_explanation') {
      return checks?.hasReasonableExplanation ?? checks?.hasAnalysis;
    }
    if (code === 'factual_error') {
      if (typeof checks?.isFactuallyAccurate === 'boolean') return checks.isFactuallyAccurate;
      if (typeof factualErrorCount === 'number') return factualErrorCount === 0;
      return null;
    }
    return null;
  }

  if (partType === 'conclusion') {
    if (code === 'has_summary' || code === 'has_conclusion') {
      return checks?.hasConclusion ?? checks?.hasSummary;
    }
    if (code === 'has_elevation') return checks?.hasElevation;
    return null;
  }

  if (code === 'has_thesis') {
    if (typeof checks?.hasThesis === 'boolean') return checks.hasThesis;
    return Boolean(normalizeText(excerpt));
  }
  if (code === 'object_correct') return checks?.isObjectCorrect;
  if (code === 'judgment_correct') return checks?.isJudgmentCorrect;
  return null;
}

function buildDefaultEssaySuggestion(partType, code, suggestedText = '') {
  const normalizedSuggestedText = normalizeText(suggestedText);
  if (normalizedSuggestedText) return normalizedSuggestedText;

  if (partType === 'thesis') {
    if (code === 'has_thesis') return '建议补出一句明确、完整的论题。';
    if (code === 'object_correct') return '建议把论题中的历史对象写得更准确。';
    if (code === 'judgment_correct') return '建议把题目要求的历史判断直接写进论题句。';
    return '建议把论题改得更明确、更聚焦。';
  }

  if (partType === 'conclusion') {
    if (code === 'has_summary' || code === 'has_conclusion') return '建议补上一段能够总结前文观点的结论。';
    if (code === 'has_elevation') return '建议在结尾补出一层历史认识或现实启示。';
    return '建议把结尾补写得更完整。';
  }

  if (code === 'focus_on_thesis') return '建议围绕论题重写本段，避免离题。';
  if (code === 'within_scope') return '建议把本段史实和论证限定在题目要求的历史时空范围内。';
  if (code === 'has_heading') return '建议补一个能概括本段核心意思的小标题。';
  if (code === 'has_evidence') return '建议补入能够支撑论题的具体史实。';
  if (code === 'explains_evidence') return '建议说明这条史实为什么重要，它具体产生了什么作用或影响。';
  if (code === 'links_back_to_thesis') return '建议把这段分析再扣回论题，点明它怎样体现你的论证观点。';
  if (code === 'has_argument' || code === 'has_reasonable_explanation') {
    return '建议把史实和论题之间的关系解释得更清楚。';
  }
  if (code === 'factual_error') return '建议核对史实并改正错误后再组织表述。';
  return '建议根据本项标准补强该部分内容。';
}

function buildEssayCriterionResults({
  partType,
  criteria,
  rawResults,
  checks,
  excerpt,
  factualErrors,
  suggestedText,
}) {
  const sanitizedRawResults = (Array.isArray(rawResults) ? rawResults : [])
    .map((item) => sanitizeEssayCriterionResult(item))
    .filter(Boolean);
  const rawByCode = new Map();
  const rawByLabel = new Map();
  sanitizedRawResults.forEach((item) => {
    if (item.code) rawByCode.set(item.code, item);
    if (item.label) rawByLabel.set(item.label, item);
  });

  const criterionList = Array.isArray(criteria) && criteria.length
    ? criteria
    : Object.entries(BUILT_IN_ESSAY_CRITERION_CONFIG?.[partType] || {}).map(([code, config]) => ({
      code,
      label: config.label,
      penaltyMode: 'deduct',
      penaltyValue: 0,
      penaltyMeasure: 'once',
    }));

  const factualErrorCount = Math.max(
    factualErrors.length,
    typeof checks?.factualErrorCount === 'number' ? checks.factualErrorCount : 0,
  );
  const matchedKeys = new Set();

  const results = criterionList.map((criterion, index) => {
    const code = normalizeText(criterion?.code) || `criterion-${index + 1}`;
    const fallbackLabel = stripCriterionLabel(criterion?.label);
    const rawMatch = rawByCode.get(code) || rawByLabel.get(fallbackLabel);
    if (rawMatch) {
      matchedKeys.add(rawMatch.code || rawMatch.label);
    }
    const config = getBuiltInCriterionConfig(partType, code) || buildGenericCriterionConfig(rawMatch?.label || fallbackLabel);
    const count = rawMatch?.count ?? (code === 'factual_error' ? factualErrorCount : null);
    let passed = rawMatch?.passed;
    if (typeof passed !== 'boolean') {
      passed = getCriterionPassedFromChecks(partType, code, checks, excerpt, factualErrorCount);
    }

    return {
      code,
      label: rawMatch?.label || config.label || fallbackLabel || code,
      passed,
      positiveTag: rawMatch?.positiveTag || config.positiveTag || '达标',
      negativeTag: rawMatch?.negativeTag || config.negativeTag || '未达标',
      suggestion: rawMatch?.suggestion || (passed === false ? buildDefaultEssaySuggestion(partType, code, suggestedText) : ''),
      deductionText: rawMatch?.deductionText || buildCriterionDeductionText(criterion),
      count,
    };
  });

  sanitizedRawResults.forEach((item) => {
    const matchKey = item.code || item.label;
    if (!matchKey || matchedKeys.has(matchKey)) return;
    const config = getBuiltInCriterionConfig(partType, item.code) || buildGenericCriterionConfig(item.label || item.code);
    results.push({
      code: item.code,
      label: item.label || config.label,
      passed: item.passed,
      positiveTag: item.positiveTag || config.positiveTag,
      negativeTag: item.negativeTag || config.negativeTag,
      suggestion: item.suggestion || (item.passed === false ? buildDefaultEssaySuggestion(partType, item.code, suggestedText) : ''),
      deductionText: item.deductionText,
      count: item.count,
    });
  });

  return results;
}

function hasFailedEssayCriterion(results = []) {
  return results.some((item) => item?.passed === false || ((item?.code === 'factual_error') && Number(item?.count || 0) > 0));
}

function hasTriggeredEssayPenalty(results = []) {
  return (Array.isArray(results) ? results : []).some((item) => {
    if (!item) return false;
    if (item.code === 'factual_error' && Number(item.count || 0) > 0) return true;
    return item.passed === false;
  });
}

function hasZeroPenaltyTriggered(criteria = [], criteriaResults = []) {
  const failedByCode = new Set();
  const failedByLabel = new Set();
  (Array.isArray(criteriaResults) ? criteriaResults : []).forEach((item) => {
    if (!item || item.passed !== false) return;
    const code = normalizeText(item.code);
    const label = stripCriterionLabel(item.label);
    if (code) failedByCode.add(code);
    if (label) failedByLabel.add(label);
  });

  return (Array.isArray(criteria) ? criteria : []).some((criterion) => {
    if (normalizeText(criterion?.penaltyMode) !== 'zero') return false;
    const code = normalizeText(criterion?.code);
    const label = stripCriterionLabel(criterion?.label);
    return (code && failedByCode.has(code)) || (label && failedByLabel.has(label));
  });
}

function resolveEssaySuggestedText(partType, rawPart, criteriaResults) {
  const directSuggestion = normalizeText(
    rawPart?.suggestedText
    ?? rawPart?.revisedText
    ?? rawPart?.rewrite
    ?? rawPart?.rewriteText
    ?? rawPart?.suggestion,
  );
  if (directSuggestion) return directSuggestion;

  if (partType === 'thesis' || partType === 'conclusion') {
    return normalizeText(
      (Array.isArray(criteriaResults) ? criteriaResults : [])
        .map((item) => item?.suggestion)
        .find((item) => normalizeText(item)),
    );
  }

  return '';
}

function sanitizeEssayStringItems(values, limit = 8) {
  if (Array.isArray(values)) {
    return uniqueTextItems(values.map((item) =>
      item && typeof item === 'object' ? item.text : item
    ), limit);
  }

  const single = normalizeText(values);
  return single ? [single] : [];
}

function sanitizeKeywordGroupMatches(values) {
  return (Array.isArray(values) ? values : [])
    .map((item, index) => {
      const label = normalizeText(item?.label) || `核心关键词组${index + 1}`;
      const type = ['judgment', 'object', 'scope'].includes(normalizeText(item?.type)) ? normalizeText(item?.type) : 'judgment';
      const matchedExpressions = sanitizeEssayStringItems(item?.matchedExpressions, 6);
      const missingExpressions = sanitizeEssayStringItems(item?.missingExpressions, 6);
      const hasConfiguredExpressions = matchedExpressions.length > 0 || missingExpressions.length > 0;
      return {
        id: normalizeText(item?.id) || `keyword-group-${index + 1}`,
        label,
        type,
        required: item?.required !== false,
        matched: hasConfiguredExpressions ? Boolean(item?.matched) : null,
        matchedExpressions,
        missingExpressions,
      };
    })
    .filter((item) => item.label);
}

function normalizeKeywordExpressionText(value) {
  return normalizeText(value).replace(/\s+/g, '').toLowerCase();
}

function buildKeywordGroupMatchesFromRuleGroups(ruleGroups = [], excerpt = '') {
  const thesisText = normalizeKeywordExpressionText(excerpt);
  return (Array.isArray(ruleGroups) ? ruleGroups : [])
    .filter((group) => group?.enabled !== false)
    .map((group, index) => {
      const expressions = uniqueTextItems((group?.expressions || []).map((item) =>
        item && typeof item === 'object' ? item.text : item
      ), 10);
      const hasConfiguredExpressions = expressions.length > 0;
      const matchedExpressions = expressions.filter((item) => {
        const normalized = normalizeKeywordExpressionText(item);
        return normalized && thesisText.includes(normalized);
      });
      return {
        id: normalizeText(group?.id) || `keyword-group-${index + 1}`,
        label: normalizeText(group?.label) || `核心关键词组${index + 1}`,
        type: ['judgment', 'object', 'scope'].includes(normalizeText(group?.type)) ? normalizeText(group?.type) : 'judgment',
        required: group?.required !== false,
        matched: hasConfiguredExpressions ? matchedExpressions.length > 0 : null,
        matchedExpressions,
        missingExpressions: matchedExpressions.length ? [] : expressions,
      };
    });
}

function buildKeywordGroupIssues(keywordGroupMatches = []) {
  return keywordGroupMatches
    .filter((item) => item?.matched === false)
    .map((item) => `未命中关键词组：${item.label}`);
}

function buildTagsFromChecks(partType, checks, explicitTags = [], factualErrors = []) {
  const tags = uniqueTextItems(explicitTags, 10);
  const pushTag = (value) => {
    const normalized = normalizeText(value);
    if (normalized && !tags.includes(normalized)) {
      tags.push(normalized);
    }
  };

  if (partType === 'body') {
    if (checks.focusedOnThesis === true) pushTag('围绕论题展开');
    if (checks.focusedOnThesis === false) pushTag('没有围绕论题展开');
    if (checks.isWithinScope === true) pushTag('时空范围准确');
    if (checks.isWithinScope === false) pushTag('超出时空范围');
    if (checks.hasHeading === true) pushTag('有小标题');
    if (checks.hasHeading === false) pushTag('缺少小标题');
    if (checks.hasHistoricalEvidence === true) pushTag('史料充分');
    if (checks.hasHistoricalEvidence === false) pushTag('缺少必要史实');
    if ((checks.hasReasonableExplanation ?? checks.hasAnalysis) === true) pushTag('说明和解释准确合理');
    if ((checks.hasReasonableExplanation ?? checks.hasAnalysis) === false) pushTag('不准确不合理的论述过程');
  } else if (partType === 'conclusion') {
    if ((checks.hasConclusion ?? checks.hasSummary) === true) pushTag('有结论');
    if ((checks.hasConclusion ?? checks.hasSummary) === false) pushTag('缺少结论');
    if (checks.hasElevation === true) pushTag('有升华');
    if (checks.hasElevation === false) pushTag('缺少升华');
  } else {
    if (checks.hasThesis === true) pushTag('有论题');
    if (checks.hasThesis === false) pushTag('缺少论题');
    if (checks.isObjectCorrect === true) pushTag('对象准确');
    if (checks.isObjectCorrect === false) pushTag('对象有误');
    if (checks.isJudgmentCorrect === true) pushTag('判断到位');
    if (checks.isJudgmentCorrect === false) pushTag('判断不到位');
  }

  if ((checks.factualErrorCount || 0) > 0 || factualErrors.length) {
    pushTag('有史实错误');
  }

  return tags.slice(0, 8);
}

function buildFallbackEssayComment(partType, label, tags, issues, factualErrors) {
  const safeLabel = normalizeText(label) || '本部分';
  const positives = sanitizeEssayStringItems(tags, 3);
  const concerns = sanitizeEssayStringItems(issues, 3);
  const errors = sanitizeEssayStringItems(factualErrors, 2);

  if (partType === 'thesis') {
    const positiveSentence = positives.length ? `${safeLabel}${positives.slice(0, 2).join('、')}。` : `${safeLabel}已形成基本观点。`;
    const concernSentence = concerns.length ? `仍需注意${concerns.slice(0, 2).join('、')}。` : '后续可继续把观点和论证对象扣得更紧。';
    return `${positiveSentence}${concernSentence}`;
  }

  if (partType === 'conclusion') {
    const positiveSentence = positives.length ? `${safeLabel}${positives.slice(0, 2).join('、')}。` : `${safeLabel}具备收束全文的作用。`;
    const concernSentence = concerns.length ? `还可以继续补强${concerns.slice(0, 2).join('、')}。` : '若能进一步提炼历史认识，结尾会更完整。';
    return `${positiveSentence}${concernSentence}`;
  }

  const positiveSentence = positives.length ? `${safeLabel}${positives.slice(0, 2).join('、')}。` : `${safeLabel}基本围绕论题展开。`;
  const concernSentence = concerns.length
    ? `需要重点改进${concerns.slice(0, 2).join('、')}。`
    : '后续可继续把史实和分析衔接得更紧一些。';
  const errorSentence = errors.length ? `史实错误：${errors.join('；')}。` : '';
  return `${positiveSentence}${concernSentence}${errorSentence}`;
}

function inferLegacyEssayPart(review = {}) {
  const label = normalizeText(review?.label || review?.sectionLabel);
  const comment = normalizeText(review?.comment);
  const source = `${label} ${comment}`;

  if (/论题|标题|观点/.test(source)) {
    return { kind: 'thesis', index: 0 };
  }
  if (/结论|总结|启示|认识|升华|综上/.test(source)) {
    return { kind: 'conclusion', index: 0 };
  }

  const ordinalRules = [
    { pattern: /第\s*1\s*段|第一段|方面一|第一方面|第一点|第一部分|方面1/, index: 1 },
    { pattern: /第\s*2\s*段|第二段|方面二|第二方面|第二点|第二部分|方面2/, index: 2 },
    { pattern: /第\s*3\s*段|第三段|方面三|第三方面|第三点|第三部分|方面3/, index: 3 },
  ];
  for (const rule of ordinalRules) {
    if (rule.pattern.test(source)) {
      return { kind: 'body', index: rule.index };
    }
  }

  const order = sanitizePositiveInteger(review?.order ?? review?.sectionOrder, 1, 10);
  if (order != null && order >= 2) {
    return { kind: 'body', index: order - 1 };
  }

  return null;
}

function buildLegacyEssayLookup({ pointReviews, sectionReviews }) {
  const sectionSource = Array.isArray(sectionReviews) && sectionReviews.length
    ? sectionReviews.map((review) => ({
      label: review?.label,
      comment: review?.comment,
      score: review?.score,
      fullScore: review?.fullScore,
      matchedExcerpts: review?.matchedExcerpts,
      order: review?.order,
    }))
    : [];

  const groupedPoints = new Map();
  (Array.isArray(pointReviews) ? pointReviews : []).forEach((point) => {
    const sectionKey = normalizeText(point?.sectionKey) || normalizeText(point?.sectionLabel) || `essay-fallback-${groupedPoints.size + 1}`;
    if (!groupedPoints.has(sectionKey)) {
      groupedPoints.set(sectionKey, {
        label: point?.sectionLabel,
        comment: '',
        score: 0,
        fullScore: 0,
        matchedExcerpts: [],
        order: point?.sectionOrder,
      });
    }
    const group = groupedPoints.get(sectionKey);
    group.score += Number(point?.score || 0);
    group.fullScore += Math.max(0, Number(point?.fullScore || 0));
    group.comment = group.comment || normalizeText(point?.comment);
    group.matchedExcerpts.push(...(Array.isArray(point?.matchedExcerpts) ? point.matchedExcerpts : []));
  });

  const reviewItems = sectionSource.length
    ? sectionSource
    : Array.from(groupedPoints.values()).map((item) => ({
      ...item,
      matchedExcerpts: uniqueTextItems(item.matchedExcerpts, 6),
    }));

  const lookup = {
    thesis: null,
    bodySections: new Map(),
    conclusion: null,
  };
  let fallbackBodyIndex = 0;

  reviewItems.forEach((review) => {
    const part = inferLegacyEssayPart(review);
    if (!part) return;

    if (part.kind === 'thesis' && !lookup.thesis) {
      lookup.thesis = review;
      return;
    }

    if (part.kind === 'conclusion' && !lookup.conclusion) {
      lookup.conclusion = review;
      return;
    }

    if (part.kind === 'body') {
      const index = part.index || (++fallbackBodyIndex);
      if (!lookup.bodySections.has(index)) {
        lookup.bodySections.set(index, review);
      }
    }
  });

  return lookup;
}

function normalizeEssayPart(partType, rawPart, fallbackPart, fullScore, criteria = [], keywordGroups = []) {
  const source = normalizeText(fallbackPart?.source);
  const fallbackExcerpt = normalizeText(fallbackPart?.excerpt);
  const explicitComment = normalizeText(rawPart?.comment) || normalizeText(fallbackPart?.comment);
  const issues = sanitizeEssayStringItems(rawPart?.issues || fallbackPart?.issues, 6);
  const factualErrors = sanitizeEssayStringItems(rawPart?.factualErrors || rawPart?.factualErrorList || fallbackPart?.factualErrors, 4);
  const checks = sanitizeEssayChecks(rawPart?.checks || fallbackPart?.checks, partType);
  if (checks.factualErrorCount == null && factualErrors.length) {
    checks.factualErrorCount = factualErrors.length;
  }
  const excerpt = resolveExactExcerpt(source, rawPart?.excerpt, fallbackExcerpt);
  if (partType === 'thesis' && checks.hasThesis == null && excerpt) {
    checks.hasThesis = true;
  }
  if (partType === 'conclusion' && checks.hasConclusion == null && excerpt) {
    checks.hasConclusion = true;
    checks.hasSummary = true;
  }
  if (partType === 'body' && checks.hasReasonableExplanation == null && typeof checks.hasAnalysis === 'boolean') {
    checks.hasReasonableExplanation = checks.hasAnalysis;
  }
  if (partType === 'body' && checks.explainsEvidence == null && typeof checks.hasReasonableExplanation === 'boolean') {
    checks.explainsEvidence = checks.hasReasonableExplanation;
  }
  if (partType === 'body' && checks.linksBackToThesis == null && typeof checks.hasReasonableExplanation === 'boolean') {
    checks.linksBackToThesis = checks.hasReasonableExplanation;
  }
  if (partType === 'body' && checks.isFactuallyAccurate == null && typeof checks.factualErrorCount === 'number') {
    checks.isFactuallyAccurate = checks.factualErrorCount === 0;
  }
  const keywordGroupMatches = (partType === 'thesis' || partType === 'body')
    ? (
      sanitizeKeywordGroupMatches(rawPart?.keywordGroupMatches || fallbackPart?.keywordGroupMatches).length
        ? sanitizeKeywordGroupMatches(rawPart?.keywordGroupMatches || fallbackPart?.keywordGroupMatches)
        : buildKeywordGroupMatchesFromRuleGroups(keywordGroups, excerpt)
    )
    : [];
  if (keywordGroupMatches.length) {
    const matchedObjectGroupCount = countMatchedKeywordGroupsByType(keywordGroupMatches, 'object');
    const matchedJudgmentGroupCount = countMatchedKeywordGroupsByType(keywordGroupMatches, 'judgment');
    const matchedScopeGroupCount = countMatchedKeywordGroupsByType(keywordGroupMatches, 'scope');
    if (partType === 'thesis' && checks.matchedObjectGroupCount == null) {
      checks.matchedObjectGroupCount = matchedObjectGroupCount;
    }
    if (partType === 'thesis' && checks.matchedJudgmentGroupCount == null) {
      checks.matchedJudgmentGroupCount = matchedJudgmentGroupCount;
    }
    if ((partType === 'thesis' || partType === 'body') && checks.matchedScopeGroupCount == null) {
      checks.matchedScopeGroupCount = matchedScopeGroupCount;
    }
    if (partType === 'thesis' && checks.isObjectCorrect == null && hasKeywordGroupsOfType(keywordGroupMatches, 'object')) {
      checks.isObjectCorrect = matchedObjectGroupCount > 0;
    }
    if (partType === 'thesis' && checks.isJudgmentCorrect == null && hasKeywordGroupsOfType(keywordGroupMatches, 'judgment')) {
      checks.isJudgmentCorrect = matchedJudgmentGroupCount > 0;
    }
    if (partType === 'body' && checks.isWithinScope == null && hasKeywordGroupsOfType(keywordGroupMatches, 'scope')) {
      checks.isWithinScope = matchedScopeGroupCount > 0;
    }
  }
  const keywordGroupIssues = buildKeywordGroupIssues(keywordGroupMatches);
  const tags = buildTagsFromChecks(
    partType,
    checks,
    rawPart?.tags || fallbackPart?.tags,
    factualErrors,
  );
  const rawSuggestedText = normalizeText(
    rawPart?.suggestedText
    ?? rawPart?.revisedText
    ?? rawPart?.rewrite
    ?? rawPart?.rewriteText
    ?? rawPart?.suggestion,
  );
  const criteriaResults = buildEssayCriterionResults({
    partType,
    criteria,
    rawResults: rawPart?.criteriaResults || fallbackPart?.criteriaResults,
    checks,
    excerpt,
    factualErrors,
    suggestedText: rawSuggestedText,
  });
  const suggestedText = hasFailedEssayCriterion(criteriaResults)
    ? resolveEssaySuggestedText(partType, rawPart, criteriaResults)
    : '';
  const replacementThesis = partType === 'thesis' && hasTriggeredEssayPenalty(criteriaResults)
    ? normalizeText(rawPart?.replacementThesis || rawPart?.revisedThesis || rawSuggestedText)
    : '';
  const normalizedScore = clampScore(rawPart?.score ?? fallbackPart?.score, fullScore);
  const score = hasZeroPenaltyTriggered(criteria, criteriaResults) ? 0 : normalizedScore;

  return {
    key: normalizeText(rawPart?.key) || normalizeText(fallbackPart?.key),
    label: normalizeText(rawPart?.label) || normalizeText(fallbackPart?.label),
    order: sanitizePositiveInteger(rawPart?.order ?? fallbackPart?.order, 1, 20) || 1,
    score,
    fullScore: Math.max(0, Number(fullScore || 0)),
    excerpt,
    comment: explicitComment || buildFallbackEssayComment(partType, rawPart?.label || fallbackPart?.label, tags, [...issues, ...keywordGroupIssues], factualErrors),
    tags,
    issues: uniqueTextItems([...issues, ...keywordGroupIssues], 8),
    factualErrors,
    checks,
    criteriaResults,
    suggestedText,
    keywordGroupMatches,
    replacementThesis,
  };
}

function textMatchesPattern(values, pattern) {
  return (Array.isArray(values) ? values : [])
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .some((item) => pattern.test(item));
}

function shouldTriggerOffTopicCap(thesis, bodySections, plan) {
  const globalCap = Math.max(0, Number(plan?.globalOffTopicCap || 0));
  if (!globalCap) {
    return false;
  }

  if (textMatchesPattern([
    ...(thesis?.tags || []),
    ...(thesis?.issues || []),
    thesis?.comment,
  ], /(偏题|跑题|离题|不切题)/)) {
    return true;
  }

  if (Array.isArray(bodySections) && bodySections.length && bodySections.every((section) => section?.checks?.focusedOnThesis === false)) {
    return true;
  }

  return false;
}

function applyGlobalCapToSections(sections, cap) {
  const normalizedCap = Math.max(0, Number(cap || 0));
  const nextSections = (Array.isArray(sections) ? sections : []).map((section) => ({
    ...section,
    score: Math.max(0, Number(section?.score || 0)),
  }));
  let remaining = normalizedCap;

  return nextSections.map((section) => {
    const nextScore = Math.max(0, Math.min(Number(section.score || 0), remaining));
    remaining = Math.max(0, remaining - nextScore);
    return {
      ...section,
      score: nextScore,
    };
  });
}

function buildEssayReviewArtifacts({
  question,
  answer,
  essayReview,
  pointReviews,
  sectionReviews,
}) {
  const rawEssayReview = essayReview && typeof essayReview === 'object' ? essayReview : null;
  const hasStructuredEssayReview =
    Boolean(normalizeText(rawEssayReview?.thesis?.excerpt))
    || Boolean(normalizeText(rawEssayReview?.thesis?.comment))
    || (Array.isArray(rawEssayReview?.bodySections) && rawEssayReview.bodySections.some((section) =>
      normalizeText(section?.excerpt) || normalizeText(section?.comment) || typeof section?.score === 'number'
    ))
    || Boolean(normalizeText(rawEssayReview?.conclusion?.excerpt))
    || Boolean(normalizeText(rawEssayReview?.conclusion?.comment));
  const legacyLookup = buildLegacyEssayLookup({ pointReviews, sectionReviews });
  const desiredBodyCount = sanitizeCount(rawEssayReview?.bodySections?.length, 5)
    || sanitizeCount(legacyLookup.bodySections.size, 5)
    || null;
  const initialSections = extractEssaySections(answer, { bodyCount: desiredBodyCount });
  const actualBodyCount = sanitizeCount(rawEssayReview?.bodySections?.length, 5)
    || sanitizeCount(legacyLookup.bodySections.size, 5)
    || sanitizeCount(initialSections.bodySections.length, 5)
    || null;
  const plan = buildEssaySectionPlan(question, answer, { bodySectionCount: actualBodyCount });
  const extractedSections = extractEssaySections(answer, { bodyCount: plan.bodySectionCount });
  const source = normalizeText(answer);

  const thesisFallback = {
    key: 'essay-thesis',
    label: '论题',
    order: 1,
    excerpt: extractedSections.thesis?.excerpt || uniqueTextItems(legacyLookup.thesis?.matchedExcerpts, 1)[0] || '',
    comment: normalizeText(legacyLookup.thesis?.comment),
    score: Number(legacyLookup.thesis?.score || 0),
    source,
  };
  const normalizedThesis = normalizeEssayPart(
    'thesis',
    rawEssayReview?.thesis,
    thesisFallback,
    plan.thesisFullScore,
    plan.thesisCriteria || [],
    question?.essayRuleTree?.thesis?.keywordGroups || [],
  );
  const judgmentMatches = (normalizedThesis.keywordGroupMatches || []).filter((item) => item.type === 'judgment' && item.matched != null);
  if (judgmentMatches.length && !judgmentMatches.some((item) => item.matched === true)) {
    normalizedThesis.score = Math.min(normalizedThesis.score, Math.max(0, normalizedThesis.fullScore - 1));
    if (!normalizedThesis.issues.includes('未命中任何判断型关键词组')) {
      normalizedThesis.issues.push('未命中任何判断型关键词组');
    }
  }
  const objectMatches = (normalizedThesis.keywordGroupMatches || []).filter((item) => item.type === 'object' && item.matched != null);
  if (objectMatches.length && !objectMatches.some((item) => item.matched === true)) {
    normalizedThesis.score = Math.min(normalizedThesis.score, Math.max(0, normalizedThesis.fullScore - 1));
    if (!normalizedThesis.issues.includes('未命中任何对象型关键词组')) {
      normalizedThesis.issues.push('未命中任何对象型关键词组');
    }
  }

  const bodySections = Array.from({ length: plan.bodySectionCount }, (_, index) => {
    const legacyPart = legacyLookup.bodySections.get(index + 1);
    const extractedPart = extractedSections.bodySections[index];
    return normalizeEssayPart(
      'body',
      rawEssayReview?.bodySections?.[index],
      {
        key: extractedPart?.key || `essay-body-${index + 1}`,
        label: extractedPart?.label || plan.bodySectionLabels?.[index] || `第${index + 1}段`,
        order: extractedPart?.order || index + 2,
        excerpt: extractedPart?.excerpt || uniqueTextItems(legacyPart?.matchedExcerpts, 1)[0] || '',
        comment: normalizeText(legacyPart?.comment),
        score: Number(legacyPart?.score || 0),
        source,
      },
      plan.bodySectionScores[index] || 0,
      plan.bodyCriteria?.[index] || [],
      plan.bodyScopeKeywordGroups?.[index] || [],
    );
  }).filter((section) => section.excerpt || section.comment || section.score > 0 || section.fullScore > 0);

  const conclusionFallback = {
    key: 'essay-conclusion',
    label: '结论',
    order: bodySections.length + 2,
    excerpt: extractedSections.conclusion?.excerpt || uniqueTextItems(legacyLookup.conclusion?.matchedExcerpts, 1)[0] || '',
    comment: normalizeText(legacyLookup.conclusion?.comment),
    score: Number(legacyLookup.conclusion?.score || 0),
    source,
  };
  const normalizedConclusion = normalizeEssayPart(
    'conclusion',
    rawEssayReview?.conclusion,
    conclusionFallback,
    plan.conclusionFullScore,
    plan.conclusionCriteria || [],
  );

  const cappedSections = shouldTriggerOffTopicCap(normalizedThesis, bodySections, plan)
    ? applyGlobalCapToSections([normalizedThesis, ...bodySections, normalizedConclusion], plan.globalOffTopicCap)
    : [normalizedThesis, ...bodySections, normalizedConclusion];
  const [cappedThesis, ...restSections] = cappedSections;
  const cappedConclusion = restSections.pop() || normalizedConclusion;
  const cappedBodySections = restSections;

  const orderedSections = [
    cappedThesis,
    ...cappedBodySections,
    cappedConclusion,
  ].filter((item) => item.excerpt || item.comment || item.score > 0 || item.fullScore > 0);

  const derivedPointReviews = orderedSections.map((section) => ({
    key: `${section.key}:summary`,
    sectionKey: section.key,
    sectionLabel: section.label,
    sectionOrder: section.order,
    subquestionIndex: section.order,
    pointOrder: 1,
    pointLabel: section.label,
    score: section.score,
    fullScore: section.fullScore,
    comment: section.comment,
    matchedExcerpts: section.excerpt ? [section.excerpt] : [],
  }));

  const derivedSectionReviews = orderedSections.map((section) => ({
    key: section.key,
    label: section.label,
    order: section.order,
    score: section.score,
    fullScore: section.fullScore,
    comment: section.comment,
    pointKeys: [`${section.key}:summary`],
    matchedExcerpts: section.excerpt ? [section.excerpt] : [],
  }));

  return {
    essayReview: {
      thesis: cappedThesis,
      bodySections: cappedBodySections,
      conclusion: cappedConclusion,
    },
    pointReviews: derivedPointReviews,
    sectionReviews: derivedSectionReviews,
    earnedScore: orderedSections.reduce((sum, section) => sum + Number(section.score || 0), 0),
    requiresReview: !hasStructuredEssayReview,
  };
}

module.exports = {
  buildEssaySectionPlan,
  buildEssayReviewArtifacts,
};
