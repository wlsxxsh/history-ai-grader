import type {
  OrdinaryGradingPoint,
  OrdinaryGradingRuleTree,
  OrdinaryGradingSection,
  OrdinaryGradingSubquestion,
  QuestionDraft,
} from './types';

function createNodeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizeScore(value: number | string | undefined, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return Math.max(0, fallback);
  }
  return numeric;
}

function normalizePickCount(value: number | string | null | undefined) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.trunc(numeric);
}

export function createEmptyPoint(partial: Partial<OrdinaryGradingPoint> = {}): OrdinaryGradingPoint {
  return {
    id: partial.id || createNodeId('point'),
    label: partial.label || '',
    score: normalizeScore(partial.score, 2),
    aliases: Array.isArray(partial.aliases) ? partial.aliases.map((item) => String(item ?? '')) : [],
    notes: Array.isArray(partial.notes) ? partial.notes.map((item) => String(item ?? '')) : [],
    allowSimilar: partial.allowSimilar !== false,
  };
}

export function createEmptySubquestion(partial: Partial<OrdinaryGradingSubquestion> = {}, index = 0): OrdinaryGradingSubquestion {
  const pickEnabled = Boolean(partial.pickEnabled);
  return {
    id: partial.id || createNodeId('subquestion'),
    label: partial.label || `子问题${index + 1}`,
    score: normalizeScore(partial.score, 0),
    pickEnabled,
    pickCount: pickEnabled ? normalizePickCount(partial.pickCount) : null,
    points: Array.isArray(partial.points) && partial.points.length
      ? partial.points.map((point) => createEmptyPoint(point))
      : [createEmptyPoint()],
  };
}

export function createEmptySection(partial: Partial<OrdinaryGradingSection> = {}, index = 0): OrdinaryGradingSection {
  const sectionScore = normalizeScore(partial.score, 0);
  const pickEnabled = Boolean(partial.pickEnabled);
  return {
    id: partial.id || createNodeId('section'),
    label: partial.label || `（${index + 1}）小题`,
    score: sectionScore,
    pickEnabled,
    pickCount: pickEnabled ? normalizePickCount(partial.pickCount) : null,
    subquestions: Array.isArray(partial.subquestions) && partial.subquestions.length
      ? partial.subquestions.map((subquestion, subIndex) => createEmptySubquestion(subquestion, subIndex))
      : [createEmptySubquestion({ score: sectionScore }, 0)],
  };
}

export function createEmptyOrdinaryRuleTree(totalScore = 10): OrdinaryGradingRuleTree {
  return {
    version: 1,
    sections: [createEmptySection({ score: normalizeScore(totalScore, 10) }, 0)],
  };
}

export function ensureOrdinaryRuleTree(tree: OrdinaryGradingRuleTree | null | undefined, totalScore = 10): OrdinaryGradingRuleTree {
  if (!tree?.sections?.length) {
    return createEmptyOrdinaryRuleTree(totalScore);
  }

  return {
    version: 1,
    sections: tree.sections.map((section, index) => createEmptySection(section, index)),
  };
}

export function getOrdinaryRuleTreeTotalScore(tree: OrdinaryGradingRuleTree | null | undefined) {
  return (tree?.sections || []).reduce((sum, section) => sum + normalizeScore(section.score, 0), 0);
}

export function ensureOrdinaryQuestionShape(question: QuestionDraft): QuestionDraft {
  if (question.type !== 'subjective') {
    return {
      ...question,
      gradingRuleTree: question.gradingRuleTree ?? null,
      essayRuleTree: question.essayRuleTree ?? null,
    };
  }

  const gradingRuleTree = ensureOrdinaryRuleTree(question.gradingRuleTree, question.score || 10);
  return {
    ...question,
    gradingRuleTree,
    essayRuleTree: null,
    score: getOrdinaryRuleTreeTotalScore(gradingRuleTree) || normalizeScore(question.score, 0),
  };
}
