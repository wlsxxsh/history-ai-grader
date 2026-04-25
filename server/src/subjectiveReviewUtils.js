const {
  extractQuestionSubquestionCatalog,
  normalizeOrdinaryGradingRuleTree,
} = require('./gradingRuleAutoSplit');

function normalizeText(value) {
  return String(value || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function uniqueTextItems(values, limit = 12) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((item) => normalizeText(item)).filter(Boolean))).slice(0, limit);
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

function extractSubquestionIndex(value) {
  const text = normalizeText(value);
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

function isUsableSectionMarkerSequence(markers, expectedMaxOrder = 0) {
  if (!Array.isArray(markers) || markers.length < 2) {
    return false;
  }

  const orders = markers.map((item) => normalizePositiveInteger(item?.index)).filter((item) => item != null);
  if (orders.length !== markers.length) {
    return false;
  }

  if (expectedMaxOrder > 0 && orders.some((order) => order > expectedMaxOrder)) {
    return false;
  }

  for (let index = 1; index < orders.length; index += 1) {
    if (orders[index] <= orders[index - 1]) {
      return false;
    }
  }

  return true;
}

function collectSectionMarkers(source, options = {}) {
  const expectedMaxOrder = normalizePositiveInteger(options?.expectedMaxOrder) || 0;
  let fallbackMarkers = [];
  const patterns = [
    /(^|\n)(\s*)(\([1-9]\d*\)|（[1-9]\d*）)/g,
    /(^|\n)(\s*)([①②③④⑤⑥⑦⑧⑨⑩])/g,
    /(^|\n)(\s*)([一二三四五六七八九十]+[、.．)）])/g,
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

    if (isUsableSectionMarkerSequence(markers, expectedMaxOrder)) {
      return markers;
    }
    if (!fallbackMarkers.length && markers.length === 1) {
      fallbackMarkers = markers;
    }
  }

  return fallbackMarkers;
}

function collectOrdinarySectionCatalog(answer, options = {}) {
  const source = normalizeText(answer);
  if (!source) {
    return [];
  }

  const markers = collectSectionMarkers(source, options);
  if (!markers.length) {
    return [
      {
        key: 'ordinary-1',
        label: '本题',
        order: 1,
        start: 0,
        end: source.length,
        fromAnswerMarker: false,
      },
    ];
  }

  const sections = [];
  const firstMarker = markers[0];
  const leadingText = normalizeText(source.slice(0, firstMarker.start));

  // If the student only wrote a later marker like "(2)", keep the
  // earlier unmarked text as the immediately preceding subquestion.
  if (leadingText && firstMarker.index > 1) {
    const inferredOrder = firstMarker.index - 1;
    sections.push({
      key: `ordinary-${inferredOrder}`,
      label: `（${inferredOrder}）小题`,
      order: inferredOrder,
      start: 0,
      end: firstMarker.start,
      fromAnswerMarker: false,
      inferredFromAnswerGap: true,
    });
  }

  markers.forEach((marker, index) => {
    sections.push({
      key: `ordinary-${marker.index}`,
      label: `（${marker.index}）小题`,
      order: marker.index,
      start: index === 0 && sections.length === 0 ? 0 : marker.start,
      end: markers[index + 1] ? markers[index + 1].start : source.length,
      fromAnswerMarker: true,
      inferredFromAnswerGap: false,
    });
  });

  return sections.filter((section) => Number(section.end || 0) > Number(section.start || 0));
}

function normalizePositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.trunc(numeric);
}

function buildFallbackOrdinarySection(question = {}) {
  const fullScore = Number(question?.score || 0);
  return {
    key: 'ordinary-1',
    label: '本题',
    order: 1,
    fullScore: fullScore > 0 ? fullScore : 0,
  };
}

function buildExpectedOrdinarySectionCatalog(question = {}) {
  const extracted = extractQuestionSubquestionCatalog(question)
    .map((section, index) => {
      const order = normalizePositiveInteger(section?.order) || index + 1;
      return {
        key: `ordinary-${order}`,
        label: normalizeText(section?.label) || `（${order}）小题`,
        order,
        fullScore: Math.max(0, Number(section?.fullScore || 0)),
        prompt: normalizeText(section?.prompt),
      };
    })
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));

  return extracted.length ? extracted : [buildFallbackOrdinarySection(question)];
}

function buildOrdinarySectionContext({ question, answer }) {
  const source = normalizeText(answer);
  const expectedSections = buildExpectedOrdinarySectionCatalog(question);
  const answerSections = source
    ? collectOrdinarySectionCatalog(source, {
      expectedMaxOrder: expectedSections.reduce(
        (max, section) => Math.max(max, normalizePositiveInteger(section?.order) || 0),
        0,
      ),
    })
    : [];
  const answerSectionByOrder = new Map(answerSections.map((section) => [section.order, section]));
  const explicitMarkerSections = answerSections.filter((section) => section.fromAnswerMarker);
  const inferredGapSections = answerSections.filter((section) => section.inferredFromAnswerGap);
  const hasReliableAnswerMarkers =
    explicitMarkerSections.length >= 2
    || (
      explicitMarkerSections.length === 1
      && inferredGapSections.length === 1
      && explicitMarkerSections[0]?.order === 2
      && inferredGapSections[0]?.order === 1
    );

  const resolvedSections = expectedSections.map((section, index) => {
    const answerSection = answerSectionByOrder.get(section.order) || (hasReliableAnswerMarkers ? answerSections[index] : null);
    return {
      ...section,
      start: answerSection?.start ?? 0,
      end: answerSection?.end ?? source.length,
      fromAnswerMarker: Boolean(answerSection?.fromAnswerMarker),
    };
  });

  if (!resolvedSections.length) {
    const fallback = buildFallbackOrdinarySection(question);
    return {
      expectedSections: [fallback],
      answerSections: source ? collectOrdinarySectionCatalog(source) : [],
      resolvedSections: [
        {
          ...fallback,
          start: 0,
          end: source.length,
          fromAnswerMarker: false,
        },
      ],
      hasReliableAnswerMarkers: false,
    };
  }

  if (resolvedSections.length === 1) {
    resolvedSections[0].start = 0;
    resolvedSections[0].end = source.length;
  }

  return {
    expectedSections,
    answerSections,
    resolvedSections,
    hasReliableAnswerMarkers,
  };
}

const ESSAY_SECTION_DEFINITIONS = [
  { key: 'essay-thesis', label: '论题', order: 1, patterns: [/论题|标题|观点/] },
  { key: 'essay-aspect-1', label: '方面一', order: 2, patterns: [/方面一|第一方面|方面1|第一点|角度一|第一部分/] },
  { key: 'essay-aspect-2', label: '方面二', order: 3, patterns: [/方面二|第二方面|方面2|第二点|角度二|第二部分/] },
  { key: 'essay-aspect-3', label: '方面三', order: 4, patterns: [/方面三|第三方面|方面3|第三点|角度三|第三部分/] },
  { key: 'essay-conclusion', label: '结论', order: 5, patterns: [/结论|总结|启示|认识|升华/] },
];

