const {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
} = require('docx');

const PAGE_WIDTH = 10480;
const LEFT_COLUMN_WIDTH = 1450;
const RIGHT_COLUMN_WIDTH = PAGE_WIDTH - LEFT_COLUMN_WIDTH;
const MAIN_FONT = '宋体';
const KAITI_FONT = '楷体';
const SIZE_TITLE = 22;
const SIZE_BODY = 18;
const SIZE_META = 16;
const COLOR_TEXT = '3D312B';
const COLOR_MUTED = '7A6558';
const COLOR_LINE = 'D9C7B7';
const COLOR_GREEN = '2F855A';
const COLOR_RED = 'C53030';
const COLOR_BLUE = '355C7D';

function compareQuestionNo(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function normalizeText(value) {
  return String(value || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeInlineText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function formatScore(value) {
  const numeric = Number(value || 0);
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(1).replace(/\.0$/, '');
}

function formatDateTime(value) {
  const date = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function sanitizeFileNamePart(value, fallback) {
  const text = String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ');
  return text || fallback;
}

function getExportFileName(task) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const taskName = sanitizeFileNamePart(task?.name, '主观题批改');
  const className = sanitizeFileNamePart(task?.className, '未分班级');
  return `${taskName}-${className}-已批改学生-${stamp}.docx`;
}

function findAnnotationRanges(answer, excerpt, tone, reason, reviewIndex) {
  const source = String(answer || '');
  const needle = normalizeText(excerpt);
  if (!source || !needle) return [];

  const ranges = [];
  let cursor = 0;
  while (cursor < source.length) {
    const index = source.indexOf(needle, cursor);
    if (index === -1) break;
    ranges.push({
      start: index,
      end: index + needle.length,
      tone,
      reason,
      reviewIndex,
    });
    cursor = index + needle.length;
  }
  return ranges;
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

  const overlapBlockers = blockers
    .map((item) => ({
      start: Math.max(base.start, Number(item.start || 0)),
      end: Math.min(base.end, Number(item.end || 0)),
    }))
    .filter((item) => item.end > item.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  if (!overlapBlockers.length) return [base];

  const segments = [];
  let cursor = base.start;
  overlapBlockers.forEach((blocker) => {
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

function buildAnnotatedAnswer(answer, grade) {
  const source = normalizeText(answer);
  if (!source) {
    return {
      source: '',
      segments: [{ text: '（未识别到学生原答）', tone: 'plain', start: 0, end: 10 }],
      errorNotes: [],
      unanchoredPoints: [],
    };
  }

  const pointSource = Array.isArray(grade?.pointReviews) && grade.pointReviews.length
    ? grade.pointReviews
    : (Array.isArray(grade?.subReviews) ? grade.subReviews.map((review, index) => ({
        key: `legacy-point-${index + 1}`,
        pointLabel: review?.label,
        score: Number(review?.score || 0),
        matchedExcerpts: Array.isArray(review?.matchedExcerpts) ? review.matchedExcerpts : [],
      })) : []);
  const savedRanges = (Array.isArray(grade?.annotationRanges) ? grade.annotationRanges : [])
    .map((item) => ({
      ...item,
      start: Number(item?.start ?? 0),
      end: Number(item?.end ?? 0),
      tone: item?.tone === 'error' ? 'error' : 'match',
      score: Number.isFinite(Number(item?.score)) ? Number(item.score) : undefined,
      pointKeys: Array.isArray(item?.pointKeys)
        ? item.pointKeys.map((key) => normalizeText(key)).filter(Boolean)
        : (normalizeText(item?.pointKey) ? [normalizeText(item.pointKey)] : []),
      reason: normalizeText(item?.reason),
    }))
    .filter((item) => item.end > item.start && item.start >= 0 && item.end <= source.length)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  if (savedRanges.length) {
    const anchoredPointKeys = new Set();
    const errorNotes = [];
    const segments = [];
    let cursor = 0;
    let errorIndex = 1;

    savedRanges.forEach((item) => {
      if (cursor < item.start) {
        segments.push({
          text: source.slice(cursor, item.start),
          tone: 'plain',
          start: cursor,
          end: item.start,
        });
      }

      const currentSegment = {
        text: source.slice(item.start, item.end),
        tone: item.tone,
        reason: item.reason,
        awardedScore: item.tone === 'match' && typeof item.score === 'number' ? item.score : undefined,
        start: item.start,
        end: item.end,
      };

      if (item.tone === 'error') {
        currentSegment.errorIndex = errorIndex;
        errorNotes.push({
          index: errorIndex,
          reason: item.reason || '表述存在问题',
        });
        errorIndex += 1;
      }

      if (item.tone === 'match') {
        item.pointKeys.forEach((key) => anchoredPointKeys.add(key));
      }

      segments.push(currentSegment);
      cursor = item.end;
    });

    if (cursor < source.length) {
      segments.push({
        text: source.slice(cursor),
        tone: 'plain',
        start: cursor,
        end: source.length,
      });
    }

    return {
      source,
      segments: segments.length ? segments : [{ text: source, tone: 'plain', start: 0, end: source.length }],
      errorNotes,
      unanchoredPoints: pointSource.filter(
        (point) => Number(point?.score || 0) > 0 && normalizeText(point?.key) && !anchoredPointKeys.has(normalizeText(point.key)),
      ),
    };
  }

  const matchCandidates = [];
  (grade?.subReviews || []).forEach((review, reviewIndex) => {
    (review.matchedExcerpts || []).forEach((excerpt) => {
      matchCandidates.push(...findAnnotationRanges(source, excerpt, 'match', undefined, reviewIndex));
    });
  });

  const errorCandidates = [];
  (grade?.annotations?.errors || []).forEach((item) => {
    errorCandidates.push(...findAnnotationRanges(source, item.excerpt, 'error', item.reason || '表述存在问题'));
  });

  const reviewMatchSet = new Set(
    (grade?.subReviews || [])
      .flatMap((review) => (review.matchedExcerpts || []).map((excerpt) => normalizeText(excerpt)))
      .filter(Boolean),
  );

  (grade?.annotations?.matches || []).forEach((excerpt) => {
    const normalized = normalizeText(excerpt);
    if (normalized && !reviewMatchSet.has(normalized)) {
      matchCandidates.push(...findAnnotationRanges(source, excerpt, 'match'));
    }
  });

  const protectedMatchIntervals = mergeIntervals(
    matchCandidates
      .filter((item) => typeof item.reviewIndex === 'number' && (grade?.subReviews?.[item.reviewIndex]?.score ?? 0) > 0)
      .map((item) => ({ start: item.start, end: item.end })),
  );
  const trimmedErrorCandidates = errorCandidates.flatMap((item, index) =>
    subtractIntervals({ start: item.start, end: item.end }, protectedMatchIntervals).map((segment, segmentIndex) => ({
      ...item,
      start: segment.start,
      end: segment.end,
      candidateOrder: index * 100 + segmentIndex,
    })),
  );

  const candidates = [...trimmedErrorCandidates, ...matchCandidates];

  const accepted = candidates
    .sort((left, right) => {
      if (left.start !== right.start) return left.start - right.start;
      if (left.tone !== right.tone) return left.tone === 'error' ? -1 : 1;
      return right.end - right.start - (left.end - left.start);
    })
    .reduce((result, current) => {
      const previous = result[result.length - 1];
      if (previous && current.start < previous.end) {
        return result;
      }
      result.push(current);
      return result;
    }, []);

  const reviewAnchored = new Set();
  const errorNotes = [];
  const segments = [];
  let cursor = 0;
  let errorIndex = 1;

  accepted.forEach((item) => {
    if (cursor < item.start) {
      segments.push({
        text: source.slice(cursor, item.start),
        tone: 'plain',
        start: cursor,
        end: item.start,
      });
    }

    const currentSegment = {
      text: source.slice(item.start, item.end),
      tone: item.tone,
      reason: item.reason,
      awardedScore:
        item.tone === 'match' &&
        typeof item.reviewIndex === 'number' &&
        !reviewAnchored.has(item.reviewIndex) &&
        (grade?.subReviews?.[item.reviewIndex]?.score ?? 0) > 0
          ? grade.subReviews[item.reviewIndex].score
          : undefined,
      start: item.start,
      end: item.end,
    };

    if (item.tone === 'error') {
      currentSegment.errorIndex = errorIndex;
      errorNotes.push({
        index: errorIndex,
        reason: item.reason || '表述存在问题',
      });
      errorIndex += 1;
    }

    if (item.tone === 'match' && typeof item.reviewIndex === 'number') {
      reviewAnchored.add(item.reviewIndex);
    }

    segments.push(currentSegment);
    cursor = item.end;
  });

  if (cursor < source.length) {
    segments.push({
      text: source.slice(cursor),
      tone: 'plain',
      start: cursor,
      end: source.length,
    });
  }

  return {
    source,
    segments: segments.length ? segments : [{ text: source, tone: 'plain', start: 0, end: source.length }],
    errorNotes,
    unanchoredPoints: (grade?.subReviews || [])
      .map((review, index) => ({
        key: `legacy-point-${index + 1}`,
        pointLabel: review?.label,
        score: Number(review?.score || 0),
      }))
      .filter((point, index) => Number(point.score || 0) > 0 && !reviewAnchored.has(index)),
  };
}

function pushSegmentTextRuns(runs, text, runOptions) {
  const parts = String(text || '').split('\n');
  parts.forEach((part, index) => {
    if (index > 0) {
      runs.push(new TextRun({ break: 1 }));
    }
    if (part) {
      runs.push(new TextRun({ ...runOptions, text: part }));
    }
  });
}

function createBlankAnswerRun() {
  return new TextRun({
    text: '（空白）',
    font: MAIN_FONT,
    size: SIZE_BODY,
    color: COLOR_MUTED,
    italics: true,
  });
}

function createAwardRun(score) {
  const passLabel = typeof score === 'number' ? `√+${formatScore(score)}` : '√';
  return new TextRun({
    text: passLabel,
    font: MAIN_FONT,
    size: SIZE_BODY,
    color: COLOR_GREEN,
    bold: true,
  });
}

function createErrorIndexRun(index) {
  return new TextRun({
    text: `误${index}`,
    font: KAITI_FONT,
    size: SIZE_BODY,
    color: COLOR_RED,
    bold: true,
  });
}

function createAnswerParagraph(runs) {
  return new Paragraph({
    spacing: { before: 0, after: 40, line: 220 },
    alignment: AlignmentType.LEFT,
    children: runs.length ? runs : [createBlankAnswerRun()],
  });
}

function normalizeEssaySuggestionText(value) {
  return normalizeInlineText(
    String(value || '')
      .replace(/\r/g, '')
      .replace(/^\s{0,3}#{1,6}\s*/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      .replace(/`([^`]+)`/g, '$1'),
  );
}

function getEssaySections(questionGrade) {
  const essayReview = questionGrade?.essayReview || {};
  const sections = [];
  const bodySections = Array.isArray(essayReview?.bodySections) ? essayReview.bodySections : [];

  if (essayReview?.thesis) {
    sections.push({
      key: essayReview.thesis.key || 'essay-thesis',
      label: normalizeInlineText(essayReview.thesis.label) || '论题',
      order: Number(essayReview.thesis.order || 1),
      excerpt: normalizeText(essayReview.thesis.excerpt),
      suggestedText: normalizeEssaySuggestionText(essayReview.thesis.suggestedText),
      score: Number(essayReview.thesis.score || 0),
    });
  }

  bodySections.forEach((section, index) => {
    sections.push({
      key: section?.key || `essay-body-${index + 1}`,
      label: normalizeInlineText(section?.label) || `第${index + 1}段`,
      order: Number(section?.order || index + 2),
      excerpt: normalizeText(section?.excerpt),
      suggestedText: normalizeEssaySuggestionText(section?.suggestedText),
      score: Number(section?.score || 0),
    });
  });

  if (essayReview?.conclusion) {
    sections.push({
      key: essayReview.conclusion.key || 'essay-conclusion',
      label: normalizeInlineText(essayReview.conclusion.label) || '结论',
      order: Number(essayReview.conclusion.order || bodySections.length + 2),
      excerpt: normalizeText(essayReview.conclusion.excerpt),
      suggestedText: normalizeEssaySuggestionText(essayReview.conclusion.suggestedText),
      score: Number(essayReview.conclusion.score || 0),
    });
  }

  return sections
    .filter((section) => section.excerpt)
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
}

function buildEssaySectionAnchors(answer, questionGrade) {
  const source = normalizeText(answer);
  if (!source) return [];

  const anchors = [];
  let cursor = 0;

  getEssaySections(questionGrade).forEach((section) => {
    const excerpt = normalizeText(section.excerpt);
    if (!excerpt) return;

    let start = source.indexOf(excerpt, cursor);
    if (start === -1) {
      start = source.indexOf(excerpt);
    }
    if (start === -1 || start < cursor) return;

    anchors.push({
      ...section,
      start,
      end: start + excerpt.length,
    });
    cursor = start + excerpt.length;
  });

  return anchors;
}

function buildOrdinaryAnswerContent(grade) {
  const annotated = buildAnnotatedAnswer(grade?.studentAnswer || '', grade);
  const runs = [];

  annotated.segments.forEach((segment) => {
    if (segment.tone === 'match') {
      pushSegmentTextRuns(runs, segment.text, {
        font: MAIN_FONT,
        size: SIZE_BODY,
        color: COLOR_GREEN,
        underline: { type: UnderlineType.SINGLE, color: COLOR_GREEN },
      });
      runs.push(createAwardRun(segment.awardedScore));
      return;
    }

    if (segment.tone === 'error') {
      pushSegmentTextRuns(runs, segment.text, {
        font: KAITI_FONT,
        size: SIZE_BODY,
        color: COLOR_RED,
        border: { style: BorderStyle.SINGLE, color: COLOR_RED, size: 6, space: 1 },
      });
      if (segment.errorIndex) {
        runs.push(createErrorIndexRun(segment.errorIndex));
      }
      return;
    }

    pushSegmentTextRuns(runs, segment.text, {
      font: MAIN_FONT,
      size: SIZE_BODY,
      color: COLOR_TEXT,
    });
  });

  return {
    paragraphs: [createAnswerParagraph(runs)],
    errorNotes: annotated.errorNotes,
    unanchoredPoints: annotated.unanchoredPoints,
  };
}

function buildEssayAnswerContent(questionGrade) {
  const source = normalizeText(questionGrade?.studentAnswer || '');
  const annotated = buildAnnotatedAnswer(source, questionGrade);
  const anchors = buildEssaySectionAnchors(source, questionGrade);

  if (!source) {
    return {
      paragraphs: [createAnswerParagraph([])],
      errorNotes: [],
      unanchoredPoints: annotated.unanchoredPoints,
    };
  }

  if (!anchors.length) {
    const runs = [];
    pushSegmentTextRuns(runs, source, {
      font: MAIN_FONT,
      size: SIZE_BODY,
      color: COLOR_TEXT,
    });
    return {
      paragraphs: [createAnswerParagraph(runs)],
      errorNotes: [],
      unanchoredPoints: annotated.unanchoredPoints,
    };
  }

  const runs = [];
  let cursor = 0;

  anchors.forEach((anchor) => {
    if (cursor < anchor.start) {
      pushSegmentTextRuns(runs, source.slice(cursor, anchor.start), {
        font: MAIN_FONT,
        size: SIZE_BODY,
        color: COLOR_TEXT,
      });
    }

    pushSegmentTextRuns(runs, source.slice(anchor.start, anchor.end), {
      font: MAIN_FONT,
      size: SIZE_BODY,
      color: COLOR_TEXT,
    });

    if (Number(anchor.score || 0) > 0) {
      runs.push(createAwardRun(anchor.score));
    }

    if (anchor.suggestedText) {
      runs.push(
        new TextRun({
          text: `（${anchor.suggestedText}）`,
          font: KAITI_FONT,
          size: SIZE_BODY,
          color: COLOR_RED,
        }),
      );
    }

    cursor = anchor.end;
  });

  if (cursor < source.length) {
    pushSegmentTextRuns(runs, source.slice(cursor), {
      font: MAIN_FONT,
      size: SIZE_BODY,
      color: COLOR_TEXT,
    });
  }

  return {
    paragraphs: [createAnswerParagraph(runs)],
    errorNotes: [],
    unanchoredPoints: annotated.unanchoredPoints,
  };
}

function buildAnswerContent(questionGrade) {
  if (isEssayQuestionGrade(questionGrade)) {
    return buildEssayAnswerContent(questionGrade);
  }
  return buildOrdinaryAnswerContent(questionGrade);
}

function getCompactSubReviews(questionGrade) {
  return (questionGrade?.displaySubReviews?.length ? questionGrade.displaySubReviews : questionGrade?.subReviews || []).filter(Boolean);
}

function isEssayQuestionGrade(questionGrade) {
  return String(questionGrade?.questionType || '').trim() === 'essay';
}

function buildReviewLine(questionGrade) {
  if (!isEssayQuestionGrade(questionGrade)) {
    return '';
  }
  const reviews = getCompactSubReviews(questionGrade);
  if (!reviews.length) {
    return '小评：暂无分点评语。';
  }

  const content = reviews
    .map((review, index) => {
      const label = normalizeInlineText(review.label) || `小题${index + 1}`;
      const score = Number(review.fullScore || 0) > 0 ? `${formatScore(review.score)}/${formatScore(review.fullScore)}` : formatScore(review.score);
      const comment = normalizeInlineText(review.comment) || '已批改。';
      return `${label} ${score}：${comment}`;
    })
    .join('；');

  return `小评：${content}`;
}

function buildErrorLine(errorNotes) {
  if (!errorNotes.length) return '';
  return errorNotes.map((item) => `误${item.index}：${normalizeInlineText(item.reason) || '表述存在问题'}`).join('；');
}

function buildUnanchoredLine(points) {
  const normalizedPoints = (Array.isArray(points) ? points : [])
    .filter((point) => Number(point?.score || 0) > 0)
    .map((point) => ({
      label: normalizeInlineText(point?.pointLabel || point?.label) || '未定位采分点',
      score: Number(point?.score || 0),
    }));

  if (!normalizedPoints.length) return '';

  const totalScore = normalizedPoints.reduce((sum, point) => sum + Number(point.score || 0), 0);
  const detail = normalizedPoints
    .slice(0, 4)
    .map((point) => `${point.label} +${formatScore(point.score)}`)
    .join('；');
  const suffix = normalizedPoints.length > 4 ? '；其余请结合小评复核' : '';
  return `补注：另有 ${formatScore(totalScore)} 分未能精确挂到原文：${detail}${suffix}`;
}

function createTextParagraph(text, runOptions = {}, paragraphOptions = {}) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: 220 },
    ...paragraphOptions,
    children: [
      new TextRun({
        text,
        font: MAIN_FONT,
        ...runOptions,
      }),
    ],
  });
}

function buildQuestionRow(questionGrade) {
  const { paragraphs, errorNotes, unanchoredPoints } = buildAnswerContent(questionGrade);
  const reviewLine = buildReviewLine(questionGrade);
  const errorLine = buildErrorLine(errorNotes);
  const unanchoredLine = buildUnanchoredLine(unanchoredPoints);
  const questionComment = isEssayQuestionGrade(questionGrade)
    ? (normalizeInlineText(questionGrade?.questionComment) || '暂无总评。')
    : '';
  const teacherReviewLine = questionGrade.reviewState === 'adjusted'
    ? `教师改分：AI 原得分 ${formatScore(questionGrade.originalEarnedScore ?? questionGrade.earnedScore)} 分，教师改为 ${formatScore(questionGrade.earnedScore)} 分。`
    : questionGrade.reviewState === 'confirmed'
      ? `教师复核：已确认 AI 得分 ${formatScore(questionGrade.earnedScore)} 分。`
      : '';
  const teacherReasonLine = questionGrade.reviewState === 'adjusted' && normalizeInlineText(questionGrade.reviewNote)
    ? `改分原因：${normalizeInlineText(questionGrade.reviewNote)}`
    : '';

  return new TableRow({
    children: [
      new TableCell({
        width: { size: LEFT_COLUMN_WIDTH, type: WidthType.DXA },
        verticalAlign: 'center',
        margins: { top: 70, bottom: 70, left: 80, right: 80 },
        borders: {
          top: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 4 },
          bottom: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 4 },
          left: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 4 },
          right: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 4 },
        },
        children: [
          createTextParagraph(`第${questionGrade.questionNo}题`, {
            size: SIZE_BODY,
            bold: true,
            color: COLOR_TEXT,
            font: MAIN_FONT,
          }),
          createTextParagraph(`得分 ${formatScore(questionGrade.earnedScore)} / ${formatScore(questionGrade.questionScore)}分`, {
            size: SIZE_META,
            color: COLOR_BLUE,
            bold: true,
            font: MAIN_FONT,
          }),
          createTextParagraph(
            questionGrade.requiresReview
              ? '待复核'
              : (questionGrade.reviewState === 'adjusted'
                ? '教师已改分'
                : questionGrade.reviewState === 'confirmed'
                  ? '教师已确认'
                  : '已批改'),
            {
            size: SIZE_META,
            color: questionGrade.requiresReview ? COLOR_RED : (questionGrade.reviewState ? COLOR_BLUE : COLOR_GREEN),
            bold: questionGrade.requiresReview || Boolean(questionGrade.reviewState),
            font: MAIN_FONT,
            },
          ),
        ],
      }),
      new TableCell({
        width: { size: RIGHT_COLUMN_WIDTH, type: WidthType.DXA },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        borders: {
          top: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 4 },
          bottom: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 4 },
          left: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 4 },
          right: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 4 },
        },
        children: [
          ...paragraphs,
          ...(reviewLine
            ? [
                createTextParagraph(reviewLine, {
                  size: SIZE_META,
                  color: COLOR_MUTED,
                  font: MAIN_FONT,
                }),
              ]
            : []),
          ...(errorLine
            ? [
                createTextParagraph(errorLine, {
                  size: SIZE_META,
                  color: COLOR_RED,
                  font: KAITI_FONT,
                }),
              ]
            : []),
          ...(unanchoredLine
            ? [
                createTextParagraph(unanchoredLine, {
                  size: SIZE_META,
                  color: COLOR_BLUE,
                  font: MAIN_FONT,
                }),
              ]
            : []),
          ...(teacherReviewLine
            ? [
                createTextParagraph(teacherReviewLine, {
                  size: SIZE_META,
                  color: COLOR_RED,
                  font: KAITI_FONT,
                }),
              ]
            : []),
          ...(teacherReasonLine
            ? [
                createTextParagraph(teacherReasonLine, {
                  size: SIZE_META,
                  color: COLOR_RED,
                  font: KAITI_FONT,
                }),
              ]
            : []),
          ...(questionComment
            ? [
                createTextParagraph(`总评：${questionComment.replace(/^总评[:：]\s*/, '')}`, {
                  size: SIZE_META,
                  color: COLOR_BLUE,
                  font: MAIN_FONT,
                }),
              ]
            : []),
        ],
      }),
    ],
  });
}

