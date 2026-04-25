import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  FileText,
  Highlighter,
  LoaderCircle,
  PauseCircle,
  PlayCircle,
  Sparkles,
  Trash2,
  UserRound,
  Users,
  WandSparkles,
} from 'lucide-react';
import { clearSubjectiveGrading, exportSubjectiveGradingDocx, reviewSubjectiveQuestion, runSubjectiveGrading } from '../api';
import type {
  AggregatedSubjectiveAnswer,
  SubjectiveEssayKeywordGroupMatch,
  SubjectiveEssayCriterionResult,
  QuestionDraft,
  SubjectiveEssayReview,
  SubjectiveEssayReviewChecks,
  SubjectiveGradingProfile,
  SubjectivePointReview,
  SubjectiveQuestionGradeRecord,
  SubjectiveSectionReview,
  SubjectiveStudentGradingRecord,
  TaskDetail,
} from '../types';

interface SubjectiveGradingStageProps {
  task: TaskDetail | null;
  onTaskUpdated: (task: TaskDetail) => void;
}

type StudentRecord = TaskDetail['studentRecords'][number];
type SubjectiveQuestion = QuestionDraft & { type: 'subjective' | 'essay' };
type SubjectiveStudentSummary = SubjectiveStudentGradingRecord;
type RunScope = 'group' | 'class';

type StudentGroup = {
  id: string;
  label: string;
  students: StudentRecord[];
};

type AnswerAnnotationRange = {
  key: string;
  start: number;
  end: number;
  tone: 'match' | 'error';
  score?: number;
  reason?: string;
  pointKey?: string;
  sectionKey?: string;
};

type AnswerSegment = {
  text: string;
  tone: 'plain' | 'match' | 'error';
  reason?: string;
  awardedScore?: number;
  pointKey?: string;
  sectionKey?: string;
  start: number;
  end: number;
};

type AnnotatedAnswer = {
  source: string;
  segments: AnswerSegment[];
  scoredRangeCount: number;
  awardedScoreTotal: number;
  errorRangeCount: number;
};

type ReviewPoint = {
  key: string;
  label: string;
  score: number;
  fullScore: number;
  comment: string;
};

type SubquestionSection = {
  key: string;
  title: string;
  score: number;
  fullScore: number;
  comment: string;
  points: ReviewPoint[];
};

type EssayCriterionTone = 'good' | 'bad' | 'neutral';

type EssayCriterionDisplay = {
  code: string;
  label: string;
  tagText: string;
  tone: EssayCriterionTone;
  suggestion: string;
  deductionText: string;
  count?: number | null;
};

type EssayDisplaySection = {
  key: string;
  label: string;
  score: number;
  fullScore: number;
  excerpt: string;
  comment: string;
  criteria: EssayCriterionDisplay[];
  keywordMatches: SubjectiveEssayKeywordGroupMatch[];
  factualErrors: string[];
  suggestedText: string;
  suggestedTitle: string;
  replacementThesis: string;
};

type QuestionPerformanceRow = {
  questionNo: string;
  questionType: 'subjective' | 'essay';
  fullScore: number;
  averageScore: number;
  scoreRate: number;
  gradedCount: number;
  reviewCount: number;
};

type OrdinaryPointHitRow = {
  key: string;
  questionNo: string;
  sectionLabel: string;
  pointLabel: string;
  fullScore: number;
  gradedCount: number;
  hitCount: number;
  hitRate: number;
};

type OrdinaryPointHitGroup = {
  questionNo: string;
  questionType: 'subjective';
  gradedCount: number;
  points: OrdinaryPointHitRow[];
};

type EssayIssueLabel =
  | '缺少论题'
  | '对象有误'
  | '判断不到位'
  | '缺少史实'
  | '缺少回扣论题'
  | '缺少结论/升华'
  | '存在史实错误';

type EssayIssueStudent = {
  studentId: string;
  studentName: string;
};

type EssayIssueRow = {
  key: string;
  label: EssayIssueLabel;
  count: number;
  rate: number;
  students: EssayIssueStudent[];
};

type EssayIssueGroup = {
  questionNo: string;
  gradedCount: number;
  issues: EssayIssueRow[];
};

type SubjectiveAnalysisData = {
  gradedStudentCount: number;
  selectedQuestionCount: number;
  questionPerformance: QuestionPerformanceRow[];
  ordinaryPointHitGroups: OrdinaryPointHitGroup[];
  essayIssueGroups: EssayIssueGroup[];
};

type SubjectiveReviewQueueItem = {
  questionNo: string;
  questionScore: number;
  studentId: string;
  studentName: string;
  earnedScore: number;
  statusText: string;
  statusTone: 'pending' | 'confirmed' | 'adjusted';
};

type ReviewDraft = {
  mode: 'confirm' | 'adjust';
  scoreInput: string;
  reasonInput: string;
};

const STUDENT_BATCH_SIZE = 3;
const BACKEND_STUDENT_CONCURRENCY = 2;

const SUBJECTIVE_PROFILE_OPTIONS: Array<{ value: SubjectiveGradingProfile; label: string }> = [
  { value: 'general', label: '通用模式' },
  { value: 'subjectiveGrading', label: '阅卷专用' },
];

const CIRCLED_NUMBERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