function inferEssaySectionDefinition(value) {
  const text = normalizeText(value);
  if (!text) return null;

  for (const definition of ESSAY_SECTION_DEFINITIONS) {
    if (definition.patterns.some((pattern) => pattern.test(text))) {
      return definition;
    }
  }

  return null;
}

function findRangeInWindow(source, needle, windowStart = 0, windowEnd = source.length) {
  if (!source || !needle) return null;

  let index = source.indexOf(needle, Math.max(0, windowStart));
  while (index !== -1) {
    const end = index + needle.length;
    if (index >= windowStart && end <= windowEnd) {
      return { start: index, end };
    }
    index = source.indexOf(needle, index + 1);
  }

  return null;
}

function findOrdinarySectionByExcerpt(source, excerpt, catalog) {
  const needle = normalizeText(excerpt);
  if (!needle) return null;

  for (const section of catalog) {
    const range = findRangeInWindow(source, needle, section.start, section.end);
    if (range) {
      return section;
    }
  }

  return null;
}

function findSectionByOrder(catalog, order) {
  const normalizedOrder = normalizePositiveInteger(order);
  if (normalizedOrder == null) return null;
  return (Array.isArray(catalog) ? catalog : []).find((section) => section.order === normalizedOrder) || null;
}

function buildDynamicOrdinarySection(order, source) {
  return {
    key: `ordinary-${order}`,
    label: `（${order}）小题`,
    order,
    fullScore: 0,
    start: 0,
    end: source.length,
    fromAnswerMarker: false,
  };
}

function resolveOrdinarySectionDescriptor({ subquestionIndex, sectionLabel, pointLabel, matchedExcerpts, sectionContext, source, fallbackCursor }) {
  const expectedCatalog = sectionContext?.resolvedSections || [];
  const answerCatalog = sectionContext?.answerSections || [];
  const explicitIndex = normalizePositiveInteger(subquestionIndex)
    || extractSubquestionIndex(sectionLabel)
    || extractSubquestionIndex(pointLabel);
  const explicitSection = explicitIndex != null
    ? findSectionByOrder(expectedCatalog, explicitIndex) || (expectedCatalog.length ? null : buildDynamicOrdinarySection(explicitIndex, source))
    : null;
  const excerptSection = sectionContext?.hasReliableAnswerMarkers
    ? matchedExcerpts.map((excerpt) => findOrdinarySectionByExcerpt(source, excerpt, answerCatalog)).find(Boolean)
    : null;
  const excerptResolved = excerptSection
    ? findSectionByOrder(expectedCatalog, excerptSection.order) || (expectedCatalog.length ? null : buildDynamicOrdinarySection(excerptSection.order, source))
    : null;

  if (excerptResolved && explicitSection && excerptResolved.order !== explicitSection.order) {
    return {
      ...excerptResolved,
      explicitIndex: explicitSection.order,
      excerptIndex: excerptResolved.order,
      sectionConflict: true,
      sectionResolutionSource: 'excerpt',
    };
  }

  if (explicitSection) {
    return {
      ...explicitSection,
      explicitIndex: explicitSection.order,
      excerptIndex: excerptResolved?.order || null,
      sectionConflict: false,
      sectionResolutionSource: 'explicit',
    };
  }

  if (excerptResolved) {
    return {
      ...excerptResolved,
      explicitIndex: null,
      excerptIndex: excerptResolved.order,
      sectionConflict: false,
      sectionResolutionSource: 'excerpt',
    };
  }

  const fallbackSection =
    expectedCatalog[Math.min(fallbackCursor.current, Math.max(0, expectedCatalog.length - 1))]
    || buildDynamicOrdinarySection(1, source);
  return {
    ...fallbackSection,
    explicitIndex: null,
    excerptIndex: null,
    sectionConflict: false,
    sectionResolutionSource: 'fallback',
  };
}

function createEssayExtraDescriptor(value, index) {
  const text = normalizeText(value) || `补充点评${index}`;
  return {
    key: `essay-extra-${index}`,
    label: text,
    order: 100 + index,
  };
}

function resolveEssaySectionDescriptor({ sectionLabel, pointLabel, fallbackExtraCount }) {
  const matched = inferEssaySectionDefinition(sectionLabel) || inferEssaySectionDefinition(pointLabel);
  if (matched) return matched;

  fallbackExtraCount.current += 1;
  return createEssayExtraDescriptor(sectionLabel || pointLabel, fallbackExtraCount.current);
}

function normalizeScoringKey(value) {
  return normalizeText(value)
    .replace(/[^\u4E00-\u9FFFA-Za-z0-9]/g, '')
    .toLowerCase();
}

function buildConceptBigrams(text) {
  const compact = normalizeScoringKey(text);
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

function scoreStructuredCandidateMatch(sourceText, candidateText) {
  const normalizedSource = normalizeScoringKey(sourceText);
  const normalizedCandidate = normalizeScoringKey(candidateText);
  if (!normalizedSource || !normalizedCandidate) {
    return 0;
  }
  if (normalizedSource === normalizedCandidate) {
    return 1;
  }
  if (normalizedSource.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedSource)) {
    return 0.92;
  }
  return computeConceptSimilarity(normalizedSource, normalizedCandidate);
}

function buildStructuredOrdinarySubquestionCatalog(question = {}) {
  if (String(question?.type || '').toLowerCase() === 'essay') {
    return [];
  }

  const tree = normalizeOrdinaryGradingRuleTree(question?.gradingRuleTree, question);
  if (!tree?.sections?.length) {
    return [];
  }

  return tree.sections.flatMap((section, sectionIndex) => {
    const sectionOrder = sectionIndex + 1;
    const sectionKey = `ordinary-${sectionOrder}`;
    const sectionLabel = normalizeText(section?.label) || `（${sectionOrder}）小题`;

    return (Array.isArray(section?.subquestions) ? section.subquestions : []).map((subquestion, subquestionIndex) => ({
      id: String(subquestion?.id || `${sectionKey}:subquestion-${subquestionIndex + 1}`),
      sectionKey,
      sectionLabel,
      sectionOrder,
      label: normalizeText(subquestion?.label) || `${sectionLabel}子问题${subquestionIndex + 1}`,
      score: Math.max(0, Number(subquestion?.score || 0)),
      pickEnabled: Boolean(subquestion?.pickEnabled),
      pickCount: Boolean(subquestion?.pickEnabled) ? normalizePositiveInteger(subquestion?.pickCount) : null,
      points: (Array.isArray(subquestion?.points) ? subquestion.points : []).map((point, pointIndex) => ({
        id: String(point?.id || `${sectionKey}:point-${pointIndex + 1}`),
        label: normalizeText(point?.label) || `要点${pointIndex + 1}`,
        score: Math.max(0, Number(point?.score || 0)),
        candidates: uniqueTextItems([
          normalizeText(point?.label),
          ...((Array.isArray(point?.aliases) ? point.aliases : []).map((alias) => normalizeText(alias))),
          normalizeText(subquestion?.label),
        ], 24),
      })),
    }));
  });
}