function buildStudentTable(studentSummary) {
  const questionGrades = (studentSummary?.questionGrades || []).slice().sort((left, right) => compareQuestionNo(left.questionNo, right.questionNo));
  const hasEssayQuestion = questionGrades.some((questionGrade) => isEssayQuestionGrade(questionGrade));
  const reviewLabel = studentSummary.reviewQuestionCount > 0 ? ` | 复核 ${studentSummary.reviewQuestionCount}` : '';
  const studentTitle = `${studentSummary.studentName}${studentSummary.isExtra ? '（附加）' : ''} | 总分 ${formatScore(studentSummary.earnedScore)}/${formatScore(studentSummary.totalScore)} | 已批 ${studentSummary.gradedQuestionCount}题${reviewLabel}`;
  const overallComment = normalizeInlineText(studentSummary.overallComment) || '暂无总评。';

  return new Table({
    width: { size: PAGE_WIDTH, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [LEFT_COLUMN_WIDTH, RIGHT_COLUMN_WIDTH],
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    borders: {
      top: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 6 },
      bottom: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 6 },
      left: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 6 },
      right: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 6 },
      insideHorizontal: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 4 },
      insideVertical: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 4 },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            columnSpan: 2,
            margins: { top: 90, bottom: 90, left: 120, right: 120 },
            shading: { fill: 'F8F3EF' },
            children: [
              createTextParagraph(studentTitle, {
                size: SIZE_BODY,
                bold: true,
                color: COLOR_TEXT,
                font: MAIN_FONT,
              }),
            ],
          }),
        ],
      }),
      ...questionGrades.map((questionGrade) => buildQuestionRow(questionGrade)),
      ...(hasEssayQuestion
        ? [
            new TableRow({
              children: [
                new TableCell({
                  columnSpan: 2,
                  margins: { top: 80, bottom: 80, left: 120, right: 120 },
                  shading: { fill: 'FCFAF8' },
                  children: [
                    createTextParagraph(`总评：${overallComment}`, {
                      size: SIZE_META,
                      color: COLOR_TEXT,
                      font: MAIN_FONT,
                    }),
                  ],
                }),
              ],
            }),
          ]
        : []),
    ],
  });
}
function sortStudentSummaries(task, studentSummaries) {
  const orderMap = new Map((task?.studentRecords || []).map((student, index) => [student.id, index]));
  return studentSummaries
    .slice()
    .sort((left, right) => {
      const leftIndex = orderMap.get(left.studentId);
      const rightIndex = orderMap.get(right.studentId);
      if (leftIndex != null && rightIndex != null && leftIndex !== rightIndex) return leftIndex - rightIndex;
      if (leftIndex != null && rightIndex == null) return -1;
      if (leftIndex == null && rightIndex != null) return 1;
      return String(left.studentName || '').localeCompare(String(right.studentName || ''), 'zh-CN');
    });
}