function compareQuestionNo(left: string, right: string) {
  return String(left || '').localeCompare(String(right || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function normalizeText(value: string) {
  return String(value || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function formatDateLabel(value: string) {
  if (!value) return '尚未批改';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

function clampScore(score: number, fullScore: number) {
  const numeric = Number(score || 0);
  if (!Number.isFinite(numeric)) return 0;
  if (fullScore > 0) {
    return Math.max(0, Math.min(fullScore, numeric));
  }
  return Math.max(0, numeric);
}

function getReviewStatusMeta(reviewState?: SubjectiveQuestionGradeRecord['reviewState']) {
  if (reviewState === 'adjusted') {
    return {
      text: '教师已改分',
      tone: 'adjusted' as const,
    };
  }
  if (reviewState === 'confirmed') {
    return {
      text: '教师已确认',
      tone: 'confirmed' as const,
    };
  }
  return {
    text: '等待教师复核',
    tone: 'pending' as const,
  };
}

function getReviewDraftKey(studentId: string, questionNo: string) {
  return `${studentId}::${questionNo}`;
}

function uniqueTextItems(values: string[] | undefined, limit = 8) {
  return Array.from(
    new Set((Array.isArray(values) ? values : []).map((item) => normalizeText(item)).filter(Boolean)),
  ).slice(0, limit);
}

function toChineseNumber(value: string) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (/^\d+$/.test(normalized)) return Number(normalized);

  const map: Record<string, number> = {
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

  if (normalized === '十') return 10;
  if (normalized.startsWith('十')) {
    return 10 + (map[normalized.slice(1)] || 0);
  }
  if (normalized.endsWith('十')) {
    return (map[normalized[0]] || 0) * 10;
  }
  if (normalized.includes('十')) {
    const [left, right] = normalized.split('十');
    return (map[left] || 0) * 10 + (map[right] || 0);
  }
  return map[normalized] || null;
}

function extractSubquestionIndex(value: string) {
  const text = normalizeText(value);
  if (!text) return null;

  const bracketMatch = text.match(/[（(]([1-9]\d*)[）)]/);
  if (bracketMatch) {
    return Number(bracketMatch[1]);
  }

  const ordinalDigitMatch = text.match(/第\s*([1-9]\d*)\s*(?:小题|段|部分|方面)?/);
  if (ordinalDigitMatch) {
    return Number(ordinalDigitMatch[1]);
  }

  const ordinalChineseMatch = text.match(/第\s*([一二三四五六七八九十]+)\s*(?:小题|段|部分|方面)?/);
  if (ordinalChineseMatch) {
    return toChineseNumber(ordinalChineseMatch[1]);
  }

  const circledIndex = CIRCLED_NUMBERS.findIndex((marker) => text.includes(marker));
  if (circledIndex !== -1) {
    return circledIndex + 1;
  }

  return null;
}

function formatSectionTitle(title: string) {
  const normalized = normalizeText(title);
  if (!normalized) return '评分分区';
  if (/^[（(]\d+[）)]小题$/.test(normalized)) {
    return `第${normalized}`;
  }
  return normalized;
}

function getReviewGroupTone(score: number, fullScore: number) {
  if (fullScore <= 0) return score > 0 ? 'good' : 'mid';
  const ratio = Math.max(0, score) / fullScore;
  if (ratio >= 0.85) return 'good';
  if (ratio >= 0.45) return 'mid';
  return 'low';
}

function formatReviewGroupScore(score: number, fullScore: number) {
  if (fullScore > 0) {
    return `${Math.max(0, score)} / ${fullScore} 分`;
  }
  return `${Math.max(0, score)} 分`;
}

function buildStudentGroups(students: StudentRecord[]) {
  const orderedStudents = [...students];
  if (!orderedStudents.length) return [] as StudentGroup[];

  const groupCount = Math.min(8, Math.max(1, Math.ceil(orderedStudents.length / 6)));
  const baseSize = Math.floor(orderedStudents.length / groupCount);
  let remainder = orderedStudents.length % groupCount;
  let cursor = 0;

  const groups: StudentGroup[] = [];
  for (let index = 0; index < groupCount; index += 1) {
    const size = baseSize + (remainder > 0 ? 1 : 0);
    const members = orderedStudents.slice(cursor, cursor + size);
    cursor += size;
    remainder = Math.max(0, remainder - 1);
    if (!members.length) continue;

    groups.push({
      id: `group-${index + 1}`,
      label: `第${index + 1}组`,
      students: members,
    });
  }

  return groups;
}

function hasCurrentStudentSubmission(student: StudentRecord) {
  return student.subjectiveAnswers.some((answer) => answer.hasOverride || answer.baseState !== 'missing');
}

function hasReviewableSubmission(student: StudentRecord, questionNos: string[]) {
  if (!questionNos.length) return false;
  return student.subjectiveAnswers.some(
    (answer) => questionNos.includes(answer.questionNo) && (answer.hasOverride || answer.baseState !== 'missing'),
  );
}

function isCurrentSubjectiveSummary(student: StudentRecord, summary: SubjectiveStudentSummary | null) {
  if (!summary) return false;
  return hasCurrentStudentSubmission(student);
}

function getLegacySectionMeta(label: string, index: number) {
  const explicitIndex = extractSubquestionIndex(label);
  if (explicitIndex != null) {
    return {
      key: `legacy-section-${explicitIndex}`,
      label: `（${explicitIndex}）小题`,
      order: explicitIndex,
    };
  }

  return {
    key: `legacy-section-${index + 1}`,
    label: normalizeText(label) || `评分分区 ${index + 1}`,
    order: index + 1,
  };
}

function getPointReviews(grade: SubjectiveQuestionGradeRecord | null): SubjectivePointReview[] {
  if (grade?.pointReviews?.length) {
    return [...grade.pointReviews].sort(
      (left, right) =>
        Number(left.sectionOrder || 0) - Number(right.sectionOrder || 0)
        || Number(left.pointOrder || 0) - Number(right.pointOrder || 0),
    );
  }

  return (grade?.subReviews || [])
    .map((review, index) => {
      const sectionMeta = getLegacySectionMeta(review.label, index);
      return {
        key: `legacy-point-${index + 1}`,
        sectionKey: sectionMeta.key,
        sectionLabel: sectionMeta.label,
        sectionOrder: sectionMeta.order,
        pointOrder: index + 1,
        pointLabel: normalizeText(review.label) || `要点 ${index + 1}`,
        score: Number(review.score || 0),
        fullScore: Math.max(0, Number(review.fullScore || 0)),
        comment: normalizeText(review.comment),
        matchedExcerpts: (review.matchedExcerpts || []).map((excerpt) => normalizeText(excerpt)).filter(Boolean),
      };
    })
    .sort(
      (left, right) =>
        Number(left.sectionOrder || 0) - Number(right.sectionOrder || 0)
        || Number(left.pointOrder || 0) - Number(right.pointOrder || 0),
    );
}

function getSectionReviews(grade: SubjectiveQuestionGradeRecord | null): SubjectiveSectionReview[] {
  if (grade?.sectionReviews?.length) {
    return [...grade.sectionReviews].sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
  }

  if (grade?.displaySubReviews?.length) {
    return grade.displaySubReviews
      .map((review, index) => {
        const sectionMeta = getLegacySectionMeta(review.label, index);
        return {
          key: sectionMeta.key,
          label: sectionMeta.label,
          order: sectionMeta.order,
          score: Number(review.score || 0),
          fullScore: Math.max(0, Number(review.fullScore || 0)),
          comment: normalizeText(review.comment),
          pointKeys: [],
          matchedExcerpts: (review.matchedExcerpts || []).map((excerpt) => normalizeText(excerpt)).filter(Boolean),
        };
      })
      .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
  }

  const grouped = new Map<string, SubjectiveSectionReview>();
  getPointReviews(grade).forEach((point) => {
    if (!grouped.has(point.sectionKey)) {
      grouped.set(point.sectionKey, {
        key: point.sectionKey,
        label: point.sectionLabel,
        order: point.sectionOrder,
        score: 0,
        fullScore: 0,
        comment: '',
        pointKeys: [],
        matchedExcerpts: [],
      });
    }

    const section = grouped.get(point.sectionKey);
    if (!section) return;
    section.score += Number(point.score || 0);
    section.fullScore += Math.max(0, Number(point.fullScore || 0));
    section.pointKeys.push(point.key);
    section.matchedExcerpts = Array.from(new Set([...section.matchedExcerpts, ...(point.matchedExcerpts || [])]));
  });

  return Array.from(grouped.values()).sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
}

function buildSectionCommentText(section: SubquestionSection) {
  const comment = normalizeText(section.comment);
  if (comment) return comment;

  if (!section.points.length) {
    return '暂未生成分点点评，建议结合参考答案进行人工复核。';
  }

  const ratio = section.fullScore > 0 ? section.score / section.fullScore : 0;
  if (ratio >= 0.85) {
    return '本小题作答较完整，关键要点覆盖较好。';
  }
  if (ratio >= 0.45) {
    return '本小题答到了部分核心内容，但还存在明显遗漏。';
  }
  return '本小题关键内容覆盖不足，建议先对照参考答案补齐主干信息。';
}

function buildSubquestionSections(grade: SubjectiveQuestionGradeRecord | null): SubquestionSection[] {
  const sectionReviews = getSectionReviews(grade);
  const pointReviews = getPointReviews(grade);
  const sectionPointMap = new Map<string, ReviewPoint[]>();

  pointReviews.forEach((point) => {
    if (!sectionPointMap.has(point.sectionKey)) {
      sectionPointMap.set(point.sectionKey, []);
    }
    sectionPointMap.get(point.sectionKey)?.push({
      key: point.key,
      label: point.pointLabel,
      score: Number(point.score || 0),
      fullScore: Math.max(0, Number(point.fullScore || 0)),
      comment: normalizeText(point.comment),
    });
  });

  if (sectionReviews.length) {
    return sectionReviews.map((section) => ({
      key: section.key,
      title: section.label,
      score: Number(section.score || 0),
      fullScore: Math.max(0, Number(section.fullScore || 0)),
      comment: normalizeText(section.comment),
      points: (sectionPointMap.get(section.key) || []).slice().sort((left, right) => compareQuestionNo(left.label, right.label)),
    }));
  }

  return Array.from(sectionPointMap.entries()).map(([sectionKey, points], index) => ({
    key: sectionKey,
    title: pointReviews.find((point) => point.sectionKey === sectionKey)?.sectionLabel || `评分分区 ${index + 1}`,
    score: points.reduce((sum, point) => sum + point.score, 0),
    fullScore: points.reduce((sum, point) => sum + Math.max(0, point.fullScore), 0),
    comment: '',
    points: points.slice().sort((left, right) => compareQuestionNo(left.label, right.label)),
  }));
}

function findAllExcerptRanges(answer: string, excerpt: string) {
  const source = String(answer || '');
  const needle = normalizeText(excerpt);
  if (!source || !needle) return [] as Array<{ start: number; end: number }>;

  const matches: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < source.length) {
    const index = source.indexOf(needle, cursor);
    if (index === -1) break;
    matches.push({ start: index, end: index + needle.length });
    cursor = index + needle.length;
  }
  return matches;
}

function buildAnnotationRanges(answer: string, grade: SubjectiveQuestionGradeRecord | null): AnswerAnnotationRange[] {
  const source = String(answer || '');
  if (!source || !grade) return [];

  const savedRanges = (grade.annotationRanges || [])
    .map((range, index) => ({
      key: normalizeText(range.key || '') || `saved-${index + 1}`,
      start: Number(range.start || 0),
      end: Number(range.end || 0),
      tone: range.tone,
      score: typeof range.score === 'number' ? range.score : undefined,
      reason: normalizeText(range.reason || ''),
      pointKey: normalizeText(range.pointKey || ''),
      sectionKey: normalizeText(range.sectionKey || ''),
    }))
    .filter((range) => range.end > range.start && range.start >= 0 && range.end <= source.length);

  if (savedRanges.length) {
    return savedRanges.sort((left, right) => left.start - right.start || left.end - right.end);
  }

  const candidates: AnswerAnnotationRange[] = [];
  const scoredPointKeys = new Set<string>();

  getPointReviews(grade).forEach((point, pointIndex) => {
    point.matchedExcerpts.forEach((excerpt, excerptIndex) => {
      findAllExcerptRanges(source, excerpt).forEach((range, rangeIndex) => {
        const attachScore = !scoredPointKeys.has(point.key) && Number(point.score || 0) > 0;
        candidates.push({
          key: `point-${pointIndex + 1}-${excerptIndex + 1}-${rangeIndex + 1}`,
          start: range.start,
          end: range.end,
          tone: 'match',
          score: attachScore ? Number(point.score || 0) : undefined,
          pointKey: point.key,
          sectionKey: point.sectionKey,
        });
        if (attachScore) {
          scoredPointKeys.add(point.key);
        }
      });
    });
  });

  (grade.annotations.errors || []).forEach((item, errorIndex) => {
    findAllExcerptRanges(source, item.excerpt).forEach((range, rangeIndex) => {
      candidates.push({
        key: `error-${errorIndex + 1}-${rangeIndex + 1}`,
        start: range.start,
        end: range.end,
        tone: 'error',
        reason: normalizeText(item.reason || '') || '表述存在问题',
      });
    });
  });

  const accepted: AnswerAnnotationRange[] = [];
  candidates
    .sort((left, right) => {
      if (left.start !== right.start) return left.start - right.start;
      if (left.tone !== right.tone) return left.tone === 'error' ? -1 : 1;
      return (left.end - left.start) - (right.end - right.start);
    })
    .forEach((candidate) => {
      const previous = accepted[accepted.length - 1];
      if (previous && candidate.start < previous.end) return;
      accepted.push(candidate);
    });

  return accepted;
}

function buildAnnotatedAnswer(answer: string, grade: SubjectiveQuestionGradeRecord | null): AnnotatedAnswer {
  const source = String(answer || '');
  if (!source) {
    return {
      source: '',
      segments: [],
      scoredRangeCount: 0,
      awardedScoreTotal: 0,
      errorRangeCount: 0,
    };
  }

  const ranges = buildAnnotationRanges(source, grade);
  if (!ranges.length) {
    return {
      source,
      segments: [{ text: source, tone: 'plain', start: 0, end: source.length }],
      scoredRangeCount: 0,
      awardedScoreTotal: 0,
      errorRangeCount: 0,
    };
  }

  const segments: AnswerSegment[] = [];
  let cursor = 0;

  ranges.forEach((range) => {
    const start = Math.max(0, Math.min(source.length, range.start));
    const end = Math.max(start, Math.min(source.length, range.end));
    if (cursor < start) {
      segments.push({
        text: source.slice(cursor, start),
        tone: 'plain',
        start: cursor,
        end: start,
      });
    }

    segments.push({
      text: source.slice(start, end),
      tone: range.tone,
      reason: range.reason,
      awardedScore: range.score,
      pointKey: range.pointKey,
      sectionKey: range.sectionKey,
      start,
      end,
    });
    cursor = end;
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
    segments,
    scoredRangeCount: ranges.filter((range) => range.tone === 'match' && Number(range.score || 0) > 0).length,
    awardedScoreTotal: ranges.reduce((sum, range) => sum + (range.tone === 'match' ? Number(range.score || 0) : 0), 0),
    errorRangeCount: ranges.filter((range) => range.tone === 'error').length,
  };
}

const BUILT_IN_ESSAY_CRITERIA: Record<string, Record<string, { label: string; positiveTag: string; negativeTag: string }>> = {
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

function stripEssayCriterionLabel(label: string) {
  return normalizeText(label).replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
}

function getEssaySectionKind(label: string) {
  if (label === '论题') return 'thesis';
  if (label === '结论') return 'conclusion';
  return 'body';
}

function getEssayCriterionMeta(sectionKind: 'thesis' | 'body' | 'conclusion', code: string, label: string) {
  const builtIn = BUILT_IN_ESSAY_CRITERIA[sectionKind]?.[code];
  if (builtIn) return builtIn;

  const cleanLabel = stripEssayCriterionLabel(label) || '是否达标';
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

function buildEssayCriterionSuggestion(
  sectionKind: 'thesis' | 'body' | 'conclusion',
  code: string,
  sectionSuggestedText: string,
) {
  if (sectionSuggestedText) return sectionSuggestedText;

  if (sectionKind === 'thesis') {
    if (code === 'has_thesis') return '建议补出一句明确、完整的论题。';
    if (code === 'object_correct') return '建议把论题中的历史对象写得更准确。';
    if (code === 'judgment_correct') return '建议把题目要求的历史判断直接写进论题句。';
    return '建议把论题改得更明确、更聚焦。';
  }

  if (sectionKind === 'conclusion') {
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
  if (code === 'has_argument' || code === 'has_reasonable_explanation') return '建议把史实和论题之间的关系解释得更清楚。';
  if (code === 'factual_error') return '建议核对史实并改正错误后再组织表述。';
  return '建议根据本项标准补强这一部分。';
}

function getFallbackCriterionPassed(
  sectionKind: 'thesis' | 'body' | 'conclusion',
  code: string,
  checks: SubjectiveEssayReviewChecks | undefined,
  excerpt: string,
  factualErrorCount: number,
) {
  if (sectionKind === 'thesis') {
    if (code === 'has_thesis') {
      if (typeof checks?.hasThesis === 'boolean') return checks.hasThesis;
      return Boolean(excerpt);
    }
    if (code === 'object_correct') return checks?.isObjectCorrect ?? null;
    if (code === 'judgment_correct') return checks?.isJudgmentCorrect ?? null;
    return null;
  }

  if (sectionKind === 'conclusion') {
    if (code === 'has_summary' || code === 'has_conclusion') {
      if (typeof checks?.hasConclusion === 'boolean') return checks.hasConclusion;
      if (typeof checks?.hasSummary === 'boolean') return checks.hasSummary;
      return excerpt ? true : null;
    }
    if (code === 'has_elevation') return checks?.hasElevation ?? null;
    return null;
  }

  if (code === 'focus_on_thesis') return checks?.focusedOnThesis ?? null;
  if (code === 'within_scope') return checks?.isWithinScope ?? null;
  if (code === 'has_heading') return checks?.hasHeading ?? null;
  if (code === 'has_evidence') return checks?.hasHistoricalEvidence ?? null;
  if (code === 'explains_evidence') return checks?.explainsEvidence ?? checks?.hasReasonableExplanation ?? checks?.hasAnalysis ?? null;
  if (code === 'links_back_to_thesis') return checks?.linksBackToThesis ?? checks?.hasReasonableExplanation ?? checks?.hasAnalysis ?? null;
  if (code === 'has_argument' || code === 'has_reasonable_explanation') {
    return checks?.hasReasonableExplanation ?? checks?.hasAnalysis ?? null;
  }
  if (code === 'factual_error') {
    if (typeof checks?.isFactuallyAccurate === 'boolean') return checks.isFactuallyAccurate;
    return factualErrorCount === 0 ? true : false;
  }
  return null;
}

function buildFallbackCriterionResults(
  sectionKind: 'thesis' | 'body' | 'conclusion',
  checks: SubjectiveEssayReviewChecks | undefined,
  excerpt: string,
  factualErrors: string[],
) {
  const configs = BUILT_IN_ESSAY_CRITERIA[sectionKind];
  const factualErrorCount = Math.max(factualErrors.length, Number(checks?.factualErrorCount ?? 0));
  const visibleCodes = sectionKind === 'thesis'
    ? ['has_thesis', 'object_correct', 'judgment_correct']
    : (sectionKind === 'conclusion'
      ? ['has_summary', 'has_elevation']
      : ['focus_on_thesis', 'within_scope', 'has_heading', 'has_evidence', 'explains_evidence', 'links_back_to_thesis', 'factual_error']);

  return visibleCodes
    .map((code) => {
      const config = configs?.[code];
      const passed = getFallbackCriterionPassed(sectionKind, code, checks, excerpt, factualErrorCount);
      if (passed == null && !(code === 'factual_error' && factualErrorCount >= 0)) {
        return null;
      }

      return {
        code,
        label: config.label,
        passed,
        positiveTag: config.positiveTag,
        negativeTag: config.negativeTag,
        suggestion: '',
        deductionText: '',
        count: code === 'factual_error' ? factualErrorCount : null,
      } satisfies SubjectiveEssayCriterionResult;
    })
    .filter(Boolean) as SubjectiveEssayCriterionResult[];
}

function essayCriteriaTriggeredPenalty(criteria: EssayCriterionDisplay[]) {
  return criteria.some((item) => item.tone === 'bad' || (item.code === 'factual_error' && Number(item.count || 0) > 0));
}

function normalizeEssayCriteria(
  label: string,
  excerpt: string,
  sectionSuggestedText: string,
  checks: SubjectiveEssayReviewChecks | undefined,
  factualErrors: string[],
  rawCriteriaResults: SubjectiveEssayCriterionResult[] | undefined,
) {
  const sectionKind = getEssaySectionKind(label);
  const factualErrorCount = Math.max(factualErrors.length, Number(checks?.factualErrorCount ?? 0));
  const sourceCriteria = Array.isArray(rawCriteriaResults) && rawCriteriaResults.length
    ? rawCriteriaResults
    : buildFallbackCriterionResults(sectionKind, checks, excerpt, factualErrors);

  return sourceCriteria
    .map((item) => {
      const code = normalizeText(item?.code || '') || `criterion-${Math.random().toString(36).slice(2, 8)}`;
      const meta = getEssayCriterionMeta(sectionKind, code, item?.label || '');
      const passed = typeof item?.passed === 'boolean'
        ? item.passed
        : getFallbackCriterionPassed(sectionKind, code, checks, excerpt, factualErrorCount);
      const count = typeof item?.count === 'number'
        ? Math.max(0, item.count)
        : (code === 'factual_error' ? factualErrorCount : null);
      const isNegative = passed === false || (code === 'factual_error' && Number(count || 0) > 0);
      const tone: EssayCriterionTone = passed === true && !isNegative
        ? 'good'
        : (isNegative ? 'bad' : 'neutral');
      const tagText = tone === 'good'
        ? (normalizeText(item?.positiveTag || '') || meta.positiveTag)
        : tone === 'bad'
          ? (normalizeText(item?.negativeTag || '') || meta.negativeTag)
          : (stripEssayCriterionLabel(item?.label || '') || meta.label);

      return {
        code,
        label: stripEssayCriterionLabel(item?.label || '') || meta.label,
        tagText: code === 'factual_error' && tone === 'bad' && Number(count || 0) > 0 ? `${tagText}×${count}` : tagText,
        tone,
        suggestion: normalizeText(item?.suggestion || '') || (tone === 'bad' ? buildEssayCriterionSuggestion(sectionKind, code, sectionSuggestedText) : ''),
        deductionText: normalizeText(item?.deductionText || ''),
        count,
      };
    })
    .filter((item) => item.label || item.tagText);
}

function resolveEssaySuggestedText(
  label: string,
  section: SubjectiveEssayReview['thesis'] | SubjectiveEssayReview['conclusion'] | SubjectiveEssayReview['bodySections'][number],
  criteria: EssayCriterionDisplay[],
) {
  const direct = normalizeText((section as { suggestedText?: string }).suggestedText || '');
  if (direct) return direct;

  const mergedSuggestions = Array.from(
    new Set(
      criteria
        .filter((item) => item.tone === 'bad')
        .map((item) => normalizeText(item.suggestion || ''))
        .filter(Boolean),
    ),
  );

  if (!mergedSuggestions.length) return '';

  if (label === '论题' || label === '结论') {
    return mergedSuggestions[0];
  }

  return mergedSuggestions.join('\n');
}

function resolveEssaySuggestedTitle(label: string, criteria: EssayCriterionDisplay[]) {
  if (label === '论题') return '建议论题';
  if (label === '结论') {
    const hasMissingConclusion = criteria.some(
      (item) => (item.code === 'has_summary' || item.code === 'has_conclusion') && item.tone === 'bad',
    );
    return hasMissingConclusion ? '建议结论' : '升华版结论';
  }
  return 'AI修改版';
}

function buildThesisKeywordTags(section: EssayDisplaySection) {
  if (section.label !== '论题') return [] as EssayCriterionDisplay[];

  const matchedTags = section.keywordMatches
    .filter((item) => item.matched)
    .map((item) => ({
      code: `keyword-match-${item.id || item.label}`,
      label: item.label,
      tagText: item.label,
      tone: 'good' as const,
      suggestion: '',
      deductionText: '',
      count: null,
    }));

  const missingTags = section.keywordMatches
    .filter((item) => !item.matched)
    .map((item) => ({
      code: `keyword-miss-${item.id || item.label}`,
      label: item.label,
      tagText: `未命中：${item.label}`,
      tone: 'bad' as const,
      suggestion: '',
      deductionText: '',
      count: null,
    }));

  const otherBadCriteria = section.criteria.filter((item) => item.tone === 'bad');
  return [...matchedTags, ...missingTags, ...otherBadCriteria];
}

function normalizeEssayDisplaySection(
  section: SubjectiveEssayReview['thesis'] | SubjectiveEssayReview['conclusion'] | SubjectiveEssayReview['bodySections'][number],
  fallbackKey: string,
  fallbackLabel: string,
): EssayDisplaySection | null {
  if (!section) return null;

  const label = normalizeText(section.label || '') || fallbackLabel;
  const excerpt = normalizeText(section.excerpt || '');
  const comment = normalizeText(section.comment || '');
  const factualErrors = uniqueTextItems(section.factualErrors, 4);
  const criteria = normalizeEssayCriteria(
    label,
    excerpt,
    normalizeText((section as { suggestedText?: string }).suggestedText || ''),
    section.checks,
    factualErrors,
    section.criteriaResults,
  );

  if (!excerpt && !comment && !criteria.length && !factualErrors.length && !Number(section.fullScore || 0)) {
    return null;
  }

  return {
    key: normalizeText(section.key || '') || fallbackKey,
    label,
    score: clampScore(Number(section.score || 0), Math.max(0, Number(section.fullScore || 0))),
    fullScore: Math.max(0, Number(section.fullScore || 0)),
    excerpt,
    comment,
    criteria,
    keywordMatches: Array.isArray(section.keywordGroupMatches) ? section.keywordGroupMatches : [],
    factualErrors,
    suggestedText: resolveEssaySuggestedText(label, section, criteria),
    suggestedTitle: resolveEssaySuggestedTitle(label, criteria),
    replacementThesis: label === '论题' && essayCriteriaTriggeredPenalty(criteria)
      ? normalizeText(section.replacementThesis || '')
      : '',
  };
}

function buildEssayDisplaySections(grade: SubjectiveQuestionGradeRecord | null) {
  const essayReview = grade?.essayReview;
  if (!essayReview) return [] as EssayDisplaySection[];

  const sections: EssayDisplaySection[] = [];
  const thesis = normalizeEssayDisplaySection(essayReview.thesis, 'essay-thesis', '论题');
  if (thesis) {
    sections.push(thesis);
  }

  (Array.isArray(essayReview.bodySections) ? essayReview.bodySections : []).forEach((section, index) => {
    const normalized = normalizeEssayDisplaySection(section, `essay-body-${index + 1}`, `第${index + 1}段`);
    if (normalized) {
      sections.push(normalized);
    }
  });

  const conclusion = normalizeEssayDisplaySection(essayReview.conclusion, 'essay-conclusion', '结论');
  if (conclusion) {
    sections.push(conclusion);
  }

  return sections;
}

function buildPendingComment(question: SubjectiveQuestion, student: StudentRecord) {
  const answerRecord = student.subjectiveAnswers.find((item) => item.questionNo === question.questionNo);
  const answerText = normalizeText(answerRecord?.content || '');
  if (!answerText) {
    return '这道题还没有识别到可用于批改的学生原文。';
  }

  if (question.type === 'essay') {
    return '开始批改后，这里会按论题、分段和结论展示结构化点评。';
  }
  return '开始批改后，这里会展示原文挂分和错误标记。';
}

function buildQuestionStatusText(question: SubjectiveQuestion, grade: SubjectiveQuestionGradeRecord | null, student: StudentRecord) {
  if (!grade) {
    return buildPendingComment(question, student);
  }

  if (question.type === 'essay') {
    if (grade.requiresReview) {
      return '本题存在需要人工复核的判断，请结合论题、分段和结论点评一起查看。';
    }
    return '本题已按论题、分段和结论生成结构化点评，不再在正文里挂分。';
  }

  if (grade.requiresReview) {
    return '本题存在需要人工复核的地方，请重点查看原文挂分和错误标记。';
  }
  return '本题已按学生原文完成挂分，可直接查看哪些句子得分、哪些句子存在问题。';
}

function buildStudentScoreText(summary: SubjectiveStudentSummary | null, totalScore: number) {
  if (!summary) return `待批改 / ${totalScore}`;
  return `${summary.earnedScore} / ${totalScore}`;
}

function formatPercent(value: number, digits = 0) {
  const numeric = Number.isFinite(value) ? value : 0;
  return `${(numeric * 100).toFixed(digits)}%`;
}

function formatScoreValue(value: number) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1).replace(/\.0$/, '');
}

function getQuestionGradeMap(summary: SubjectiveStudentSummary | null) {
  return new Map((summary?.questionGrades || []).map((grade) => [grade.questionNo, grade]));
}

const ESSAY_ISSUE_LABELS: EssayIssueLabel[] = [
  '缺少论题',
  '对象有误',
  '判断不到位',
  '缺少史实',
  '缺少回扣论题',
  '缺少结论/升华',
  '存在史实错误',
];

function collectEssayIssues(grade: SubjectiveQuestionGradeRecord | null): Set<EssayIssueLabel> {
  const issues = new Set<EssayIssueLabel>();
  const sections = buildEssayDisplaySections(grade);
  if (!sections.length) return issues;

  const thesis = sections.find((section) => section.label === '论题') || null;
  const conclusion = sections.find((section) => section.label === '结论') || null;
  const bodySections = sections.filter((section) => section.label !== '论题' && section.label !== '结论');

  if (thesis?.criteria.some((criterion) => criterion.code === 'has_thesis' && criterion.tone === 'bad')) {
    issues.add('缺少论题');
  }
  if (thesis?.criteria.some((criterion) => criterion.code === 'object_correct' && criterion.tone === 'bad')) {
    issues.add('对象有误');
  }
  if (thesis?.criteria.some((criterion) => criterion.code === 'judgment_correct' && criterion.tone === 'bad')) {
    issues.add('判断不到位');
  }
  if (bodySections.some((section) => section.criteria.some((criterion) => criterion.code === 'has_evidence' && criterion.tone === 'bad'))) {
    issues.add('缺少史实');
  }
  if (bodySections.some((section) => section.criteria.some((criterion) => criterion.code === 'links_back_to_thesis' && criterion.tone === 'bad'))) {
    issues.add('缺少回扣论题');
  }
  if (
    conclusion?.criteria.some((criterion) =>
      (criterion.code === 'has_summary' || criterion.code === 'has_conclusion' || criterion.code === 'has_elevation')
      && criterion.tone === 'bad',
    )
  ) {
    issues.add('缺少结论/升华');
  }
  if (
    sections.some((section) =>
      section.factualErrors.length
      || section.criteria.some((criterion) => criterion.code === 'factual_error' && criterion.tone === 'bad'),
    )
  ) {
    issues.add('存在史实错误');
  }

  return issues;
}

function buildSubjectiveAnalysisData(
  subjectiveQuestions: SubjectiveQuestion[],
  studentSummaries: SubjectiveStudentSummary[],
  selectedQuestionNos: string[],
): SubjectiveAnalysisData {
  const selectedSet = new Set(selectedQuestionNos);
  const targetQuestions = subjectiveQuestions.filter((question) => selectedSet.has(question.questionNo));
  const summaryGradeMaps = studentSummaries.map((summary) => ({
    summary,
    gradeMap: getQuestionGradeMap(summary),
  }));

  const questionPerformance: QuestionPerformanceRow[] = targetQuestions.map((question) => {
    const grades = summaryGradeMaps
      .map(({ gradeMap }) => gradeMap.get(question.questionNo) || null)
      .filter((grade): grade is SubjectiveQuestionGradeRecord => Boolean(grade));
    const totalEarned = grades.reduce((sum, grade) => sum + Number(grade.earnedScore || 0), 0);
    const reviewCount = grades.filter((grade) => grade.requiresReview).length;
    const averageScore = grades.length ? totalEarned / grades.length : 0;
    const maxTotal = grades.length * Math.max(0, Number(question.score || 0));

    return {
      questionNo: question.questionNo,
      questionType: question.type,
      fullScore: Math.max(0, Number(question.score || 0)),
      averageScore,
      scoreRate: maxTotal > 0 ? totalEarned / maxTotal : 0,
      gradedCount: grades.length,
      reviewCount,
    };
  }).sort((left, right) => left.scoreRate - right.scoreRate || compareQuestionNo(left.questionNo, right.questionNo));

  const ordinaryPointHitGroups: OrdinaryPointHitGroup[] = targetQuestions
    .filter((question) => question.type === 'subjective')
    .map((question) => {
      const grades = summaryGradeMaps
        .map(({ gradeMap }) => gradeMap.get(question.questionNo) || null)
        .filter((grade): grade is SubjectiveQuestionGradeRecord => grade != null && grade.questionType === 'subjective');
      const pointMap = new Map<string, OrdinaryPointHitRow>();

      grades.forEach((grade) => {
        getPointReviews(grade).forEach((point) => {
          const key = `${question.questionNo}:${point.sectionKey}:${point.key}`;
          if (!pointMap.has(key)) {
            pointMap.set(key, {
              key,
              questionNo: question.questionNo,
              sectionLabel: point.sectionLabel,
              pointLabel: point.pointLabel,
              fullScore: Math.max(0, Number(point.fullScore || 0)),
              gradedCount: grades.length,
              hitCount: 0,
              hitRate: 0,
            });
          }

          const row = pointMap.get(key);
          if (!row) return;
          if (Number(point.score || 0) > 0) {
            row.hitCount += 1;
          }
        });
      });

      const points = Array.from(pointMap.values())
        .map((item) => ({
          ...item,
          hitRate: item.gradedCount > 0 ? item.hitCount / item.gradedCount : 0,
        }))
        .sort((left, right) =>
          left.hitRate - right.hitRate
          || compareQuestionNo(left.sectionLabel, right.sectionLabel)
          || compareQuestionNo(left.pointLabel, right.pointLabel),
        );

      return {
        questionNo: question.questionNo,
        questionType: 'subjective' as const,
        gradedCount: grades.length,
        points,
      };
    })
    .filter((group) => group.points.length > 0);

  const essayIssueGroups: EssayIssueGroup[] = targetQuestions
    .filter((question) => question.type === 'essay')
    .map((question) => {
      const issueStudentsMap = new Map<EssayIssueLabel, EssayIssueStudent[]>(
        ESSAY_ISSUE_LABELS.map((label) => [label, []]),
      );

      summaryGradeMaps.forEach(({ summary, gradeMap }) => {
        const grade = gradeMap.get(question.questionNo) || null;
        if (!grade || grade.questionType !== 'essay') return;
        const student = {
          studentId: summary.studentId,
          studentName: summary.studentName,
        };
        collectEssayIssues(grade).forEach((issue) => {
          issueStudentsMap.get(issue)?.push(student);
        });
      });

      const gradedCount = summaryGradeMaps.reduce((count, { gradeMap }) => {
        const grade = gradeMap.get(question.questionNo) || null;
        return grade && grade.questionType === 'essay' ? count + 1 : count;
      }, 0);

      return {
        questionNo: question.questionNo,
        gradedCount,
        issues: ESSAY_ISSUE_LABELS.map((label) => {
          const students = issueStudentsMap.get(label) || [];
          const count = students.length;
          return {
            key: `${question.questionNo}:${label}`,
            label,
            count,
            rate: gradedCount > 0 ? count / gradedCount : 0,
            students,
          };
        })
          .filter((issue) => issue.count > 0)
          .sort((left, right) => right.count - left.count || right.rate - left.rate || compareQuestionNo(left.label, right.label)),
      };
    })
    .filter((group) => group.gradedCount > 0 && group.issues.length > 0);

  return {
    gradedStudentCount: studentSummaries.length,
    selectedQuestionCount: targetQuestions.length,
    questionPerformance,
    ordinaryPointHitGroups,
    essayIssueGroups,
  };
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getAnswerText(questionGrade: SubjectiveQuestionGradeRecord | null, answerRecord: AggregatedSubjectiveAnswer | undefined) {
  return String(questionGrade?.studentAnswer || answerRecord?.content || '');
}

function getHitTone(rate: number) {
  if (rate < 0.35) return 'low';
  if (rate < 0.7) return 'mid';
  return 'high';
}

export function SubjectiveGradingStage({ task, onTaskUpdated }: SubjectiveGradingStageProps) {
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [selectedQuestionNos, setSelectedQuestionNos] = useState<string[]>([]);
  const [profile, setProfile] = useState<SubjectiveGradingProfile>('general');
  const [currentRunScope, setCurrentRunScope] = useState<RunScope>('group');
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisData, setAnalysisData] = useState<SubjectiveAnalysisData | null>(null);
  const [analysisSignature, setAnalysisSignature] = useState('');
  const [currentStudentId, setCurrentStudentId] = useState('');
  const [runMessage, setRunMessage] = useState('');
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const [expandedPointSections, setExpandedPointSections] = useState<Record<string, boolean>>({});
  const [expandedReviewPanels, setExpandedReviewPanels] = useState<Record<string, boolean>>({});
  const [runTargetStudentIds, setRunTargetStudentIds] = useState<string[]>([]);
  const [pendingRunStudentIds, setPendingRunStudentIds] = useState<string[]>([]);
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ReviewDraft>>({});
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);

  const runTokenRef = useRef(0);
  const pauseRequestedRef = useRef(false);
  const questionSelectionInitializedRef = useRef(false);

  const subjectiveQuestions = useMemo(
    () =>
      (task?.questions ?? [])
        .filter((question): question is SubjectiveQuestion => (question.type === 'subjective' || question.type === 'essay') && question.enabled !== false)
        .sort((left, right) => compareQuestionNo(left.questionNo, right.questionNo)),
    [task?.questions],
  );

  const studentGroups = useMemo(() => buildStudentGroups(task?.studentRecords ?? []), [task?.studentRecords]);
  const orderedStudents = useMemo(() => studentGroups.flatMap((group) => group.students), [studentGroups]);
  const studentRecordMap = useMemo(
    () => new Map((task?.studentRecords ?? []).map((student) => [student.id, student])),
    [task?.studentRecords],
  );
  const studentGroupInfoMap = useMemo(
    () =>
      new Map(
        studentGroups.flatMap((group) =>
          group.students.map((student) => [student.id, group] as const),
        ),
      ),
    [studentGroups],
  );
  const summaryMap = useMemo(
    () => new Map((task?.subjectiveGrading?.studentSummaries ?? []).map((summary) => [summary.studentId, summary])),
    [task?.subjectiveGrading?.studentSummaries],
  );

  const totalSubjectiveScore = useMemo(
    () => subjectiveQuestions.reduce((sum, question) => sum + Number(question.score || 0), 0),
    [subjectiveQuestions],
  );

  const exportableStudentCount = useMemo(
    () =>
      (task?.subjectiveGrading?.studentSummaries ?? []).filter(
        (summary) => summary.gradedQuestionCount > 0 && Array.isArray(summary.questionGrades) && summary.questionGrades.length > 0,
      ).length,
    [task?.subjectiveGrading?.studentSummaries],
  );

  const hasSubjectiveResult = useMemo(
    () => (task?.subjectiveGrading?.studentSummaries ?? []).length > 0,
    [task?.subjectiveGrading?.studentSummaries],
  );

  const currentAnalysisSignature = useMemo(
    () => JSON.stringify({
      taskId: task?.id || '',
      selectedQuestionNos,
      lastRunAt: task?.subjectiveGrading?.lastRunAt || '',
      gradedStudentCount: task?.subjectiveGrading?.gradedStudentCount || 0,
      reviewQuestionCount: task?.subjectiveGrading?.reviewQuestionCount || 0,
    }),
    [
      selectedQuestionNos,
      task?.id,
      task?.subjectiveGrading?.gradedStudentCount,
      task?.subjectiveGrading?.lastRunAt,
      task?.subjectiveGrading?.reviewQuestionCount,
    ],
  );

  useEffect(() => {
    const available = subjectiveQuestions.map((question) => question.questionNo);
    setSelectedQuestionNos((current) => {
      const filtered = current.filter((questionNo) => available.includes(questionNo));
      if (!questionSelectionInitializedRef.current) {
        questionSelectionInitializedRef.current = true;
        return filtered.length ? filtered : available;
      }
      return filtered;
    });
  }, [subjectiveQuestions]);

  useEffect(() => {
    runTokenRef.current += 1;
    pauseRequestedRef.current = false;
    questionSelectionInitializedRef.current = false;
    setSelectedGroupId('');
    setSelectedStudentId('');
    setCurrentRunScope('group');
    setIsRunning(false);
    setIsPaused(false);
    setIsExporting(false);
    setIsClearing(false);
    setIsAnalyzing(false);
    setAnalysisData(null);
    setAnalysisSignature('');
    setCurrentStudentId('');
    setRunMessage('');
    setRunErrors({});
    setExpandedPointSections({});
    setExpandedReviewPanels({});
    setRunTargetStudentIds([]);
    setPendingRunStudentIds([]);
    setReviewDrafts({});
    setIsSubmittingReview(false);
  }, [task?.id]);

  const selectedQuestionNoSet = useMemo(() => new Set(selectedQuestionNos), [selectedQuestionNos]);

  const preferredGroupId = useMemo(
    () => studentGroups.find((group) => group.students.some((student) => hasReviewableSubmission(student, selectedQuestionNos)))?.id || '',
    [selectedQuestionNos, studentGroups],
  );

  useEffect(() => {
    if (!studentGroups.length) {
      setSelectedGroupId('');
      return;
    }

    const currentGroup = studentGroups.find((group) => group.id === selectedGroupId) || null;
    if (!currentGroup) {
      setSelectedGroupId(preferredGroupId || studentGroups[0].id);
      return;
    }

    if (selectedQuestionNos.length) {
      const currentHasReviewable = currentGroup.students.some((student) => hasReviewableSubmission(student, selectedQuestionNos));
      if (!currentHasReviewable && preferredGroupId && preferredGroupId !== currentGroup.id) {
        setSelectedGroupId(preferredGroupId);
      }
    }
  }, [preferredGroupId, selectedGroupId, selectedQuestionNos, studentGroups]);

  const currentGroup = useMemo(
    () => studentGroups.find((group) => group.id === selectedGroupId) || studentGroups[0] || { id: '', label: '当前分组', students: [] },
    [selectedGroupId, studentGroups],
  );

  useEffect(() => {
    if (!currentGroup.students.length) {
      setSelectedStudentId('');
      return;
    }

    if (!currentGroup.students.some((student) => student.id === selectedStudentId)) {
      setSelectedStudentId(currentGroup.students[0].id);
    }
  }, [currentGroup, selectedStudentId]);

  const displayedQuestions = useMemo(
    () => subjectiveQuestions.filter((question) => selectedQuestionNoSet.has(question.questionNo)),
    [selectedQuestionNoSet, subjectiveQuestions],
  );

  const selectedStudent = useMemo(
    () => currentGroup.students.find((student) => student.id === selectedStudentId) || null,
    [currentGroup.students, selectedStudentId],
  );

  const selectedStudentSummary = useMemo(() => {
    if (!selectedStudent) return null;
    const summary = summaryMap.get(selectedStudent.id) || null;
    return isCurrentSubjectiveSummary(selectedStudent, summary) ? summary : null;
  }, [selectedStudent, summaryMap]);

  const visibleRunScope = isRunning || isPaused ? currentRunScope : 'group';
  const progressStudents = useMemo(
    () => (visibleRunScope === 'class' ? orderedStudents : currentGroup.students),
    [currentGroup.students, orderedStudents, visibleRunScope],
  );
  const progressReviewableStudents = useMemo(
    () => progressStudents.filter((student) => hasReviewableSubmission(student, selectedQuestionNos)),
    [progressStudents, selectedQuestionNos],
  );

  const completedStudentIds = useMemo(() => {
    if (!selectedQuestionNos.length) return new Set<string>();

    return new Set(
      progressReviewableStudents
        .filter((student) => {
          const summary = summaryMap.get(student.id) || null;
          if (!summary || !isCurrentSubjectiveSummary(student, summary)) return false;
          const gradedQuestionNos = new Set((summary.questionGrades || []).map((grade) => grade.questionNo));
          return selectedQuestionNos.every((questionNo) => gradedQuestionNos.has(questionNo));
        })
        .map((student) => student.id),
    );
  }, [progressReviewableStudents, selectedQuestionNos, summaryMap]);

  const runTotalCount = runTargetStudentIds.length || progressReviewableStudents.length;
  const runCompletedCount = runTargetStudentIds.length
    ? Math.max(0, runTargetStudentIds.length - pendingRunStudentIds.length)
    : completedStudentIds.size;
  const progressPercent = runTotalCount > 0 ? Math.round((runCompletedCount / runTotalCount) * 100) : 0;

  const currentRunStudent = useMemo(
    () => (currentStudentId ? studentRecordMap.get(currentStudentId) || null : null),
    [currentStudentId, studentRecordMap],
  );
  const currentRunStudentGroup = useMemo(
    () => (currentStudentId ? studentGroupInfoMap.get(currentStudentId) || null : null),
    [currentStudentId, studentGroupInfoMap],
  );

  const reviewQueueByQuestion = useMemo(() => {
    const grouped = new Map<string, SubjectiveReviewQueueItem[]>();
    const studentSummaries = task?.subjectiveGrading?.studentSummaries ?? [];
    studentSummaries.forEach((summary) => {
      (summary.questionGrades || []).forEach((grade) => {
        if (!grade.requiresReview) return;
        const question = subjectiveQuestions.find((item) => item.questionNo === grade.questionNo) || null;
        if (!question) return;
        const statusMeta = getReviewStatusMeta(grade.reviewState);
        if (!grouped.has(grade.questionNo)) {
          grouped.set(grade.questionNo, []);
        }
        grouped.get(grade.questionNo)?.push({
          questionNo: grade.questionNo,
          questionScore: Number(grade.questionScore || question.score || 0),
          studentId: summary.studentId,
          studentName: summary.studentName,
          earnedScore: Number(grade.earnedScore || 0),
          statusText: statusMeta.text,
          statusTone: statusMeta.tone,
        });
      });
    });
    grouped.forEach((items) => items.sort((left, right) => left.studentName.localeCompare(right.studentName, 'zh-CN')));
    return grouped;
  }, [subjectiveQuestions, task?.subjectiveGrading?.studentSummaries]);

  useEffect(() => {
    setExpandedPointSections({});
  }, [selectedStudentId]);

  useEffect(() => {
    if (!selectedStudentId) return;
    const pendingQuestionNos = (summaryMap.get(selectedStudentId)?.questionGrades || [])
      .filter((grade) => grade.requiresReview)
      .map((grade) => grade.questionNo);
    if (!pendingQuestionNos.length) return;
    setExpandedReviewPanels((current) => {
      let changed = false;
      const next = { ...current };
      pendingQuestionNos.forEach((questionNo) => {
        const key = getReviewDraftKey(selectedStudentId, questionNo);
        if (!(key in next)) {
          next[key] = false;
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [selectedStudentId, summaryMap]);

  function toggleSectionDetails(key: string) {
    setExpandedPointSections((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }

  function toggleQuestion(questionNo: string) {
    setSelectedQuestionNos((current) => (
      current.includes(questionNo)
        ? current.filter((item) => item !== questionNo)
        : [...current, questionNo].sort(compareQuestionNo)
    ));
  }

  function selectAllQuestions() {
    setSelectedQuestionNos(subjectiveQuestions.map((question) => question.questionNo));
  }

  function clearQuestionSelection() {
    setSelectedQuestionNos([]);
  }

  async function executeRun(scope: RunScope, resume = false) {
    if (!task?.id) return;
    if (!selectedQuestionNos.length) {
      setRunMessage('请先勾选要批改的题目。');
      return;
    }

    const baseStudents = scope === 'class' ? orderedStudents : currentGroup.students;
    const targetStudentIds = (
      resume && pendingRunStudentIds.length
        ? pendingRunStudentIds
        : baseStudents
            .filter((student) => hasReviewableSubmission(student, selectedQuestionNos))
            .map((student) => student.id)
    );

    if (!targetStudentIds.length) {
      setRunMessage(scope === 'class' ? '全班范围内没有可批改的学生。' : '当前分组没有可批改的学生。');
      return;
    }

    const token = runTokenRef.current + 1;
    runTokenRef.current = token;
    pauseRequestedRef.current = false;

    setCurrentRunScope(scope);
    setIsRunning(true);
    setIsPaused(false);
    setRunErrors({});
    setRunTargetStudentIds(targetStudentIds);
    setPendingRunStudentIds(targetStudentIds);
    setRunMessage(scope === 'class' ? '开始按全班范围批改。' : `开始批改 ${currentGroup.label}。`);

    let remaining = [...targetStudentIds];
    const nextErrors: Record<string, string> = {};

    try {
      while (remaining.length) {
        if (pauseRequestedRef.current) {
          setIsPaused(true);
          setRunMessage('已暂停，点击继续后会从剩余学生接着批改。');
          break;
        }

        const batch = remaining.slice(0, STUDENT_BATCH_SIZE);
        setCurrentStudentId(batch[0] || '');

        const batchStudentNames = batch
          .map((studentId) => studentRecordMap.get(studentId)?.studentName || '')
          .filter(Boolean)
          .join('、');
        setRunMessage(batchStudentNames ? `正在批改：${batchStudentNames}` : '正在批改当前批次。');

        const response = await runSubjectiveGrading(task.id, {
          profile,
          studentIds: batch,
          questionNos: selectedQuestionNos,
          studentConcurrency: BACKEND_STUDENT_CONCURRENCY,
        });

        if (runTokenRef.current !== token) {
          return;
        }

        response.failedStudents.forEach((item) => {
          nextErrors[item.studentId] = item.message;
        });

        onTaskUpdated(response.task);

        remaining = remaining.slice(batch.length);
        setPendingRunStudentIds(remaining);
      }

      if (!pauseRequestedRef.current) {
        setRunMessage(Object.keys(nextErrors).length ? '批改完成，部分学生需要重新查看。' : '批改完成。');
        setPendingRunStudentIds([]);
        setRunTargetStudentIds([]);
      }
    } catch (error) {
      if (runTokenRef.current !== token) {
        return;
      }
      setRunMessage(`批改中断：${getErrorMessage(error)}`);
      setIsPaused(false);
    } finally {
      if (runTokenRef.current === token) {
        setRunErrors(nextErrors);
        setCurrentStudentId('');
        setIsRunning(false);
        if (!pauseRequestedRef.current || !remaining.length) {
          setIsPaused(false);
          setPendingRunStudentIds([]);
          setRunTargetStudentIds([]);
        }
      }
    }
  }

  function handlePause() {
    if (!isRunning) return;
    pauseRequestedRef.current = true;
    setRunMessage('当前批次完成后暂停。');
  }

  async function handleClear() {
    if (!task?.id) return;
    const shouldContinue = window.confirm('确定要清空当前任务的主观题批改结果吗？');
    if (!shouldContinue) return;

    setIsClearing(true);
    try {
      const response = await clearSubjectiveGrading(task.id);
      onTaskUpdated(response.task);
      setRunMessage('已清空当前任务的主观题批改结果。');
      setRunErrors({});
    } catch (error) {
      setRunMessage(`清空失败：${getErrorMessage(error)}`);
    } finally {
      setIsClearing(false);
    }
  }

  async function handleExport() {
    if (!task?.id) return;
    setIsExporting(true);
    try {
      const result = await exportSubjectiveGradingDocx(task.id);
      downloadBlob(result.blob, result.fileName);
      setRunMessage('已导出主观题批改文档。');
    } catch (error) {
      setRunMessage(`导出失败：${getErrorMessage(error)}`);
    } finally {
      setIsExporting(false);
    }
  }

  function handleAnalyze() {
    if (!hasSubjectiveResult || isRunning || isClearing) return;
    setIsAnalyzing(true);
    setRunMessage('正在生成主观题学情分析…');

    startTransition(() => {
      const nextData = buildSubjectiveAnalysisData(
        subjectiveQuestions,
        task?.subjectiveGrading?.studentSummaries ?? [],
        selectedQuestionNos,
      );
      setAnalysisData(nextData);
      setAnalysisSignature(currentAnalysisSignature);
      setIsAnalyzing(false);
      setRunMessage('主观题学情分析已更新。');
    });
  }

  const analysisNeedsRefresh = analysisSignature !== '' && analysisSignature !== currentAnalysisSignature;

  function jumpToStudent(studentId: string) {
    const student = studentRecordMap.get(studentId) || null;
    const group = studentGroupInfoMap.get(studentId) || null;
    if (!student || !group) return;
    setSelectedGroupId(group.id);
    setSelectedStudentId(student.id);
    setRunMessage(`已定位到 ${student.studentName}，可继续查看对应主观题批改详情。`);
  }

  function toggleReviewPanel(studentId: string, questionNo: string) {
    const key = getReviewDraftKey(studentId, questionNo);
    setExpandedReviewPanels((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }

  function focusQuestionReview(questionNo: string) {
    if (!selectedStudent) return;
    toggleReviewPanel(selectedStudent.id, questionNo);
    const targetId = `subjective-review-panel-${selectedStudent.id}-${questionNo}`;
    requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  function ensureReviewDraft(studentId: string, questionNo: string, questionGrade: SubjectiveQuestionGradeRecord | null): ReviewDraft {
    const key = getReviewDraftKey(studentId, questionNo);
    const existing = reviewDrafts[key];
    if (existing) {
      return existing;
    }
    return {
      mode: 'confirm',
      scoreInput: String(questionGrade?.earnedScore ?? ''),
      reasonInput: '',
    };
  }

  function updateReviewDraft(
    studentId: string,
    questionNo: string,
    questionGrade: SubjectiveQuestionGradeRecord | null,
    updater: (draft: ReviewDraft) => ReviewDraft,
  ) {
    const key = getReviewDraftKey(studentId, questionNo);
    setReviewDrafts((current) => ({
      ...current,
      [key]: updater(current[key] || {
        mode: 'confirm',
        scoreInput: String(questionGrade?.earnedScore ?? ''),
        reasonInput: '',
      }),
    }));
  }

  async function handleSubmitReview(
    studentId: string,
    questionNo: string,
    questionGrade: SubjectiveQuestionGradeRecord | null,
    questionScore: number,
  ) {
    if (!task?.id || !questionGrade) return;
    const draft = ensureReviewDraft(studentId, questionNo, questionGrade);
    if (draft.mode === 'adjust' && !draft.reasonInput.trim()) {
      setRunMessage('教师改分时请填写修改原因。');
      return;
    }

    const nextScore = Number(draft.scoreInput);
    const fullScore = Number(questionScore || 0);
    if (draft.mode === 'adjust' && (!Number.isFinite(nextScore) || nextScore < 0 || nextScore > fullScore)) {
      setRunMessage(`教师改分需填写 0 到 ${fullScore} 之间的分数。`);
      return;
    }

    setIsSubmittingReview(true);
    try {
      const response = await reviewSubjectiveQuestion(task.id, {
        questionNo,
        studentId,
        action: draft.mode,
        score: draft.mode === 'adjust' ? nextScore : Number(questionGrade.earnedScore || 0),
        reason: draft.mode === 'adjust' ? draft.reasonInput.trim() : '',
        reviewer: '教师',
      });
      onTaskUpdated(response.task);
      setRunMessage(draft.mode === 'adjust' ? '教师改分已保存。' : '已确认 AI 得分。');
      const key = getReviewDraftKey(studentId, questionNo);
      setReviewDrafts((current) => ({
        ...current,
        [key]: {
          mode: 'confirm',
          scoreInput: '',
          reasonInput: '',
        },
      }));
      setExpandedReviewPanels((current) => ({
        ...current,
        [key]: false,
      }));
    } catch (error) {
      setRunMessage(`复核保存失败：${getErrorMessage(error)}`);
    } finally {
      setIsSubmittingReview(false);
    }
  }

  if (!task) {
    return <div className="empty-inline">请先选择要查看的任务。</div>;
  }

  if (!subjectiveQuestions.length) {
    return <div className="empty-inline">当前任务还没有启用的主观题。</div>;
  }

  return (
    <section className="subjective-workbench">
      <div className="subjective-preview-hero">
        <div className="subjective-preview-hero-main">
          <h4>步骤五 主观题批改</h4>
          <p>普通型主观题继续保留原文挂分，论述题改为按论题、分段和结论展示结构化点评框。</p>
        </div>
        <div className="subjective-preview-hero-stats">
          <div className="subjective-preview-stat accent">
            <strong>{task.subjectiveGrading?.gradedStudentCount ?? 0}</strong>
            <span>已批学生</span>
          </div>
          <div className="subjective-preview-stat">
            <strong>{task.subjectiveGrading?.reviewQuestionCount ?? 0}</strong>
            <span>待复核题数</span>
          </div>
          <div className="subjective-preview-stat">
            <strong>{formatDateLabel(task.subjectiveGrading?.lastRunAt || '')}</strong>
            <span>最近批改</span>
          </div>
        </div>
      </div>

      <div className="subjective-progress-panel subjective-command-panel">
        <div className="subjective-command-head">
          <div className="soft-card-title">
            <Sparkles size={16} />
            批改控制
          </div>
          <div className="subjective-command-actions">
            {SUBJECTIVE_PROFILE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`subjective-student-tab ${profile === option.value ? 'active' : ''}`}
                onClick={() => setProfile(option.value)}
                disabled={isRunning}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="subjective-command-body">
          <div className="subjective-question-picker">
            <div className="subjective-picker-head">
              <div className="subjective-picker-title">
                <strong>批改范围</strong>
                <span>先勾选题目，再决定按当前组还是全班批改。</span>
              </div>
              <div className="subjective-picker-tools">
                <button type="button" className="pill-button cream" onClick={selectAllQuestions} disabled={isRunning}>
                  全选题目
                </button>
                <button type="button" className="pill-button mint" onClick={clearQuestionSelection} disabled={isRunning}>
                  清空勾选
                </button>
              </div>
            </div>

            <div className="subjective-question-checklist">
              {subjectiveQuestions.map((question) => {
                const checked = selectedQuestionNoSet.has(question.questionNo);
                const reviewCount = (reviewQueueByQuestion.get(question.questionNo) || []).length;
                return (
                  <div key={question.id} className={`subjective-question-check-shell ${checked ? 'checked' : ''}`}>
                    <label className={`subjective-question-check ${checked ? 'checked' : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleQuestion(question.questionNo)}
                        disabled={isRunning}
                      />
                      <span className="subjective-question-check-icon" />
                      <span className="subjective-question-check-main">
                        <b>第 {question.questionNo} 题</b>
                        <small>{question.type === 'essay' ? '论述题' : '普通型主观题'}</small>
                      </span>
                      <span className="subjective-question-check-score">{question.score} 分</span>
                    </label>
                    <button
                      type="button"
                      className={`subjective-review-queue-button ${reviewCount ? 'active' : ''}`}
                      onClick={() => focusQuestionReview(question.questionNo)}
                      disabled={!reviewCount}
                      aria-label={reviewCount ? `展开当前学生第 ${question.questionNo} 题复核栏；本题全班共有 ${reviewCount} 处待复核` : `第 ${question.questionNo} 题当前没有待复核学生`}
                    >
                      {reviewCount ? `待教师复核 ${reviewCount}` : '暂无待复核'}
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="subjective-command-actions">
              <button
                type="button"
                className="pill-button peach"
                onClick={() => executeRun('group')}
                disabled={isRunning || !selectedQuestionNos.length}
              >
                {isRunning && currentRunScope === 'group' ? <LoaderCircle size={16} className="spin" /> : <PlayCircle size={16} />}
                批当前组
              </button>
              <button
                type="button"
                className="pill-button mint"
                onClick={() => executeRun('class')}
                disabled={isRunning || !selectedQuestionNos.length}
              >
                {isRunning && currentRunScope === 'class' ? <LoaderCircle size={16} className="spin" /> : <Users size={16} />}
                批全班
              </button>
              {isRunning ? (
                <button type="button" className="pill-button coral" onClick={handlePause}>
                  <PauseCircle size={16} />
                  批次结束后暂停
                </button>
              ) : null}
              {isPaused && pendingRunStudentIds.length ? (
                <button type="button" className="pill-button peach" onClick={() => executeRun(currentRunScope, true)}>
                  <PlayCircle size={16} />
                  继续批改
                </button>
              ) : null}
              <button
                type="button"
                className="pill-button cream"
                onClick={handleExport}
                disabled={isRunning || isExporting || !hasSubjectiveResult || !exportableStudentCount}
              >
                {isExporting ? <LoaderCircle size={16} className="spin" /> : <FileText size={16} />}
                导出文档
              </button>
              <button
                type="button"
                className="pill-button coral"
                onClick={handleClear}
                disabled={isRunning || isClearing || !hasSubjectiveResult}
              >
                {isClearing ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}
                清空结果
              </button>
            </div>
          </div>

          <div className={`subjective-status-card ${isRunning ? 'running' : isPaused ? 'paused' : 'soft'}`}>
            <div className="soft-card-title">
              <Highlighter size={16} />
              当前状态
            </div>
            <div className="subjective-progress-current">
              <strong>{runMessage || '等待开始批改。'}</strong>
              <span>
                {currentRunStudent
                  ? `当前学生：${currentRunStudent.studentName}${currentRunStudentGroup ? ` · ${currentRunStudentGroup.label}` : ''}`
                  : selectedQuestionNos.length
                    ? `已勾选 ${selectedQuestionNos.length} 题`
                    : '尚未勾选题目'}
              </span>
            </div>
            <div className="subjective-progress-bar-shell">
              <div className="subjective-progress-bar-fill" style={{ width: `${progressPercent}%` }} />
            </div>
            <div className="subjective-progress-meta">
              <span>{visibleRunScope === 'class' ? '当前范围：全班' : `当前范围：${currentGroup.label}`}</span>
              <span>{`已完成 ${runCompletedCount} / ${runTotalCount || 0}`}</span>
              <span>{`待复核 ${task.subjectiveGrading?.reviewQuestionCount ?? 0} 题`}</span>
            </div>
            {Object.keys(runErrors).length ? (
              <div className="subjective-run-error">
                本轮有 {Object.keys(runErrors).length} 名学生批改失败，请点击对应学生查看提示。
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="subjective-group-grid">
        {studentGroups.map((group) => {
          const reviewableCount = group.students.filter((student) => hasReviewableSubmission(student, selectedQuestionNos)).length;
          const completedCount = group.students.filter((student) => completedStudentIds.has(student.id)).length;
          return (
            <button
              key={group.id}
              type="button"
              className={`subjective-group-card ${currentGroup.id === group.id ? 'active' : ''}`}
              onClick={() => setSelectedGroupId(group.id)}
            >
              <strong>{group.label}</strong>
              <span>{`${group.students.length} 人`}</span>
              <small>{`可批改 ${reviewableCount} 人，已完成 ${completedCount} 人`}</small>
            </button>
          );
        })}
      </div>

      <div className="subjective-workbench-layout">
        <aside className="subjective-student-rail">
          <div className="subjective-rail-head">
            <div className="soft-card-title">
              <Users size={16} />
              学生列表
            </div>
            <span>{currentGroup.label}</span>
          </div>
          <div className="subjective-student-list">
            {currentGroup.students.map((student) => {
              const summary = summaryMap.get(student.id) || null;
              const isActive = student.id === selectedStudentId;
              const currentError = runErrors[student.id];
              return (
                <button
                  key={student.id}
                  type="button"
                  className={`subjective-student-item ${isActive ? 'active' : ''}`}
                  onClick={() => setSelectedStudentId(student.id)}
                >
                  <div className="subjective-student-item-top">
                    <strong>{student.studentName}</strong>
                    <span>{summary ? `${summary.earnedScore} 分` : '未批改'}</span>
                  </div>
                  <div className="subjective-student-item-meta">
                    <span>{student.status}</span>
                    <span>{`${student.subjectiveAnswers.filter((answer) => answer.hasOverride || answer.baseState !== 'missing').length} 道主观题`}</span>
                    {summary?.reviewQuestionCount ? <span>{`待复核 ${summary.reviewQuestionCount} 题`}</span> : null}
                  </div>
                  {currentError ? <div className="subjective-run-error">{currentError}</div> : null}
                </button>
              );
            })}
          </div>
        </aside>

        <div className="subjective-detail-stage">
          {selectedStudent ? (
            <>
              <section className="subjective-student-overview">
                <div>
                  <div className="soft-card-title">
                    <UserRound size={16} />
                    {selectedStudent.studentName}
                  </div>
                  <p>{selectedStudentSummary?.overallComment || '这位学生的主观题总评会在批改后显示在这里。'}</p>
                </div>
                <div className="subjective-student-overview-meta">
                  <span>{`当前分组：${currentGroup.label}`}</span>
                  <span>{`总分：${buildStudentScoreText(selectedStudentSummary, totalSubjectiveScore)}`}</span>
                  <span>{`答题卡：${selectedStudent.sources.length} 张`}</span>
                  <span>{`最近更新：${formatDateLabel(selectedStudentSummary?.updatedAt || selectedStudent.updatedAt)}`}</span>
                </div>
              </section>

              {displayedQuestions.length ? (
                displayedQuestions.map((question) => {
                  const questionGrade = (selectedStudentSummary?.questionGrades || []).find((grade) => grade.questionNo === question.questionNo) || null;
                  const answerRecord = selectedStudent.subjectiveAnswers.find((item) => item.questionNo === question.questionNo);
                  const answerText = getAnswerText(questionGrade, answerRecord);
                  const annotatedAnswer = question.type === 'essay' ? null : buildAnnotatedAnswer(answerText, questionGrade);
                  const essaySections = question.type === 'essay' ? buildEssayDisplaySections(questionGrade) : [];
                  const subquestionSections = question.type === 'essay' ? [] : buildSubquestionSections(questionGrade);
                  const reviewKey = getReviewDraftKey(selectedStudent.id, question.questionNo);
                  const reviewDraft = ensureReviewDraft(selectedStudent.id, question.questionNo, questionGrade);
                  const reviewStatus = getReviewStatusMeta(questionGrade?.reviewState);
                  const isReviewPending = Boolean(questionGrade?.requiresReview);
                  const isReviewExpanded = Boolean(expandedReviewPanels[reviewKey]);

                  return (
                    <article key={`${selectedStudent.id}-${question.questionNo}`} className="subjective-question-card">
                      <div className="subjective-question-head">
                        <div>
                          <h4>第 {question.questionNo} 题 · {question.type === 'essay' ? '论述题' : '普通型主观题'}</h4>
                          <p>{buildQuestionStatusText(question, questionGrade, selectedStudent)}</p>
                        </div>
                        <div className="subjective-question-score">
                          <strong>{questionGrade ? `${questionGrade.earnedScore} / ${question.score}` : `待批改 / ${question.score}`}</strong>
                          <span>{questionGrade?.requiresReview ? '需要人工复核' : '本题得分'}</span>
                        </div>
                      </div>

                      <div className="subjective-reference-box">
                        <div className="subjective-box-title">
                          <div className="soft-card-title">
                            <FileText size={16} />
                            题目与评分依据
                          </div>
                          <span>固定高度，超出部分可滚动</span>
                        </div>
                        <div className="subjective-reference-scroll">
                          <div className="subjective-reference-block">
                            <strong>题目</strong>
                            <p>{question.content || '暂无题目原文。'}</p>
                          </div>
                          <div className="subjective-reference-block">
                            <strong>参考答案</strong>
                            <p>{question.standardAnswer || '暂无参考答案。'}</p>
                          </div>
                          <div className="subjective-reference-block">
                            <strong>阅卷要求</strong>
                            <p>{question.gradingRule || '当前没有单题阅卷要求，将按后台默认规则执行。'}</p>
                          </div>
                        </div>
                      </div>

                      <div className="subjective-answer-box">
                        <div className="subjective-box-title">
                          <div className="soft-card-title">
                            <Highlighter size={16} />
                            {question.type === 'essay' ? '结构化点评' : '学生原文批注'}
                          </div>
                          <span>
                            {question.type === 'essay'
                              ? '每个结构单元下方显示一个点评框，不再在正文里直接挂分。'
                              : '命中得分点用绿色波浪线标出，问题句用红框说明。'}
                          </span>
                        </div>

                        <div className="subjective-answer-original">
                          {question.type === 'essay' ? (
                            essaySections.length ? (
                              <div className="subjective-essay-structure">
                                {essaySections.map((section) => (
                                  <section key={`${question.questionNo}-${section.key}`} className="subjective-essay-section">
                                    <div className="subjective-essay-source-head">
                                      <strong>{formatSectionTitle(section.label)}</strong>
                                      <span className="subjective-review-score">{formatReviewGroupScore(section.score, section.fullScore)}</span>
                                    </div>
                                    <div className="subjective-essay-source">
                                      {section.excerpt || '当前还没有定位到这部分对应的学生原文。'}
                                    </div>
                                    <div className={`subjective-essay-comment-box ${getReviewGroupTone(section.score, section.fullScore)}`}>
                                      {(section.label === '论题' ? buildThesisKeywordTags(section) : section.criteria).length ? (
                                        <div className="subjective-essay-tags">
                                          {(section.label === '论题' ? buildThesisKeywordTags(section) : section.criteria).map((criterion) => (
                                            <span
                                              key={`${section.key}-${criterion.code}-${criterion.label}`}
                                              className={`subjective-essay-tag ${criterion.tone}`}
                                              title={criterion.label}
                                            >
                                              {criterion.tagText}
                                            </span>
                                          ))}
                                        </div>
                                      ) : null}
                                      {section.label === '论题' && section.replacementThesis ? (
                                        <div className="subjective-essay-suggested">
                                          <strong>AI修正论题</strong>
                                          <div>{section.replacementThesis}</div>
                                        </div>
                                      ) : null}
                                      {section.suggestedText ? (
                                        <div className="subjective-essay-suggested">
                                          <strong>{section.suggestedTitle}</strong>
                                          <div>{section.suggestedText}</div>
                                        </div>
                                      ) : null}
                                    </div>
                                  </section>
                                ))}
                              </div>
                            ) : (
                              <div className="subjective-empty-block">本题暂时还没有生成论述题结构化点评。</div>
                            )
                          ) : annotatedAnswer?.source ? (
                            <div className="subjective-annotated-manuscript">
                              <div className="subjective-subquestion-block">
                                <div className="subjective-annotation-summary">
                                  <span className="subjective-annotation-pill match">
                                    绿色挂分 {annotatedAnswer.scoredRangeCount} 处 / {annotatedAnswer.awardedScoreTotal} 分
                                  </span>
                                  <span className="subjective-annotation-pill error">
                                    红框标错 {annotatedAnswer.errorRangeCount} 处
                                  </span>
                                  {questionGrade?.requiresReview ? (
                                    <span className="subjective-annotation-pill review">待复核</span>
                                  ) : null}
                                </div>
                                <div className="subjective-annotated-answer">
                                  {annotatedAnswer.segments.map((segment, index) => (
                                    <div key={`${selectedStudent.id}-${question.questionNo}-segment-${index}`} className="subjective-manuscript-piece">
                                      {segment.tone === 'match' ? (
                                        <span className="subjective-inline-unit subjective-inline-unit-match">
                                          <span className="subjective-inline-pass">{segment.text}</span>
                                          {typeof segment.awardedScore === 'number' ? (
                                            <span className="subjective-inline-score">+{segment.awardedScore}</span>
                                          ) : null}
                                        </span>
                                      ) : segment.tone === 'error' ? (
                                        <span className="subjective-inline-unit subjective-inline-unit-error">
                                          <span className="subjective-inline-error">{segment.text}</span>
                                          <span className="subjective-inline-error-note">（{segment.reason || '表述存在问题'}）</span>
                                        </span>
                                      ) : (
                                        <span className="subjective-inline-plain">{segment.text}</span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>

                              {subquestionSections.length ? (
                                subquestionSections.map((section) => {
                                  const sectionDetailKey = `${question.questionNo}:${section.key}`;
                                  const isExpanded = Boolean(expandedPointSections[sectionDetailKey]);
                                  return (
                                    <div
                                      key={`${question.questionNo}-${section.key}`}
                                      className={`subjective-subquestion-comment ${getReviewGroupTone(section.score, section.fullScore)}`}
                                    >
                                      <div className="subjective-subquestion-head">
                                        <strong>{formatSectionTitle(section.title)}</strong>
                                        <div className="subjective-review-score">{formatReviewGroupScore(section.score, section.fullScore)}</div>
                                      </div>
                                      <p>{buildSectionCommentText(section)}</p>
                                      {section.points.length ? (
                                        <div className="subjective-point-toggle-row">
                                          <button
                                            type="button"
                                            className="mini-icon-button subjective-point-toggle"
                                            onClick={() => toggleSectionDetails(sectionDetailKey)}
                                          >
                                            {isExpanded ? '收起要点明细' : `查看要点明细（${section.points.length}）`}
                                          </button>
                                        </div>
                                      ) : null}
                                      {section.points.length && isExpanded ? (
                                        <div className="subjective-point-list">
                                          {section.points.map((point) => (
                                            <div key={point.key} className="subjective-point-item">
                                              <div className="subjective-point-head">
                                                <strong>{point.label}</strong>
                                                <span>{formatReviewGroupScore(point.score, point.fullScore)}</span>
                                              </div>
                                              <p>{point.comment || '该要点暂无补充说明。'}</p>
                                            </div>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>
                                  );
                                })
                              ) : questionGrade ? (
                                <div className="subjective-empty-block">本题暂时还没有生成分点点评。</div>
                              ) : null}
                            </div>
                          ) : (
                            <div className="subjective-empty-block">这道题暂时还没有可展示的学生原文。</div>
                          )}
                        </div>

                        {questionGrade?.questionComment ? (
                          <div className="subjective-question-note subjective-overall-comment">
                            <div className="subjective-overall-comment-title">
                              <Sparkles size={16} />
                              <strong>{question.type === 'essay' ? '本题总评' : '本题点评'}</strong>
                            </div>
                            <span>{questionGrade.questionComment}</span>
                          </div>
                        ) : null}

                        {questionGrade ? (
                          <section
                            id={`subjective-review-panel-${selectedStudent.id}-${question.questionNo}`}
                            className={`subjective-inline-review ${isReviewPending ? 'pending' : 'resolved'}`}
                          >
                            <button
                              type="button"
                              className={`subjective-inline-review-toggle ${isReviewExpanded ? 'expanded' : ''}`}
                              onClick={() => toggleReviewPanel(selectedStudent.id, question.questionNo)}
                              aria-expanded={isReviewExpanded}
                              aria-controls={`subjective-inline-review-body-${selectedStudent.id}-${question.questionNo}`}
                            >
                              <div className="subjective-inline-review-toggle-main">
                                <span className="subjective-inline-review-arrow">
                                  <ChevronDown size={16} />
                                </span>
                                <div className="subjective-inline-review-heading">
                                  <strong>教师复核</strong>
                                  <span>
                                    {isReviewPending
                                      ? '结合上方学生原答案和批注，确认 AI 得分是否可靠。'
                                      : '这道题已经完成教师确认，可展开查看最终复核记录。'}
                                  </span>
                                </div>
                              </div>
                              <div className="subjective-inline-review-toggle-side">
                                <span className={`subjective-review-status-badge ${isReviewPending ? 'pending' : reviewStatus.tone}`}>
                                  {isReviewPending ? '需要复核' : reviewStatus.text}
                                </span>
                                <span className="subjective-inline-review-score">{`${questionGrade.earnedScore} / ${question.score}`}</span>
                              </div>
                            </button>

                            {isReviewExpanded ? (
                              <div
                                id={`subjective-inline-review-body-${selectedStudent.id}-${question.questionNo}`}
                                className="subjective-inline-review-body"
                              >
                                <div className="subjective-review-summary">
                                  <div>
                                    <strong>{selectedStudent.studentName}</strong>
                                    <span>{`AI 当前得分：${questionGrade.earnedScore} / ${question.score}`}</span>
                                  </div>
                                  <span className={`subjective-review-status-badge ${isReviewPending ? 'pending' : reviewStatus.tone}`}>
                                    {isReviewPending ? '等待教师复核' : reviewStatus.text}
                                  </span>
                                </div>

                                {isReviewPending ? (
                                  <>
                                    <div className="subjective-review-mode-row">
                                      <button
                                        type="button"
                                        className={`subjective-review-mode-button ${reviewDraft.mode === 'confirm' ? 'active confirm' : 'confirm'}`}
                                        onClick={() => updateReviewDraft(selectedStudent.id, question.questionNo, questionGrade, (draft) => ({
                                          ...draft,
                                          mode: 'confirm',
                                          scoreInput: String(questionGrade.earnedScore ?? ''),
                                        }))}
                                      >
                                        <strong>确认 AI 得分</strong>
                                        <span>保留 AI 当前分数，直接作为这道题的最终结果。</span>
                                      </button>
                                      <button
                                        type="button"
                                        className={`subjective-review-mode-button ${reviewDraft.mode === 'adjust' ? 'active adjust' : 'adjust'}`}
                                        onClick={() => updateReviewDraft(selectedStudent.id, question.questionNo, questionGrade, (draft) => ({
                                          ...draft,
                                          mode: 'adjust',
                                          scoreInput: draft.scoreInput || String(questionGrade.earnedScore ?? ''),
                                        }))}
                                      >
                                        <strong>教师改分</strong>
                                        <span>填写最终得分和修改原因，并在导出文档里留下说明。</span>
                                      </button>
                                    </div>

                                    {reviewDraft.mode === 'adjust' ? (
                                      <div className="subjective-review-form">
                                        <label className="subjective-review-field">
                                          <span>最终得分</span>
                                          <input
                                            type="number"
                                            min={0}
                                            max={question.score}
                                            step={0.5}
                                            value={reviewDraft.scoreInput}
                                            onChange={(event) => updateReviewDraft(selectedStudent.id, question.questionNo, questionGrade, (draft) => ({
                                              ...draft,
                                              scoreInput: event.target.value,
                                            }))}
                                          />
                                        </label>
                                        <label className="subjective-review-field">
                                          <span>修改原因</span>
                                          <textarea
                                            rows={5}
                                            value={reviewDraft.reasonInput}
                                            onChange={(event) => updateReviewDraft(selectedStudent.id, question.questionNo, questionGrade, (draft) => ({
                                              ...draft,
                                              reasonInput: event.target.value,
                                            }))}
                                            placeholder="请写明为什么教师需要改分，这条原因会写入导出的批改文档。"
                                          />
                                        </label>
                                        <div className="subjective-empty-block subjective-review-tip">
                                          建议写清“AI 少给了哪一点”或“AI 误判了哪一句”，这样导出记录更利于后续解释。
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="subjective-empty-block subjective-review-tip">点击下方按钮后，这道题会直接作为最终结果，不再保留在待复核列表中。</div>
                                    )}

                                    <div className="subjective-inline-review-actions">
                                      <button
                                        type="button"
                                        className="pill-button peach"
                                        onClick={() => handleSubmitReview(selectedStudent.id, question.questionNo, questionGrade, Number(question.score || 0))}
                                        disabled={isSubmittingReview}
                                      >
                                        {isSubmittingReview ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}
                                        {reviewDraft.mode === 'adjust' ? '保存教师改分并完成复核' : '确认 AI 得分并完成复核'}
                                      </button>
                                    </div>
                                  </>
                                ) : (
                                  <div className="subjective-review-form">
                                    <div className="subjective-question-note">
                                      <div className="subjective-overall-comment-title">
                                        <Sparkles size={16} />
                                        <strong>最终复核结果</strong>
                                      </div>
                                      <span>
                                        {questionGrade.reviewState === 'adjusted'
                                          ? `教师已将本题得分调整为 ${questionGrade.earnedScore} / ${question.score}。`
                                          : `教师已确认 AI 得分 ${questionGrade.earnedScore} / ${question.score} 作为最终结果。`}
                                      </span>
                                      {questionGrade.reviewNote ? <span>{`修改原因：${questionGrade.reviewNote}`}</span> : null}
                                      {questionGrade.reviewedAt ? <span>{`复核时间：${formatDateLabel(questionGrade.reviewedAt)}`}</span> : null}
                                    </div>
                                  </div>
                                )}
                              </div>
                            ) : null}
                          </section>
                        ) : null}
                      </div>
                    </article>
                  );
                })
              ) : (
                <div className="empty-inline">请先勾选要查看的主观题。</div>
              )}
            </>
          ) : (
            <div className="empty-inline">请先从左侧选择一名学生。</div>
          )}
        </div>
      </div>

      <section className="subjective-analysis-panel">
        <div className="subjective-analysis-head">
          <div>
            <div className="soft-card-title">
              <Sparkles size={16} />
              主观题学情分析
            </div>
            <p>分析面板固定放在最下方，保持学生详情批改区处于页面主视觉中心。点击按钮后，再按当前已批改结果和当前勾选题目生成统计。</p>
          </div>
          <div className="subjective-analysis-actions">
            {analysisData ? (
              <span className={`subjective-analysis-status ${analysisNeedsRefresh ? 'stale' : 'ready'}`}>
                {analysisNeedsRefresh ? '批改数据已更新，请重新分析' : '分析结果已生成'}
              </span>
            ) : (
              <span className="subjective-analysis-status">尚未生成分析</span>
            )}
            <button
              type="button"
              className="pill-button peach"
              onClick={handleAnalyze}
              disabled={!hasSubjectiveResult || isRunning || isClearing || isAnalyzing}
            >
              {isAnalyzing ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}
              {analysisData ? '重新分析' : '开始分析'}
            </button>
          </div>
        </div>

        {!hasSubjectiveResult ? (
          <div className="subjective-empty-block">当前还没有主观题批改结果，完成批改后才能生成学情分析。</div>
        ) : !analysisData ? (
          <div className="subjective-empty-block">点击“开始分析”后，这里会显示班级层面的主观题统计结果。</div>
        ) : (
          <div className="subjective-analysis-grid">
            <article className="subjective-analysis-card">
              <div className="subjective-analysis-card-head">
                <h4>主观题得分率排行</h4>
                <span>{`已纳入 ${analysisData.selectedQuestionCount} 题 / ${analysisData.gradedStudentCount} 名学生`}</span>
              </div>
              {analysisData.questionPerformance.length ? (
                <div className="subjective-analysis-table">
                  <div className="subjective-analysis-table-head subjective-analysis-performance-grid">
                    <span>题号</span>
                    <span>题型</span>
                    <span>平均分</span>
                    <span>得分率</span>
                    <span>待复核</span>
                  </div>
                  {analysisData.questionPerformance.map((row) => (
                    <div key={`performance-${row.questionNo}`} className="subjective-analysis-table-row subjective-analysis-performance-grid">
                      <strong>{`第${row.questionNo}题`}</strong>
                      <span>{row.questionType === 'essay' ? '论述题' : '普通主观题'}</span>
                      <span>{`${formatScoreValue(row.averageScore)} / ${formatScoreValue(row.fullScore)}`}</span>
                      <span>{formatPercent(row.scoreRate, 1)}</span>
                      <span>{row.reviewCount ? `${row.reviewCount} 题次` : '无'}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="subjective-empty-block">当前勾选题目里还没有可用于统计的主观题成绩。</div>
              )}
            </article>

            <article className="subjective-analysis-card">
              <div className="subjective-analysis-card-head">
                <h4>普通主观题采分点命中率</h4>
                <span>按命中率从低到高排序，优先暴露最需要补讲的采分点</span>
              </div>
              {analysisData.ordinaryPointHitGroups.length ? (
                <div className="subjective-analysis-stack">
                  {analysisData.ordinaryPointHitGroups.map((group) => (
                    <section key={`ordinary-group-${group.questionNo}`} className="subjective-analysis-subcard">
                      <div className="subjective-analysis-subhead">
                        <strong>{`第${group.questionNo}题`}</strong>
                        <span>{`已统计 ${group.gradedCount} 人`}</span>
                      </div>
                      <div className="subjective-analysis-diagnosis-list">
                        {group.points.slice(0, 12).map((point) => (
                          <article key={point.key} className={`subjective-analysis-diagnosis-item ${getHitTone(point.hitRate)}`}>
                            <div className="subjective-analysis-diagnosis-main">
                              <div className="subjective-analysis-diagnosis-title">
                                <strong>{point.pointLabel}</strong>
                                <span className="subjective-analysis-score-tag">{`${formatScoreValue(point.fullScore)}分点`}</span>
                              </div>
                              <small>{point.sectionLabel}</small>
                            </div>
                            <div className="subjective-analysis-diagnosis-bar">
                              <div
                                className={`subjective-analysis-diagnosis-fill ${getHitTone(point.hitRate)}`}
                                style={{ width: `${Math.max(6, point.hitRate * 100)}%` }}
                              />
                            </div>
                            <div className="subjective-analysis-diagnosis-meta">
                              <strong>{formatPercent(point.hitRate, 1)}</strong>
                              <span>{`${point.hitCount} / ${point.gradedCount} 人命中`}</span>
                            </div>
                          </article>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <div className="subjective-empty-block">当前勾选范围内还没有可统计的普通主观题采分点数据。</div>
              )}
            </article>

            <article className="subjective-analysis-card">
              <div className="subjective-analysis-card-head">
                <h4>论述题学生问题热力图</h4>
                <span>保留问题热度，但直接给出学生名单，便于老师点名辅导</span>
              </div>
              {analysisData.essayIssueGroups.length ? (
                <div className="subjective-analysis-stack">
                  {analysisData.essayIssueGroups.map((group) => (
                    <section key={`essay-issue-${group.questionNo}`} className="subjective-analysis-subcard">
                      <div className="subjective-analysis-subhead">
                        <strong>{`第${group.questionNo}题`}</strong>
                        <span>{`已统计 ${group.gradedCount} 人`}</span>
                      </div>
                      <div className="subjective-analysis-issue-list">
                        {group.issues.map((issue) => (
                          <article key={issue.key} className="subjective-analysis-issue-item">
                            <div className="subjective-analysis-issue-main">
                              <div className="subjective-analysis-issue-title">
                                <WandSparkles size={15} />
                                <strong>{issue.label}</strong>
                              </div>
                              <div className="subjective-analysis-issue-stats">
                                <span>{`${issue.count} 人`}</span>
                                <span>{formatPercent(issue.rate, 1)}</span>
                              </div>
                            </div>
                            <div className="subjective-analysis-issue-students">
                              {issue.students.slice(0, 6).map((student) => (
                                <button
                                  key={`${issue.key}-${student.studentId}`}
                                  type="button"
                                  className="subjective-analysis-student-chip"
                                  onClick={() => jumpToStudent(student.studentId)}
                                >
                                  {student.studentName}
                                </button>
                              ))}
                              {issue.students.length > 6 ? (
                                <span className="subjective-analysis-student-more">{`另有 ${issue.students.length - 6} 人`}</span>
                              ) : null}
                            </div>
                          </article>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <div className="subjective-empty-block">当前勾选范围内还没有可统计的论述题结构化问题数据。</div>
              )}
            </article>
          </div>
        )}
      </section>
    </section>
  );
}