function matchStructuredOrdinaryPoint({ pointLabel, matchedExcerpts }, structuredSubquestions = []) {
  const reviewSources = uniqueTextItems([
    normalizeText(pointLabel),
    ...((Array.isArray(matchedExcerpts) ? matchedExcerpts : []).map((item) => normalizeText(item))),
  ], 12);
  if (!reviewSources.length || !structuredSubquestions.length) {
    return null;
  }

  let bestMatch = null;

  structuredSubquestions.forEach((subquestion) => {
    (Array.isArray(subquestion?.points) ? subquestion.points : []).forEach((point) => {
      const candidateTexts = uniqueTextItems(point?.candidates, 24);
      reviewSources.forEach((reviewText) => {
        candidateTexts.forEach((candidateText) => {
          const score = scoreStructuredCandidateMatch(reviewText, candidateText);
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = {
              score,
              sectionKey: subquestion.sectionKey,
              sectionLabel: subquestion.sectionLabel,
              sectionOrder: subquestion.sectionOrder,
              subquestionId: subquestion.id,
              subquestionLabel: subquestion.label,
              pickEnabled: Boolean(subquestion.pickEnabled),
              pickCount: subquestion.pickCount || null,
              pointId: point.id,
            };
          }
        });
      });
    });
  });

  return bestMatch && bestMatch.score >= 0.28 ? bestMatch : null;
}

function prioritizeStructuredPointReviews(reviews = []) {
  return reviews
    .slice()
    .sort((left, right) =>
      Number(right.score || 0) - Number(left.score || 0)
      || Number(right.structuredMatchScore || 0) - Number(left.structuredMatchScore || 0)
      || Number(left.pointOrder || 0) - Number(right.pointOrder || 0));
}

function limitStructuredOrdinaryPointReviews(pointReviews = [], structuredSubquestions = []) {
  const subquestionMap = new Map(
    structuredSubquestions.map((subquestion) => [String(subquestion.id || '').trim(), subquestion]),
  );
  if (!subquestionMap.size) {
    return pointReviews;
  }

  const allowedPositiveIndexes = new Set();
  const positiveReviewGroups = new Map();

  pointReviews.forEach((review, index) => {
    const subquestionId = String(review?.structuredSubquestionId || '').trim();
    const score = Number(review?.score || 0);

    if (!subquestionId || !subquestionMap.has(subquestionId) || score <= 0) {
      return;
    }

    if (!positiveReviewGroups.has(subquestionId)) {
      positiveReviewGroups.set(subquestionId, []);
    }
    positiveReviewGroups.get(subquestionId).push({ ...review, __originalIndex: index });
  });

  positiveReviewGroups.forEach((groupedReviews, subquestionId) => {
    const subquestion = subquestionMap.get(subquestionId);
    if (!subquestion) {
      return;
    }

    const dedupedReviews = [];
    const seenStructuredPointIds = new Set();

    prioritizeStructuredPointReviews(groupedReviews).forEach((review) => {
      const structuredPointId = String(review.structuredPointId || '').trim();
      if (structuredPointId) {
        if (seenStructuredPointIds.has(structuredPointId)) {
          return;
        }
        seenStructuredPointIds.add(structuredPointId);
      }
      dedupedReviews.push(review);
    });

    const limit = Boolean(subquestion.pickEnabled) && normalizePositiveInteger(subquestion.pickCount)
      ? normalizePositiveInteger(subquestion.pickCount)
      : null;
    const chosenReviews = limit ? dedupedReviews.slice(0, limit) : dedupedReviews;
    chosenReviews.forEach((review) => allowedPositiveIndexes.add(review.__originalIndex));
  });

  return pointReviews.filter((review, index) => {
    const subquestionId = String(review?.structuredSubquestionId || '').trim();
    const score = Number(review?.score || 0);
    if (!subquestionId || !subquestionMap.has(subquestionId) || score <= 0) {
      return true;
    }
    return allowedPositiveIndexes.has(index);
  });
}

function normalizePointReviews({ questionType, question, answer, pointReviews, sectionContext }) {
  const source = normalizeText(answer);
  const ordinaryContext = questionType === 'essay'
    ? null
    : (sectionContext || buildOrdinarySectionContext({ question, answer: source }));
  const structuredOrdinarySubquestions = questionType === 'essay'
    ? []
    : buildStructuredOrdinarySubquestionCatalog(question);
  const ordinaryFallbackCursor = { current: 0 };
  const essayExtraCount = { current: 0 };

  const normalizedReviews = (Array.isArray(pointReviews) ? pointReviews : [])
    .map((item, index) => {
      const rawPointLabel = normalizeText(item?.pointLabel) || `要点${index + 1}`;
      const sectionLabel = normalizeText(item?.sectionLabel);
      const subquestionIndex = normalizePositiveInteger(item?.subquestionIndex);
      const matchedExcerpts = uniqueTextItems(item?.matchedExcerpts, 8);
      const fullScoreRaw = Number(item?.fullScore ?? 0);
      const fullScore = Number.isFinite(fullScoreRaw) ? Math.max(0, fullScoreRaw) : 0;
      const scoreRaw = Number(item?.score ?? 0);
      const score = fullScore > 0
        ? Math.max(0, Math.min(fullScore, Number.isFinite(scoreRaw) ? scoreRaw : 0))
        : (Number.isFinite(scoreRaw) ? Math.max(0, scoreRaw) : 0);
      const comment = normalizeText(item?.comment);
      const structuredMatch = questionType === 'essay'
        ? null
        : matchStructuredOrdinaryPoint({
          pointLabel: rawPointLabel,
          matchedExcerpts,
        }, structuredOrdinarySubquestions);

      const descriptor = structuredMatch
        ? {
          key: structuredMatch.sectionKey,
          label: structuredMatch.sectionLabel,
          order: structuredMatch.sectionOrder,
          explicitIndex: structuredMatch.sectionOrder,
          excerptIndex: null,
          sectionConflict: false,
          sectionResolutionSource: 'structured',
        }
        : questionType === 'essay'
        ? resolveEssaySectionDescriptor({
            sectionLabel,
            pointLabel: rawPointLabel,
            fallbackExtraCount: essayExtraCount,
          })
        : resolveOrdinarySectionDescriptor({
            subquestionIndex,
            sectionLabel,
            pointLabel: rawPointLabel,
            matchedExcerpts,
            sectionContext: ordinaryContext,
            source,
            fallbackCursor: ordinaryFallbackCursor,
          });

      if (
        questionType !== 'essay'
        && ordinaryContext?.resolvedSections?.length > 1
        && ordinaryFallbackCursor.current < ordinaryContext.resolvedSections.length - 1
      ) {
        ordinaryFallbackCursor.current += 1;
      }

      return {
        key: `${descriptor.key}:point-${index + 1}`,
        sectionKey: descriptor.key,
        sectionLabel: descriptor.label,
        sectionOrder: descriptor.order,
        subquestionIndex: descriptor.order,
        pointOrder: index + 1,
        pointLabel: sanitizeDisplayPointLabel(rawPointLabel, `要点${index + 1}`),
        score,
        fullScore,
        comment,
        matchedExcerpts,
        explicitSubquestionIndex: descriptor.explicitIndex ?? null,
        excerptSubquestionIndex: descriptor.excerptIndex ?? null,
        sectionConflict: Boolean(descriptor.sectionConflict),
        sectionResolutionSource: descriptor.sectionResolutionSource || '',
        structuredSubquestionId: structuredMatch?.subquestionId || '',
        structuredSubquestionLabel: structuredMatch?.subquestionLabel || '',
        structuredPointId: structuredMatch?.pointId || '',
        structuredMatchScore: structuredMatch?.score || 0,
        structuredPickCount: structuredMatch?.pickCount || null,
      };
    })
    .filter((review) => review.comment || review.matchedExcerpts.length || review.fullScore > 0 || review.score > 0);

  return questionType === 'essay'
    ? normalizedReviews
    : limitStructuredOrdinaryPointReviews(normalizedReviews, structuredOrdinarySubquestions);
}