async function buildSubjectiveGradingDocx(task) {
  const studentSummaries = sortStudentSummaries(
    task,
    (task?.subjectiveGrading?.studentSummaries || []).filter(
      (student) => Number(student.gradedQuestionCount || 0) > 0 && Array.isArray(student.questionGrades) && student.questionGrades.length > 0,
    ),
  );

  if (!studentSummaries.length) {
    throw new Error('当前任务还没有可导出的已批改学生。');
  }

  const metaParts = [
    `班级：${task?.className || '未设置'}`,
    `作业：${task?.name || '主观题批改导出'}`,
    `导出学生：${studentSummaries.length}人`,
    `导出时间：${formatDateTime(new Date())}`,
  ];

  if (task?.homeworkDate) {
    metaParts.splice(2, 0, `作业日期：${task.homeworkDate}`);
  }

  const children = [
    createTextParagraph(task?.name || '主观题批改导出', {
      size: SIZE_TITLE,
      bold: true,
      color: COLOR_TEXT,
      font: MAIN_FONT,
    }),
    createTextParagraph(metaParts.join('  |  '), {
      size: SIZE_META,
      color: COLOR_MUTED,
      font: MAIN_FONT,
    }),
    createTextParagraph('仅导出已批改学生；保留学生原答、勾画批注、小评与总评，并压缩为紧凑打印版。', {
      size: SIZE_META,
      color: COLOR_MUTED,
      font: MAIN_FONT,
    }),
  ];

  studentSummaries.forEach((studentSummary, index) => {
    children.push(
      buildStudentTable(studentSummary),
      new Paragraph({
        spacing: { before: 0, after: index === studentSummaries.length - 1 ? 0 : 80, line: 60 },
      }),
    );
  });

  const document = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 700,
              right: 680,
              bottom: 700,
              left: 680,
              header: 360,
              footer: 360,
              gutter: 0,
            },
          },
        },
        children,
      },
    ],
  });

  return {
    buffer: await Packer.toBuffer(document),
    fileName: getExportFileName(task),
    exportedStudentCount: studentSummaries.length,
  };
}

module.exports = {
  buildSubjectiveGradingDocx,
};