function formatScore(value) {
  const numeric = Number(value || 0);
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(1).replace(/\.0$/, '');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncateText(value, maxLength = 16) {
  const text = normalizeText(value);
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function stripPointLabelDecorations(value) {
  return normalizeText(value)
    .replace(/^第\s*/, '')
    .replace(/^[（(]\d+[）)]小题/, '')
    .replace(/\(Split\s*\d+\)$/i, '')
    .replace(/（拆分\d+）$/, '')
    .replace(/^(?:内容|背景|目的|作用|意义|影响|特点|原因|措施|结果|评价|启示|论题|论点|史实|分析|结论|方面[一二三四五六七八九十\d]*)\s*(?:部分)?\s*(?:采分点|评分点|要点)\s*\d+\s*[:：\-]?\s*/i, '')
    .replace(/^(?:采分点|评分点|要点)\s*\d+\s*[:：\-]?\s*/i, '')
    .replace(/^(?:内容|背景|目的|作用|意义|影响|特点|原因|措施|结果|评价|启示|论题|论点|史实|分析|结论|方面[一二三四五六七八九十\d]*)\s*[:：\-]\s*/i, '')
    .replace(/^采分点\d*$/, '')
    .replace(/^评分点\d*$/, '')
    .replace(/^要点\d*$/, '')
    .replace(/^Point\s*\d+$/i, '')
    .replace(/^[:：\-\s]+/, '')
    .trim();
}

function normalizePointFocusLabel(value) {
  return stripPointLabelDecorations(value);
}

function sanitizeDisplayPointLabel(value, fallbackLabel) {
  const cleaned = stripPointLabelDecorations(value);
  if (cleaned) return cleaned;
  return normalizeText(fallbackLabel) || '要点';
}

function getPointFocus(point) {
  const excerpt = uniqueTextItems(point?.matchedExcerpts, 1)[0];
  if (excerpt) {
    return `“${truncateText(excerpt, 14)}”`;
  }

  const label = normalizePointFocusLabel(point?.pointLabel || point?.label);
  if (label && !/^要点\d*$/.test(label)) {
    return `“${truncateText(label, 12)}”`;
  }

  return '';
}

function collectPointFocuses(points, predicate, limit = 2) {
  return uniqueTextItems(
    (Array.isArray(points) ? points : [])
      .filter((point) => (typeof predicate === 'function' ? predicate(point) : true))
      .map((point) => getPointFocus(point))
      .filter(Boolean),
    limit,
  );
}

function getCustomRoleFlags(customRolePrompt) {
  const custom = normalizeText(customRolePrompt);
  return {
    hasCustom: Boolean(custom),
    warm: /(温柔|鼓励|支持|信心|勇气|陪伴|助教|亲切|耐心)/.test(custom),
    cute: /(可爱|俏皮|活泼|轻松|软萌)/.test(custom),
  };
}

function stripSectionCommentPrefix({ comment, sectionLabel, score, fullScore }) {
  let normalized = normalizeText(comment);
  if (!normalized) return '';

  const patterns = [];
  const label = normalizeText(sectionLabel);
  if (label) {
    patterns.push(new RegExp(`^${escapeRegExp(label)}\\s*`));
    patterns.push(new RegExp(`^第\\s*${escapeRegExp(label)}\\s*`));
    patterns.push(new RegExp(`^${escapeRegExp(label)}\\s*得分\\s*`));
    patterns.push(new RegExp(`^第\\s*${escapeRegExp(label)}\\s*得分\\s*`));
  }

  if (Number.isFinite(Number(score)) && Number.isFinite(Number(fullScore)) && Number(fullScore) > 0) {
    const scoreText = formatScore(score);
    const fullScoreText = formatScore(fullScore);
    patterns.push(new RegExp(`^得分\\s*${escapeRegExp(scoreText)}\\s*/\\s*${escapeRegExp(fullScoreText)}\\s*分?[。．]?\\s*`));
    patterns.push(new RegExp(`^${escapeRegExp(scoreText)}\\s*/\\s*${escapeRegExp(fullScoreText)}\\s*分?[。．]?\\s*`));
  }

  patterns.push(/^第?\s*[（(]\d+[）)]小题\s*得分\s*/);
  patterns.push(/^第?\s*[（(]\d+[）)]小题\s*/);

  for (let index = 0; index < 4; index += 1) {
    let updated = normalized;
    patterns.forEach((pattern) => {
      updated = updated.replace(pattern, '').trim();
    });
    updated = updated.replace(/^得分\s*/, '').trim();
    updated = updated.replace(/^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*分?[。．]?\s*/, '').trim();
    if (updated === normalized) break;
    normalized = updated;
  }

  return normalized.trim();
}

function getRoleStyleTokens({ rolePreset, customRolePrompt }) {
  const customFlags = getCustomRoleFlags(customRolePrompt);
  if (rolePreset === 'strict' && !customFlags.warm) {
    return {
      praiseLead: '本小题作答较完整，主要信息基本到位。',
      midLead: '本小题已覆盖部分关键信息，但完整性不足。',
      weakLead: '本小题关键内容覆盖不足，失分较多。',
      questionPraiseLead: '本题作答较完整，主要信息基本到位。',
      questionMidLead: '本题已覆盖部分关键信息，但还需补足遗漏内容。',
      questionWeakLead: '本题失分较多，关键内容仍需系统补强。',
      overallPraiseLead: '本轮主观题整体作答较完整，基础较扎实。',
      overallMidLead: '本轮主观题已有一定基础，但还有提升空间。',
      overallWeakLead: '本轮主观题整体失分较多，需要针对性补强。',
      advicePrefix: '建议优先',
      keepPrefix: '建议继续',
      encourageHigh: '后续继续保持答题完整度。',
      encourageMid: '把遗漏内容补齐后，得分会更稳定。',
      encourageLow: '建议回到失分点逐条复盘。',
    };
  }
  if (rolePreset === 'gentle' || customFlags.warm) {
    return {
      praiseLead: '本小题主要方向正确，作答比较完整。',
      midLead: '本小题已经答到部分关键内容，再补充会更完整。',
      weakLead: '本小题目前遗漏较多，但已经有一定基础。',
      questionPraiseLead: '本题整体方向正确，关键信息比较完整。',
      questionMidLead: '本题已经具备基础，再补足遗漏内容会更完整。',
      questionWeakLead: '本题目前失分较多，仍需补强关键内容。',
      overallPraiseLead: '本轮主观题整体表现较好，基础比较扎实。',
      overallMidLead: '本轮主观题已经有一定基础，还可以继续提升。',
      overallWeakLead: '本轮主观题还有较大提升空间，需要继续梳理失分点。',
      advicePrefix: '建议先',
      keepPrefix: '建议继续',
      encourageHigh: '继续保持这种作答状态。',
      encourageMid: '把遗漏内容补齐后，得分会更稳定。',
      encourageLow: '建议按失分点逐条复盘，再重新整理答案。',
    };
  }
  return {
    praiseLead: '本小题完成度较高。',
    midLead: '本小题已覆盖部分关键信息，仍有改进空间。',
    weakLead: '本小题关键内容覆盖不足。',
    questionPraiseLead: '本题整体完成度较高。',
    questionMidLead: '本题整体已有基础，但还可以更完整。',
    questionWeakLead: '本题整体失分较多，需要针对性补强。',
    overallPraiseLead: '本轮主观题整体完成度较高。',
    overallMidLead: '本轮主观题整体处于中间水平，还有提升空间。',
    overallWeakLead: '本轮主观题整体失分偏多，需要梳理知识漏洞。',
    advicePrefix: '建议',
    keepPrefix: '建议继续',
    encourageHigh: '继续保持当前完成度。',
    encourageMid: '把遗漏内容补齐后会更稳定。',
    encourageLow: '沿着失分点复盘会更有效。',
  };
}

function buildAdviceSentence({ missedLabels, questionType, advicePrefix, keepPrefix }) {
  if (missedLabels.length) {
    return `${advicePrefix}复习 ${missedLabels.slice(0, 2).join('、')}，并在作答时按要点分句呈现。`;
  }
  if (questionType === 'essay') {
    return `${keepPrefix}使用“观点-史实-分析-结论”的结构表达，巩固稳定得分能力。`;
  }
  return `${keepPrefix}使用“结论+关键词史实”作答结构，保持要点命中率。`;
}

function buildSectionAdviceSentence({ questionType, ratio, advicePrefix, keepPrefix }) {
  if (questionType === 'essay') {
    if (ratio >= 0.85) {
      return `${keepPrefix}保持“观点-史实-分析-结论”的表达顺序，继续提升论述完整度。`;
    }
    if (ratio >= 0.5) {
      return `${advicePrefix}按“观点-史实-分析”补充遗漏内容，结论尽量收束清楚。`;
    }
    return `${advicePrefix}先梳理论点和史实对应关系，再按“观点-史实-分析-结论”重写答案。`;
  }

  if (ratio >= 0.85) {
    return `${keepPrefix}保持分点作答，注意把表述写得更完整、更准确。`;
  }
  if (ratio >= 0.5) {
    return `${advicePrefix}按要点分句作答，并补足遗漏内容。`;
  }
  return `${advicePrefix}先对照参考答案梳理关键要点，再按顺序完整作答。`;
}

function collectSectionPointTerms(points) {
  return uniqueTextItems(
    (Array.isArray(points) ? points : [])
      .map((point) => normalizePointFocusLabel(point?.pointLabel || point?.label))
      .filter((label) => label && label.length >= 2 && !/^要点\d*$/.test(label)),
    6,
  );
}

function countSentences(value) {
  return normalizeText(value)
    .split(/[。！？!?]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .length;
}

function hasInformalAiTone(comment) {
  return /(挺稳|在线|有感觉|别灰心|别慌|啦|呀|哦|冲一冲|漂亮|稳住)/.test(normalizeText(comment));
}

function shouldRegenerateSectionComment({ comment, points }) {
  const normalized = normalizeText(comment);
  if (!normalized) return true;
  if (hasInformalAiTone(normalized)) return true;
  if (/采分点|评分点|得分点|命中片段|匹配片段|matchedExcerpts|\/\s*\d+(?:\.\d+)?\s*分|得分\s*\d/.test(normalized)) {
    return true;
  }
  if (countSentences(normalized) > 2 || normalized.length > 80) return true;
  void points;
  return false;
}

function applyCustomStylePrefix(comment, customRolePrompt, ratio = 0.6) {
  void customRolePrompt;
  void ratio;
  return comment;
}

function normalizeSectionComments(values) {
  return (Array.isArray(values) ? values : [])
    .map((item) => ({
      subquestionIndex: normalizePositiveInteger(item?.subquestionIndex) || extractSubquestionIndex(item?.sectionLabel),
      sectionLabel: normalizeText(item?.sectionLabel),
      comment: normalizeText(item?.comment),
    }))
    .filter((item) => item.comment);
}

function resolveSectionComment({ section, sectionComments }) {
  if (!sectionComments.length) return '';
  if (sectionComments.length === 1 && !normalizeText(sectionComments[0].sectionLabel)) {
    return sectionComments[0].comment;
  }

  const normalizedLabel = normalizeText(section.label);
  const sectionOrder = Number(section.order || 0);
  if (sectionOrder > 0) {
    const byIndex = sectionComments.find((item) => Number(item.subquestionIndex || 0) === sectionOrder);
    if (byIndex?.comment) return byIndex.comment;
  }

  if (normalizedLabel) {
    const byLabel = sectionComments.find((item) => normalizeText(item.sectionLabel) === normalizedLabel);
    if (byLabel?.comment) return byLabel.comment;
  }

  if (sectionOrder > 0) {
    const byOrder = sectionComments.find((item) => extractSubquestionIndex(item.sectionLabel) === sectionOrder);
    if (byOrder?.comment) return byOrder.comment;
  }

  const byFuzzy = sectionComments.find((item) => {
    const candidate = normalizeText(item.sectionLabel);
    return candidate && normalizedLabel && (candidate.includes(normalizedLabel) || normalizedLabel.includes(candidate));
  });
  return byFuzzy?.comment || '';
}

function ensureActionableComment({ comment, points, questionType, rolePreset, customRolePrompt, sectionLabel, sectionScore, sectionFullScore }) {
  const normalized = stripSectionCommentPrefix({
    comment,
    sectionLabel,
    score: sectionScore,
    fullScore: sectionFullScore,
  });
  if (!normalized) return '';

  const ratio = Number(sectionFullScore || 0) > 0 ? Number(sectionScore || 0) / Number(sectionFullScore || 1) : 0.6;
  if (shouldRegenerateSectionComment({ comment: normalized, points })) {
    return '';
  }

  const hasAdvice = /(建议|复习|练习|下一步|先|再|补充|改进|注意)/.test(normalized);
  if (hasAdvice) {
    return applyCustomStylePrefix(normalized, customRolePrompt, ratio);
  }

  const { advicePrefix, keepPrefix } = getRoleStyleTokens({ rolePreset, customRolePrompt });
  const advice = buildSectionAdviceSentence({
    questionType,
    ratio,
    advicePrefix,
    keepPrefix,
  });
  const merged = `${normalized}${/[。！？]$/.test(normalized) ? '' : '。'}${advice}`;
  return applyCustomStylePrefix(merged, customRolePrompt, ratio);
}

function buildGeneratedSectionComment({ sectionLabel, points, questionType, rolePreset, customRolePrompt }) {
  void sectionLabel;
  if (!points.length) {
    const emptyComment = '本小题暂未形成有效评分信息。建议结合参考答案核对关键要点后再人工复核。';
    return applyCustomStylePrefix(emptyComment, customRolePrompt, 0.3);
  }

  const score = points.reduce((sum, point) => sum + Number(point.score || 0), 0);
  const fullScore = points.reduce((sum, point) => sum + Math.max(0, Number(point.fullScore || 0)), 0);
  const ratio = fullScore > 0 ? score / fullScore : 0;
  const hitTerms = collectSectionPointTerms(points.filter((point) => Number(point.score || 0) > 0));
  const missedTerms = collectSectionPointTerms(points.filter((point) => Number(point.score || 0) < Math.max(0, Number(point.fullScore || 0))));
  const tokens = getRoleStyleTokens({ rolePreset, customRolePrompt });

  const lead = ratio >= 0.85
    ? tokens.praiseLead
    : ratio >= 0.5
      ? tokens.midLead
      : tokens.weakLead;
  const detail = hitTerms.length && missedTerms.length
    ? `已答到${hitTerms.slice(0, 1).join('、')}等内容，但${missedTerms.slice(0, 1).join('、')}还不够完整。`
    : hitTerms.length
      ? `已答到${hitTerms.slice(0, 2).join('、')}等主要内容。`
      : missedTerms.length
        ? `${missedTerms.slice(0, 1).join('、')}这部分仍需补足。`
        : '';
  const advice = missedTerms.length
    ? (questionType === 'essay'
      ? `${tokens.advicePrefix}围绕${missedTerms.slice(0, 1).join('、')}补充史实和分析，结论尽量收束清楚。`
      : `${tokens.advicePrefix}围绕${missedTerms.slice(0, 1).join('、')}补充关键表述，并按要点分句作答。`)
    : buildSectionAdviceSentence({
        questionType,
        ratio,
        advicePrefix: tokens.advicePrefix,
        keepPrefix: tokens.keepPrefix,
      });
  const comment = `${lead}${detail}${advice}`;
  return applyCustomStylePrefix(comment, customRolePrompt, ratio);
}

function isGenericSectionComment({ comment, sectionLabel }) {
  const normalized = normalizeText(comment);
  if (!normalized) return true;

  const label = normalizeText(sectionLabel);
  if (label) {
    const genericPatterns = [
      new RegExp(`命中\\s*${escapeRegExp(label)}\\s*等要点`),
      new RegExp(`补足\\s*${escapeRegExp(label)}`),
      new RegExp(`复习\\s*${escapeRegExp(label)}`),
      new RegExp(`还需补足\\s*${escapeRegExp(label)}`),
    ];
    if (genericPatterns.some((pattern) => pattern.test(normalized))) {
      return true;
    }
  }

  return /本小题已经抓住了部分要点|本小题已经抓到一部分关键点|本小题现在还不够稳|本小题暂时还没发挥开/.test(normalized)
    && !/[“"]/.test(normalized);
}

function buildQuestionComment({ questionScore, earnedScore, questionType, pointReviews, sectionReviews, rolePreset, customRolePrompt }) {
  const score = Number(earnedScore || 0);
  const fullScore = Math.max(0, Number(questionScore || 0));
  const ratio = fullScore > 0 ? score / fullScore : 0;
  const tokens = getRoleStyleTokens({ rolePreset, customRolePrompt });
  const hitLabels = collectPointFocuses(pointReviews, (point) => Number(point.score || 0) > 0, 2);
  const missedLabels = collectPointFocuses(pointReviews, (point) => Number(point.score || 0) < Math.max(0, Number(point.fullScore || 0)), 2);
  const strongSections = uniqueTextItems(
    (sectionReviews || [])
      .filter((section) => Number(section.fullScore || 0) > 0 && Number(section.score || 0) / Number(section.fullScore || 1) >= 0.85)
      .map((section) => section.label),
    2,
  );
  const weakSections = uniqueTextItems(
    (sectionReviews || [])
      .filter((section) => Number(section.fullScore || 0) > 0 && Number(section.score || 0) / Number(section.fullScore || 1) < 0.85)
      .map((section) => section.label),
    2,
  );

  const lead = ratio >= 0.85
    ? tokens.questionPraiseLead
    : ratio >= 0.5
      ? tokens.questionMidLead
      : tokens.questionWeakLead;
  const strengths = hitLabels.length
    ? `像 ${hitLabels.join('、')} 这些关键点，你处理得比较到位。`
    : strongSections.length
      ? `${strongSections.join('、')} 这些部分完成度相对更高。`
      : '已经能看出你有一定基础。';
  const weaknesses = missedLabels.length
    ? `后面要重点补上 ${missedLabels.join('、')} 这部分。`
    : weakSections.length
      ? `接下来可以重点回看 ${weakSections.join('、')} 的失分点。`
      : '主要得分点已经比较完整。';
  const guidancePrefix = ratio >= 0.85 ? tokens.keepPrefix : tokens.advicePrefix;
  const advice = questionType === 'essay'
    ? `${guidancePrefix}把“论点-史实-分析-结论”串得更紧一些，论述会更有说服力。`
    : `${guidancePrefix}按要点分句作答，尤其把“作用、影响、局限”这类容易漏掉的角度答全。`;
  const encouragement = ratio >= 0.85 ? tokens.encourageHigh : ratio >= 0.5 ? tokens.encourageMid : tokens.encourageLow;

  return applyCustomStylePrefix(`${lead}${strengths}${weaknesses}${advice}${encouragement}`, customRolePrompt, ratio);
}

function buildOverallComment({ totalScore, earnedScore, questionGrades, rolePreset, customRolePrompt }) {
  const score = Number(earnedScore || 0);
  const fullScore = Math.max(0, Number(totalScore || 0));
  const ratio = fullScore > 0 ? score / fullScore : 0;
  const tokens = getRoleStyleTokens({ rolePreset, customRolePrompt });
  const allPointReviews = (Array.isArray(questionGrades) ? questionGrades : []).flatMap((grade) =>
    Array.isArray(grade?.pointReviews) ? grade.pointReviews : [],
  );
  const sortedGrades = (Array.isArray(questionGrades) ? [...questionGrades] : []).sort(
    (left, right) => {
      const leftRatio = Number(left.questionScore || 0) > 0 ? Number(left.earnedScore || 0) / Number(left.questionScore || 1) : 0;
      const rightRatio = Number(right.questionScore || 0) > 0 ? Number(right.earnedScore || 0) / Number(right.questionScore || 1) : 0;
      return rightRatio - leftRatio;
    },
  );
  const strongQuestions = uniqueTextItems(
    sortedGrades
      .filter((grade) => Number(grade.questionScore || 0) > 0 && Number(grade.earnedScore || 0) / Number(grade.questionScore || 1) >= 0.85)
      .map((grade) => `第${grade.questionNo}题`),
    2,
  );
  const weakQuestions = uniqueTextItems(
    [...sortedGrades]
      .reverse()
      .filter((grade) => Number(grade.questionScore || 0) > 0 && Number(grade.earnedScore || 0) / Number(grade.questionScore || 1) < 0.85)
      .map((grade) => `第${grade.questionNo}题`),
    2,
  );
  const hitLabels = collectPointFocuses(allPointReviews, (point) => Number(point.score || 0) > 0, 2);
  const missedLabels = collectPointFocuses(
    allPointReviews,
    (point) => Number(point.score || 0) < Math.max(0, Number(point.fullScore || 0)),
    2,
  );

  const lead = ratio >= 0.85
    ? tokens.overallPraiseLead
    : ratio >= 0.5
      ? tokens.overallMidLead
      : tokens.overallWeakLead;
  const strengths = hitLabels.length
    ? `像 ${hitLabels.join('、')} 这些内容，你整体处理得比较到位，说明相关知识已经掌握得较扎实。`
    : strongQuestions.length
      ? `${strongQuestions.join('、')} 完成度相对更高，说明你的主线意识和基础史实比较扎实。`
      : '已经能看出你在部分题目上有不错的基础。';
  const weaknesses = missedLabels.length
    ? `接下来优先补上 ${missedLabels.join('、')} 这几类内容，提分会更直接。`
    : weakQuestions.length
      ? `接下来要重点补一补 ${weakQuestions.join('、')}，把容易漏掉的角度和细节答完整。`
    : '整体上没有明显短板，继续保持答题稳定度就好。';
  const advice = `${tokens.advicePrefix}回到失分点，把答案按要点重新整理一遍，再做一次针对性复盘。`;
  const encouragement = ratio >= 0.85 ? tokens.encourageHigh : ratio >= 0.5 ? tokens.encourageMid : tokens.encourageLow;

  return applyCustomStylePrefix(`${lead}${strengths}${weaknesses}${advice}${encouragement}`, customRolePrompt, ratio);
}

function buildSectionComment({ section, points, sectionComments, questionType, rolePreset, customRolePrompt, score, fullScore }) {
  const modelComment = resolveSectionComment({ section, sectionComments });
  if (modelComment && !isGenericSectionComment({ comment: modelComment, sectionLabel: section.label })) {
    const actionableComment = ensureActionableComment({
      comment: modelComment,
      points,
      questionType,
      rolePreset,
      customRolePrompt,
      sectionLabel: section.label,
      sectionScore: score,
      sectionFullScore: fullScore,
    });
    if (actionableComment) {
      return actionableComment;
    }
  }

  return buildGeneratedSectionComment({
    sectionLabel: section.label,
    points,
    questionType,
    rolePreset,
    customRolePrompt,
  });
}

function buildSectionReviews({ pointReviews, sectionComments, questionType, question, rolePreset, customRolePrompt, sectionContext }) {
  const grouped = new Map();
  const normalizedSectionComments = normalizeSectionComments(sectionComments);
  const ordinarySections = questionType === 'essay'
    ? []
    : (sectionContext || buildOrdinarySectionContext({ question, answer: '' })).resolvedSections;

  ordinarySections.forEach((section) => {
    grouped.set(section.key, {
      key: section.key,
      label: section.label,
      order: Number(section.order || 0),
      fullScore: Math.max(0, Number(section.fullScore || 0)),
      points: [],
    });
  });

  (Array.isArray(pointReviews) ? pointReviews : []).forEach((point) => {
    if (!grouped.has(point.sectionKey)) {
      grouped.set(point.sectionKey, {
        key: point.sectionKey,
        label: point.sectionLabel,
        order: Number(point.sectionOrder || 0),
        fullScore: 0,
        points: [],
      });
    }
    grouped.get(point.sectionKey).points.push(point);
  });

  return Array.from(grouped.values())
    .map((section) => {
      const points = section.points.slice().sort((left, right) => Number(left.pointOrder || 0) - Number(right.pointOrder || 0));
      const score = points.reduce((sum, point) => sum + Number(point.score || 0), 0);
      const rawPointFullScore = points.reduce((sum, point) => sum + Math.max(0, Number(point.fullScore || 0)), 0);
      const fullScore = Number(section.fullScore || 0) > 0 ? Number(section.fullScore || 0) : rawPointFullScore;
      return {
        key: section.key,
        label: section.label,
        order: section.order,
        score,
        fullScore,
        comment: buildSectionComment({
          section,
          points,
          sectionComments: normalizedSectionComments,
          questionType,
          rolePreset,
          customRolePrompt,
          score,
          fullScore,
        }),
        pointKeys: points.map((point) => point.key),
        matchedExcerpts: uniqueTextItems(points.flatMap((point) => point.matchedExcerpts || []), 12),
      };
    })
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
}

function chooseShortestRange(left, right) {
  const leftLength = left.end - left.start;
  const rightLength = right.end - right.start;
  if (leftLength !== rightLength) return leftLength - rightLength;
  if (left.start !== right.start) return left.start - right.start;
  return Number(left.candidateOrder || 0) - Number(right.candidateOrder || 0);
}

function mergeIntervals(ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return [];

  const sorted = ranges
    .map((item) => ({
      start: Number(item.start || 0),
      end: Number(item.end || 0),
    }))
    .filter((item) => item.end > item.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const merged = [];
  sorted.forEach((current) => {
    const previous = merged[merged.length - 1];
    if (!previous || current.start > previous.end) {
      merged.push({ ...current });
      return;
    }
    previous.end = Math.max(previous.end, current.end);
  });

  return merged;
}

function subtractIntervals(base, blockers) {
  if (!base || base.end <= base.start) return [];
  if (!Array.isArray(blockers) || !blockers.length) return [base];

  const sortedBlockers = blockers
    .map((item) => ({
      start: Math.max(base.start, Number(item.start || 0)),
      end: Math.min(base.end, Number(item.end || 0)),
    }))
    .filter((item) => item.end > item.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  if (!sortedBlockers.length) return [base];

  const segments = [];
  let cursor = base.start;

  sortedBlockers.forEach((blocker) => {
    if (blocker.end <= cursor) return;
    if (blocker.start > cursor) {
      segments.push({ start: cursor, end: blocker.start });
    }
    cursor = Math.max(cursor, blocker.end);
  });

  if (cursor < base.end) {
    segments.push({ start: cursor, end: base.end });
  }

  return segments;
}

function buildAnnotationRanges({ answer, questionType, question, pointReviews, annotationErrors, sectionContext }) {
  const source = normalizeText(answer);
  if (!source) return [];

  const ordinaryCatalog = questionType === 'essay'
    ? []
    : (sectionContext || buildOrdinarySectionContext({ question, answer: source })).resolvedSections;
  const sectionRangeByKey = new Map(ordinaryCatalog.map((section) => [section.key, section]));

  const matchCandidates = [];
  (Array.isArray(pointReviews) ? pointReviews : []).forEach((point, pointIndex) => {
    (point.matchedExcerpts || []).forEach((excerpt, excerptIndex) => {
      const needle = normalizeText(excerpt);
      if (!needle) return;

      const section = sectionRangeByKey.get(point.sectionKey);
      const range = section
        ? findRangeInWindow(source, needle, section.start, section.end) || findRangeInWindow(source, needle)
        : findRangeInWindow(source, needle);

      if (!range) return;

      matchCandidates.push({
        ...range,
        tone: 'match',
        pointKey: point.key,
        sectionKey: point.sectionKey,
        pointOrder: Number(point.pointOrder || pointIndex + 1),
        pointScore: Number(point.score || 0),
        candidateOrder: pointIndex * 100 + excerptIndex,
      });
    });
  });

  const errorCandidates = (Array.isArray(annotationErrors) ? annotationErrors : [])
    .map((item, index) => {
      const needle = normalizeText(item?.excerpt);
      if (!needle) return null;
      const range = findRangeInWindow(source, needle);
      if (!range) return null;
      return {
        ...range,
        tone: 'error',
        reason: normalizeText(item?.reason) || '表达存在问题',
        candidateOrder: index,
      };
    })
    .filter(Boolean);

  // Protect positive-score match snippets so an over-wide error excerpt
  // does not swallow nearby correct scoring highlights.
  const protectedMatchIntervals = mergeIntervals(
    matchCandidates
      .filter((item) => Number(item.pointScore || 0) > 0)
      .map((item) => ({ start: item.start, end: item.end })),
  );
  const trimmedErrorCandidates = errorCandidates.flatMap((item) =>
    subtractIntervals({ start: item.start, end: item.end }, protectedMatchIntervals).map((segment, segmentIndex) => ({
      ...item,
      start: segment.start,
      end: segment.end,
      candidateOrder: Number(item.candidateOrder || 0) * 100 + segmentIndex,
    })),
  );

  const candidates = [...matchCandidates, ...trimmedErrorCandidates];
  if (!candidates.length) return [];

  const boundaries = Array.from(new Set([0, source.length, ...candidates.flatMap((item) => [item.start, item.end])])).sort((a, b) => a - b);
  const anchoredPoints = new Set();
  const ranges = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (start >= end) continue;

    const coveringErrors = trimmedErrorCandidates
      .filter((item) => item.start <= start && item.end >= end)
      .sort(chooseShortestRange);

    if (coveringErrors.length) {
      const chosen = coveringErrors[0];
      ranges.push({
        key: `error-${ranges.length + 1}-${start}-${end}`,
        start,
        end,
        tone: 'error',
        reason: chosen.reason,
      });
      continue;
    }

    const coveringMatches = matchCandidates
      .filter((item) => item.start <= start && item.end >= end)
      .sort((left, right) => {
        const lengthOrder = chooseShortestRange(left, right);
        if (lengthOrder !== 0) return lengthOrder;
        return Number(left.pointOrder || 0) - Number(right.pointOrder || 0);
      });

    if (!coveringMatches.length) {
      continue;
    }

    const chosen = coveringMatches[0];
    const sameAnchorMatches = coveringMatches.filter((item) => item.start === chosen.start && item.end === chosen.end);
    const newlyAnchoredMatches = sameAnchorMatches.filter(
      (item) => item.pointKey && !anchoredPoints.has(item.pointKey) && Number(item.pointScore || 0) > 0,
    );
    const range = {
      key: `match-${ranges.length + 1}-${start}-${end}`,
      start,
      end,
      tone: 'match',
      sectionKey: chosen.sectionKey,
      pointKey: chosen.pointKey,
      pointKeys: uniqueTextItems(sameAnchorMatches.map((item) => item.pointKey).filter(Boolean), 24),
    };

    if (newlyAnchoredMatches.length) {
      range.score = newlyAnchoredMatches.reduce((sum, item) => sum + Number(item.pointScore || 0), 0);
      newlyAnchoredMatches.forEach((item) => anchoredPoints.add(item.pointKey));
    }

    ranges.push(range);
  }

  return ranges;
}

function buildSubjectiveConsistencyWarnings({
  questionType,
  pointReviews,
  sectionReviews,
  annotationRanges,
  earnedScoreRaw,
  sectionContext,
  essayReview,
}) {
  const warnings = [];
  const pointScoreSum = (Array.isArray(pointReviews) ? pointReviews : []).reduce((sum, item) => sum + Number(item.score || 0), 0);
  const pointFullScoreSum = (Array.isArray(pointReviews) ? pointReviews : []).reduce(
    (sum, item) => sum + Math.max(0, Number(item.fullScore || 0)),
    0,
  );
  const annotationScoreSum = (Array.isArray(annotationRanges) ? annotationRanges : []).reduce(
    (sum, item) => sum + Math.max(0, Number(item.score || 0)),
    0,
  );
  const hasPointReviews = Array.isArray(pointReviews) && pointReviews.length > 0;
  const hasEssayReview =
    questionType === 'essay'
    && essayReview
    && (
      normalizeText(essayReview?.thesis?.excerpt)
      || normalizeText(essayReview?.conclusion?.excerpt)
      || (Array.isArray(essayReview?.bodySections) && essayReview.bodySections.some((section) => normalizeText(section?.excerpt)))
    );

  if (hasPointReviews && Math.abs(pointScoreSum - Number(earnedScoreRaw || 0)) > 0.01) {
    warnings.push('采分点得分与题目总分不一致');
  }
  if (!hasPointReviews && !hasEssayReview && Number(earnedScoreRaw || 0) > 0) {
    warnings.push('未返回可用的采分点明细');
  }
  if (hasPointReviews && pointFullScoreSum > 0 && pointFullScoreSum < pointScoreSum) {
    warnings.push('采分点分值配置异常');
  }

  if (questionType !== 'essay') {
    (Array.isArray(sectionReviews) ? sectionReviews : []).forEach((section) => {
      if (Number(section.fullScore || 0) > 0 && Number(section.score || 0) > Number(section.fullScore || 0) + 0.01) {
        warnings.push(`${normalizeText(section.label) || '小题'}得分超过该小题满分`);
      }
    });
  }

  const positiveMissingExcerpt = (Array.isArray(pointReviews) ? pointReviews : []).filter(
    (point) => Number(point.score || 0) > 0 && !(point.matchedExcerpts || []).length,
  );
  if (positiveMissingExcerpt.length) {
    warnings.push('存在已得分但未定位到学生原文的采分点');
  }

  if (questionType !== 'essay' && hasPointReviews && Math.abs(annotationScoreSum - pointScoreSum) > 0.01) {
    warnings.push('原文挂分与采分点得分不完全一致');
  }

  const unresolvedSectionConflict = (Array.isArray(pointReviews) ? pointReviews : []).some(
    (point) =>
      point.sectionConflict
      && point.explicitSubquestionIndex != null
      && point.excerptSubquestionIndex == null,
  );
  if (unresolvedSectionConflict) {
    warnings.push('存在小题归属冲突且无法通过原文片段确认');
  }

  if (questionType !== 'essay' && sectionContext?.resolvedSections?.length) {
    const missingSections = sectionContext.resolvedSections.filter(
      (section) => !(Array.isArray(sectionReviews) ? sectionReviews : []).some((review) => review.key === section.key),
    );
    if (missingSections.length) {
      warnings.push('小题结构不完整，需人工复核');
    }
  }

  return uniqueTextItems(warnings, 12);
}

function toLegacySubReview(review) {
  return {
    label: normalizeText(review?.label || review?.pointLabel) || '评分点',
    score: Number(review?.score || 0),
    fullScore: Math.max(0, Number(review?.fullScore || 0)),
    comment: normalizeText(review?.comment),
    matchedExcerpts: uniqueTextItems(review?.matchedExcerpts, 12),
  };
}

module.exports = {
  buildOverallComment,
  buildQuestionComment,
  buildOrdinarySectionContext,
  buildSubjectiveConsistencyWarnings,
  extractSubquestionIndex,
  normalizePointReviews,
  buildSectionReviews,
  buildAnnotationRanges,
  toLegacySubReview,
};



