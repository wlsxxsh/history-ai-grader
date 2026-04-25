import { ChevronDown, ChevronRight, FolderPlus, LoaderCircle, Sparkles, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { generateEssayThesisSuggestions as requestEssayThesisSuggestions } from '../api';
import {
  buildEssayRuleSummary,
  ensureEssayRuleTree,
  getEssayRuleTreeTotalScore,
  setEssayBodyParagraphCount,
  setEssayConclusionScore,
  setEssayGlobalOffTopicCap,
} from '../essayRuleTree';
import type {
  EssayBodyParagraphRule,
  EssayConclusionRule,
  EssayCriterion,
  EssayCriterionPenaltyMeasure,
  EssayCriterionPenaltyMode,
  EssayKeywordExpression,
  EssayKeywordGroup,
  EssayKeywordGroupType,
  EssayRuleTree,
  QuestionDraft,
} from '../types';

interface EssayQuestionEditorProps {
  question: QuestionDraft;
  onChange: (patch: Partial<QuestionDraft>) => void;
}

interface ThesisAssistantState {
  loading: boolean;
  suggestions: string[];
  keywordGroups: Array<{
    label: string;
    type: EssayKeywordGroupType;
    expressions: string[];
  }>;
  error: string;
}

type ThesisKeywordSection = 'object' | 'judgment';
type KeywordSection = ThesisKeywordSection | 'scope';

function replaceAt<T>(items: T[], index: number, value: T) {
  return items.map((item, itemIndex) => (itemIndex === index ? value : item));
}

function toggleSetValue(values: Set<string>, value: string) {
  const next = new Set(values);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '生成论题建议失败，请稍后重试。';
}

function formatCompactScore(value: number) {
  return Number.isInteger(value) ? String(value) : String(value).replace(/\.0$/, '');
}

function createCriterion(partial: Partial<EssayCriterion> = {}): EssayCriterion {
  return {
    id: partial.id || `essay-criterion-${crypto.randomUUID()}`,
    code: String(partial.code ?? 'custom').trim() || 'custom',
    label: String(partial.label ?? '').trim(),
    penaltyMode: (partial.penaltyMode === 'zero' || partial.penaltyMode === 'cap_total' ? partial.penaltyMode : 'deduct'),
    penaltyValue: Number.isFinite(Number(partial.penaltyValue)) ? Math.max(0, Number(partial.penaltyValue)) : 1,
    penaltyMeasure: partial.penaltyMeasure === 'per_item' ? 'per_item' : 'once',
  };
}

function createKeywordExpression(partial: Partial<EssayKeywordExpression> = {}): EssayKeywordExpression {
  return {
    id: partial.id || `essay-keyword-expression-${crypto.randomUUID()}`,
    text: String(partial.text ?? '').trim(),
  };
}

function createKeywordGroup(partial: Partial<EssayKeywordGroup> = {}): EssayKeywordGroup {
  return {
    id: partial.id || `essay-keyword-group-${crypto.randomUUID()}`,
    label: String(partial.label ?? '').trim(),
    type: partial.type === 'object' || partial.type === 'scope' ? partial.type : 'judgment',
    required: partial.required !== false,
    enabled: partial.enabled !== false,
    expressions: Array.isArray(partial.expressions) && partial.expressions.length
      ? partial.expressions.map((item) => createKeywordExpression(item))
      : [createKeywordExpression({ text: '' })],
  };
}

function createBodyParagraph(index: number): EssayBodyParagraphRule {
  return {
    id: `essay-body-${crypto.randomUUID()}`,
    label: `第${index + 1}段`,
    score: 3,
    scopeKeywordGroups: [],
    criteria: [
      createCriterion({ code: 'focus_on_thesis', label: '是否围绕论题（跑题全扣）', penaltyMode: 'zero', penaltyValue: 0 }),
      createCriterion({ code: 'within_scope', label: '是否符合时空范围（超出本段全扣）', penaltyMode: 'zero', penaltyValue: 0 }),
      createCriterion({ code: 'has_heading', label: '是否有小标题（没有扣1分）', penaltyMode: 'deduct', penaltyValue: 1 }),
      createCriterion({ code: 'has_evidence', label: '是否有具体史实（缺少必要史实扣2分）', penaltyMode: 'deduct', penaltyValue: 2 }),
      createCriterion({ code: 'explains_evidence', label: '是否解释史实的作用、机制或因果（缺少扣1分）', penaltyMode: 'deduct', penaltyValue: 1 }),
      createCriterion({ code: 'links_back_to_thesis', label: '是否把分析回扣到论题或分论点（缺少扣1分）', penaltyMode: 'deduct', penaltyValue: 1 }),
      createCriterion({ code: 'factual_error', label: '是否有史实错误（有错误1个扣1分）', penaltyMode: 'deduct', penaltyValue: 1, penaltyMeasure: 'per_item' }),
    ],
  };
}

function buildSectionSummary(score: number, criteria: EssayCriterion[]) {
  return `${formatCompactScore(score)} 分 · ${criteria.length} 条标准`;
}

function buildBodySummary(tree: EssayRuleTree) {
  const paragraphs = tree.body.paragraphs.slice(0, tree.body.paragraphCount);
  const bodyScore = paragraphs.reduce((sum, paragraph) => sum + Number(paragraph.score || 0), 0);
  return `${paragraphs.length} 段 · ${formatCompactScore(bodyScore)} 分`;
}

function renderPenaltyModeLabel(mode: EssayCriterionPenaltyMode) {
  if (mode === 'zero') return '全扣';
  if (mode === 'cap_total') return '总分上限';
  return '扣分';
}

function renderPenaltyMeasureLabel(measure: EssayCriterionPenaltyMeasure) {
  return measure === 'per_item' ? '每项' : '一次';
}

function getKeywordSectionTitle(type: KeywordSection) {
  if (type === 'object') return '对象型关键词组';
  if (type === 'judgment') return '判断型关键词组';
  return '时空范围关键词组';
}

function getKeywordSectionDescription(type: KeywordSection) {
  if (type === 'object') return '用于判断学生论题中的对象是否正确，可手动补充，也可用 AI 提炼。';
  if (type === 'judgment') return '用于判断学生是否真正答出了原因、影响、特点、实质等历史判断。';
  return '用于判断本段论述是否落在题目要求的时间、空间或阶段范围内。';
}

function getCriterionKeywordType(criterion: EssayCriterion): ThesisKeywordSection | null {
  const code = String(criterion.code || '').trim();
  const label = String(criterion.label || '').trim();
  if (code === 'object_correct' || label.includes('对象')) return 'object';
  if (code === 'judgment_correct' || label.includes('判断')) return 'judgment';
  return null;
}

function isScopeCriterion(criterion: EssayCriterion) {
  const code = String(criterion.code || '').trim();
  const label = String(criterion.label || '').trim();
  return code === 'within_scope' || label.includes('时空') || label.includes('范围');
}

export function EssayQuestionEditor({ question, onChange }: EssayQuestionEditorProps) {
  const tree = useMemo(
    () => ensureEssayRuleTree(question.essayRuleTree, question.gradingRule, { preserveDraftRows: true }),
    [question.essayRuleTree, question.gradingRule],
  );
  const [assistantState, setAssistantState] = useState<ThesisAssistantState>({
    loading: false,
    suggestions: [],
    keywordGroups: [],
    error: '',
  });
  const [expandedKeywordCriterionIds, setExpandedKeywordCriterionIds] = useState<Set<string>>(() => new Set());

  function updateTree(nextTree: EssayRuleTree) {
    onChange({
      essayRuleTree: nextTree,
      gradingRuleTree: null,
      gradingRule: buildEssayRuleSummary(nextTree),
      score: getEssayRuleTreeTotalScore(nextTree),
    });
  }

  function updateThesis(updater: (current: EssayRuleTree['thesis']) => EssayRuleTree['thesis']) {
    updateTree({
      ...tree,
      thesis: updater(tree.thesis),
    });
  }

  function updateBodyParagraph(paragraphIndex: number, updater: (current: EssayBodyParagraphRule) => EssayBodyParagraphRule) {
    updateTree({
      ...tree,
      body: {
        ...tree.body,
        paragraphs: replaceAt(
          tree.body.paragraphs,
          paragraphIndex,
          updater(tree.body.paragraphs[paragraphIndex] || createBodyParagraph(paragraphIndex)),
        ),
      },
    });
  }

  function updateConclusion(updater: (current: EssayConclusionRule) => EssayConclusionRule) {
    updateTree({
      ...tree,
      conclusion: updater(tree.conclusion),
    });
  }

  function updateCriteria(
    section: 'thesis' | 'conclusion',
    criterionIndex: number,
    updater: (current: EssayCriterion) => EssayCriterion,
  ) {
    if (section === 'thesis') {
      updateThesis((current) => ({
        ...current,
        criteria: replaceAt(current.criteria, criterionIndex, updater(current.criteria[criterionIndex])),
      }));
      return;
    }

    updateConclusion((current) => ({
      ...current,
      criteria: replaceAt(current.criteria, criterionIndex, updater(current.criteria[criterionIndex])),
    }));
  }

  function updateParagraphCriterion(
    paragraphIndex: number,
    criterionIndex: number,
    updater: (current: EssayCriterion) => EssayCriterion,
  ) {
    updateBodyParagraph(paragraphIndex, (current) => ({
      ...current,
      criteria: replaceAt(current.criteria, criterionIndex, updater(current.criteria[criterionIndex])),
    }));
  }

  function addCriterion(section: 'thesis' | 'conclusion') {
    const nextCriterion = createCriterion({
      code: `custom_${Date.now()}`,
      label: '自定义评价标准',
      penaltyMode: 'deduct',
      penaltyValue: 1,
    });

    if (section === 'thesis') {
      updateThesis((current) => ({
        ...current,
        criteria: [...current.criteria, nextCriterion],
      }));
      return;
    }

    updateConclusion((current) => ({
      ...current,
      criteria: [...current.criteria, nextCriterion],
    }));
  }

  function addParagraphCriterion(paragraphIndex: number) {
    updateBodyParagraph(paragraphIndex, (current) => ({
      ...current,
      criteria: [
        ...current.criteria,
        createCriterion({
          code: `custom_${Date.now()}`,
          label: '自定义评价标准',
          penaltyMode: 'deduct',
          penaltyValue: 1,
        }),
      ],
    }));
  }

  function removeCriterion(section: 'thesis' | 'conclusion', criterionIndex: number) {
    if (section === 'thesis') {
      updateThesis((current) => ({
        ...current,
        criteria: current.criteria.filter((_, index) => index !== criterionIndex),
      }));
      return;
    }

    updateConclusion((current) => ({
      ...current,
      criteria: current.criteria.filter((_, index) => index !== criterionIndex),
    }));
  }

  function removeParagraphCriterion(paragraphIndex: number, criterionIndex: number) {
    updateBodyParagraph(paragraphIndex, (current) => ({
      ...current,
      criteria: current.criteria.filter((_, index) => index !== criterionIndex),
    }));
  }

  function addThesisTemplate() {
    updateThesis((current) => ({
      ...current,
      templates: [...current.templates, ''],
    }));
  }

  function removeThesisTemplate(templateIndex: number) {
    updateThesis((current) => ({
      ...current,
      templates: current.templates.filter((_, index) => index !== templateIndex),
    }));
  }

  function adoptSuggestedTemplate(template: string) {
    updateThesis((current) => ({
      ...current,
      templates: current.templates.includes(template) ? current.templates : [...current.templates, template],
    }));
    setAssistantState((current) => ({
      ...current,
      suggestions: current.suggestions.filter((item) => item !== template),
      error: '',
    }));
  }

  function updateKeywordGroup(groupIndex: number, updater: (current: EssayKeywordGroup) => EssayKeywordGroup) {
    updateThesis((current) => ({
      ...current,
      keywordGroups: replaceAt(current.keywordGroups, groupIndex, updater(current.keywordGroups[groupIndex] || createKeywordGroup())),
    }));
  }

  function addKeywordGroup(partial: Partial<EssayKeywordGroup> = {}) {
    updateThesis((current) => ({
      ...current,
      keywordGroups: [...current.keywordGroups, createKeywordGroup(partial)],
    }));
  }

  function removeKeywordGroup(groupIndex: number) {
    updateThesis((current) => ({
      ...current,
      keywordGroups: current.keywordGroups.filter((_, index) => index !== groupIndex),
    }));
  }

  function addKeywordExpression(groupIndex: number, partial: Partial<EssayKeywordExpression> = {}) {
    updateKeywordGroup(groupIndex, (current) => ({
      ...current,
      expressions: [...current.expressions, createKeywordExpression(partial)],
    }));
  }

  function removeKeywordExpression(groupIndex: number, expressionIndex: number) {
    updateKeywordGroup(groupIndex, (current) => ({
      ...current,
      expressions: current.expressions.filter((_, index) => index !== expressionIndex),
    }));
  }

  function getKeywordGroupIndicesByType(type: ThesisKeywordSection) {
    return tree.thesis.keywordGroups
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => group.type === type);
  }

  function getParagraphScopeKeywordGroupIndices(paragraphIndex: number) {
    const paragraph = tree.body.paragraphs[paragraphIndex] || createBodyParagraph(paragraphIndex);
    return paragraph.scopeKeywordGroups
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => group.type === 'scope');
  }

  function addTypedKeywordGroup(type: ThesisKeywordSection) {
    addKeywordGroup({
      type,
      required: type === 'judgment',
      enabled: true,
    });
  }

  function updateParagraphScopeKeywordGroup(
    paragraphIndex: number,
    groupIndex: number,
    updater: (current: EssayKeywordGroup) => EssayKeywordGroup,
  ) {
    updateBodyParagraph(paragraphIndex, (current) => ({
      ...current,
      scopeKeywordGroups: replaceAt(
        current.scopeKeywordGroups || [],
        groupIndex,
        updater(current.scopeKeywordGroups?.[groupIndex] || createKeywordGroup({ type: 'scope', required: false })),
      ),
    }));
  }

  function addParagraphScopeKeywordGroup(paragraphIndex: number) {
    updateBodyParagraph(paragraphIndex, (current) => ({
      ...current,
      scopeKeywordGroups: [
        ...(current.scopeKeywordGroups || []),
        createKeywordGroup({ type: 'scope', required: false, enabled: true }),
      ],
    }));
  }

  function removeParagraphScopeKeywordGroup(paragraphIndex: number, groupIndex: number) {
    updateBodyParagraph(paragraphIndex, (current) => ({
      ...current,
      scopeKeywordGroups: (current.scopeKeywordGroups || []).filter((_, index) => index !== groupIndex),
    }));
  }

  function addParagraphScopeKeywordExpression(
    paragraphIndex: number,
    groupIndex: number,
    partial: Partial<EssayKeywordExpression> = {},
  ) {
    updateParagraphScopeKeywordGroup(paragraphIndex, groupIndex, (current) => ({
      ...current,
      expressions: [...current.expressions, createKeywordExpression(partial)],
    }));
  }

  function removeParagraphScopeKeywordExpression(
    paragraphIndex: number,
    groupIndex: number,
    expressionIndex: number,
  ) {
    updateParagraphScopeKeywordGroup(paragraphIndex, groupIndex, (current) => ({
      ...current,
      expressions: current.expressions.filter((_, index) => index !== expressionIndex),
    }));
  }

  function adoptSuggestedKeywordGroup(group: { label: string; type: ThesisKeywordSection; expressions: string[] }) {
    const normalizedExpressions = group.expressions.map((item) => item.trim()).filter(Boolean);
    updateThesis((current) => {
      const exists = current.keywordGroups.some((item) => {
        const sameType = item.type === group.type;
        const sameLabel = item.label.trim() === group.label.trim();
        const existingExpressions = item.expressions.map((entry) => entry.text.trim()).filter(Boolean);
        return sameType && (sameLabel || normalizedExpressions.some((entry) => existingExpressions.includes(entry)));
      });
      if (exists) return current;

      return {
        ...current,
        keywordGroups: [
          ...current.keywordGroups,
          createKeywordGroup({
            label: group.label,
            type: group.type,
            required: group.type === 'judgment',
            enabled: true,
            expressions: normalizedExpressions.map((text) => createKeywordExpression({ text })),
          }),
        ],
      };
    });
    setAssistantState((current) => ({
      ...current,
      keywordGroups: current.keywordGroups.filter((item) => item.label !== group.label),
      error: '',
    }));
  }

  async function handleGenerateThesisSuggestions(type?: ThesisKeywordSection | 'templates') {
    if (!String(question.content || '').trim()) {
      setAssistantState({
        loading: false,
        suggestions: [],
        keywordGroups: [],
        error: '请先填写原题目，再生成论题建议。',
      });
      return;
    }

    setAssistantState((current) => ({
      ...current,
      loading: true,
      error: '',
    }));

    try {
      const result = await requestEssayThesisSuggestions({
        questionNo: question.questionNo,
        questionContent: question.content,
        standardAnswer: question.standardAnswer,
        existingTemplates: tree.thesis.templates,
        existingKeywordGroups: tree.thesis.keywordGroups.map((group) => ({
          label: group.label,
          type: group.type,
          expressions: group.expressions.map((item) => item.text).filter(Boolean),
        })),
        notes: tree.notes,
      });
      const generatedThesisKeywordGroups = result.keywordGroups.filter((group) => group.type === 'object' || group.type === 'judgment');
      const filteredKeywordGroups = typeof type === 'string' && type !== 'templates'
        ? generatedThesisKeywordGroups.filter((group) => group.type === type)
        : generatedThesisKeywordGroups;
      setAssistantState({
        loading: false,
        suggestions: result.theses,
        keywordGroups: filteredKeywordGroups,
        error: result.theses.length || filteredKeywordGroups.length ? '' : '这次没有生成新的论题建议。',
      });
    } catch (error) {
      setAssistantState({
        loading: false,
        suggestions: [],
        keywordGroups: [],
        error: getErrorMessage(error),
      });
    }
  }

  function renderKeywordGroupEditor(type: KeywordSection, paragraphIndex?: number) {
    const isParagraphScope = type === 'scope' && typeof paragraphIndex === 'number';
    const thesisType = type === 'scope' ? null : type;
    const groups = isParagraphScope
      ? getParagraphScopeKeywordGroupIndices(paragraphIndex)
      : thesisType
        ? getKeywordGroupIndicesByType(thesisType)
        : [];
    const suggestions = type === 'scope'
      ? []
      : assistantState.keywordGroups.filter((group): group is { label: string; type: ThesisKeywordSection; expressions: string[] } => group.type === type);

    return (
      <div className="essay-thesis-pane">
        <div className="ordinary-rule-aux-head">
          <div>
            <div className="essay-thesis-pane-title">{getKeywordSectionTitle(type)}</div>
            <div className="essay-thesis-pane-hint">{getKeywordSectionDescription(type)}</div>
          </div>
          <div className="ordinary-rule-aux-head-actions">
            <button
              className="pill-button cream ordinary-rule-mini-button"
              type="button"
              onClick={() => {
                if (isParagraphScope) {
                  addParagraphScopeKeywordGroup(paragraphIndex);
                  return;
                }
                if (thesisType) {
                  addTypedKeywordGroup(thesisType);
                }
              }}
            >
              <FolderPlus size={12} />
              新增关键词组
            </button>
            {type !== 'scope' ? (
              <button
                className="pill-button peach ordinary-rule-mini-button"
                type="button"
                disabled={assistantState.loading}
                onClick={() => void handleGenerateThesisSuggestions(type)}
              >
                {assistantState.loading ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={12} />}
                AI 生成
              </button>
            ) : null}
          </div>
        </div>

        {suggestions.length ? (
          <div className="ordinary-rule-suggestion-strip">
            {suggestions.map((group) => (
              <button
                key={`essay-keyword-group-suggestion-${type}-${group.label}`}
                className="ordinary-rule-suggestion-chip"
                type="button"
                onClick={() => adoptSuggestedKeywordGroup(group)}
              >
                + {group.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="essay-keyword-group-list">
          {groups.length ? groups.map(({ group, index: groupIndex }) => (
            <div key={group.id} className="essay-keyword-group-card">
              <div className="essay-keyword-group-head essay-keyword-group-head--simple">
                <label className="ordinary-rule-inline-field ordinary-rule-inline-field--grow">
                  <span>组名</span>
                  <input
                    value={group.label}
                    onChange={(event) =>
                      isParagraphScope
                        ? updateParagraphScopeKeywordGroup(paragraphIndex, groupIndex, (current) => ({
                          ...current,
                          label: event.target.value,
                        }))
                        : updateKeywordGroup(groupIndex, (current) => ({
                          ...current,
                          label: event.target.value,
                        }))}
                    placeholder={type === 'judgment' ? '如：形成原因、历史影响、时代特点' : type === 'object' ? '如：洋务运动、工业革命、近代中国' : '如：19世纪、宋元时期、近代中国'}
                  />
                </label>

                <button
                  className="question-remove-button ordinary-rule-remove"
                  type="button"
                  aria-label="删除关键词组"
                  onClick={() => {
                    if (isParagraphScope) {
                      removeParagraphScopeKeywordGroup(paragraphIndex, groupIndex);
                      return;
                    }
                    removeKeywordGroup(groupIndex);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>

              <div className="essay-keyword-expression-list">
                {group.expressions.map((expression, expressionIndex) => (
                  <div key={expression.id} className="essay-keyword-expression-row">
                    <input
                      value={expression.text}
                      onChange={(event) =>
                        isParagraphScope
                          ? updateParagraphScopeKeywordGroup(paragraphIndex, groupIndex, (current) => ({
                            ...current,
                            expressions: replaceAt(current.expressions, expressionIndex, {
                              ...current.expressions[expressionIndex],
                              text: event.target.value,
                            }),
                          }))
                          : updateKeywordGroup(groupIndex, (current) => ({
                            ...current,
                            expressions: replaceAt(current.expressions, expressionIndex, {
                              ...current.expressions[expressionIndex],
                              text: event.target.value,
                            }),
                          }))}
                      placeholder="同义/近义表达"
                    />
                    <button
                      className="question-remove-button ordinary-rule-remove"
                      type="button"
                      aria-label="删除关键词表达"
                      onClick={() => {
                        if (isParagraphScope) {
                          removeParagraphScopeKeywordExpression(paragraphIndex, groupIndex, expressionIndex);
                          return;
                        }
                        removeKeywordExpression(groupIndex, expressionIndex);
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="ordinary-rule-actions ordinary-rule-actions--compact">
                <button
                  className="pill-button cream ordinary-rule-mini-button"
                  type="button"
                  onClick={() => {
                    if (isParagraphScope) {
                      addParagraphScopeKeywordExpression(paragraphIndex, groupIndex);
                      return;
                    }
                    addKeywordExpression(groupIndex);
                  }}
                >
                  <FolderPlus size={12} />
                  新增表达
                </button>
              </div>
            </div>
          )) : (
            <div className="empty-inline ordinary-rule-empty-tip">
              {type === 'scope' ? '可手动录入时间、空间、阶段等范围限制。' : '可手动录入关键词组，也可用 AI 自动提炼。'}
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderCriteriaRows(
    criteria: EssayCriterion[],
    onCriterionChange: (criterionIndex: number, updater: (current: EssayCriterion) => EssayCriterion) => void,
    onCriterionRemove: (criterionIndex: number) => void,
    options: { showThesisKeywordGroups?: boolean; bodyParagraphIndex?: number } = {},
  ) {
    return (
      <div className="essay-criteria-list">
        {criteria.map((criterion, criterionIndex) => {
          const keywordType: KeywordSection | null = options.showThesisKeywordGroups
            ? getCriterionKeywordType(criterion)
            : (typeof options.bodyParagraphIndex === 'number' && isScopeCriterion(criterion) ? 'scope' : null);
          const isKeywordExpanded = keywordType ? expandedKeywordCriterionIds.has(criterion.id) : false;
          const keywordGroupCount = keywordType === 'scope' && typeof options.bodyParagraphIndex === 'number'
            ? getParagraphScopeKeywordGroupIndices(options.bodyParagraphIndex).length
            : (keywordType && keywordType !== 'scope' ? getKeywordGroupIndicesByType(keywordType).length : 0);

          return (
            <div key={criterion.id} className="essay-criterion-card">
              <div className={`essay-criterion-row ${keywordType ? 'essay-criterion-row--with-keywords' : ''}`}>
                <label className="ordinary-rule-inline-field ordinary-rule-inline-field--grow">
                  <span>二级标准</span>
                  <input
                    value={criterion.label}
                    onChange={(event) =>
                      onCriterionChange(criterionIndex, (current) => ({
                        ...current,
                        label: event.target.value,
                      }))}
                    placeholder="评价标准"
                  />
                </label>

                <label className="ordinary-rule-inline-field essay-criterion-mode-field">
                  <span>处罚方式</span>
                  <select
                    value={criterion.penaltyMode}
                    onChange={(event) =>
                      onCriterionChange(criterionIndex, (current) => ({
                        ...current,
                        penaltyMode: event.target.value as EssayCriterionPenaltyMode,
                        penaltyMeasure: event.target.value === 'deduct' ? current.penaltyMeasure : 'once',
                      }))}
                  >
                    <option value="deduct">{renderPenaltyModeLabel('deduct')}</option>
                    <option value="zero">{renderPenaltyModeLabel('zero')}</option>
                    <option value="cap_total">{renderPenaltyModeLabel('cap_total')}</option>
                  </select>
                </label>

                <label className="ordinary-rule-inline-field ordinary-rule-inline-field--score">
                  <span>{criterion.penaltyMode === 'cap_total' ? '上限分' : '分值'}</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    disabled={criterion.penaltyMode === 'zero'}
                    value={criterion.penaltyMode === 'zero' ? '' : criterion.penaltyValue}
                    placeholder={criterion.penaltyMode === 'zero' ? '全扣' : '1'}
                    onChange={(event) =>
                      onCriterionChange(criterionIndex, (current) => ({
                        ...current,
                        penaltyValue: Number(event.target.value || 0),
                      }))}
                  />
                </label>

                <label className="ordinary-rule-inline-field essay-criterion-measure-field">
                  <span>频次</span>
                  <select
                    value={criterion.penaltyMode === 'deduct' ? criterion.penaltyMeasure : 'once'}
                    disabled={criterion.penaltyMode !== 'deduct'}
                    onChange={(event) =>
                      onCriterionChange(criterionIndex, (current) => ({
                        ...current,
                        penaltyMeasure: event.target.value as EssayCriterionPenaltyMeasure,
                      }))}
                  >
                    <option value="once">{renderPenaltyMeasureLabel('once')}</option>
                    <option value="per_item">{renderPenaltyMeasureLabel('per_item')}</option>
                  </select>
                </label>

                <div className="essay-criterion-preview">
                  {renderPenaltyModeLabel(criterion.penaltyMode)}
                  {criterion.penaltyMode === 'deduct' && criterion.penaltyValue > 0 ? ` ${criterion.penaltyValue}分` : ''}
                  {criterion.penaltyMode === 'cap_total' && criterion.penaltyValue > 0 ? ` ${criterion.penaltyValue}分` : ''}
                  {criterion.penaltyMode === 'deduct' ? ` · ${renderPenaltyMeasureLabel(criterion.penaltyMeasure)}` : ''}
                </div>

                {keywordType ? (
                  <button
                    className="ordinary-rule-fold-button essay-criterion-keyword-toggle"
                    type="button"
                    onClick={() => setExpandedKeywordCriterionIds((current) => toggleSetValue(current, criterion.id))}
                    aria-label={isKeywordExpanded ? '收起关键词组' : '展开关键词组'}
                    title={isKeywordExpanded ? '收起关键词组' : '展开关键词组'}
                  >
                    {isKeywordExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    <span>关键词组 {keywordGroupCount}</span>
                  </button>
                ) : null}

                <button
                  className="question-remove-button ordinary-rule-remove"
                  type="button"
                  aria-label="删除评价标准"
                  onClick={() => onCriterionRemove(criterionIndex)}
                >
                  <Trash2 size={12} />
                </button>
              </div>

              {keywordType && isKeywordExpanded ? (
                <div className="essay-criterion-keyword-panel">
                  {renderKeywordGroupEditor(keywordType, options.bodyParagraphIndex)}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="essay-question-editor">
      <div className="ordinary-question-top">
        <label className="subjective-card-field ordinary-top-field">
          <span>原题目</span>
          <textarea
            rows={6}
            value={question.content}
            onChange={(event) => onChange({ content: event.target.value })}
            placeholder="左侧填写题目原文"
          />
        </label>
        <label className="subjective-card-field ordinary-top-field">
          <span>参考答案</span>
          <textarea
            rows={6}
            value={question.standardAnswer}
            onChange={(event) => onChange({ standardAnswer: event.target.value })}
            placeholder="右侧填写参考答案原文"
          />
        </label>
      </div>

      <div className="ordinary-rule-builder essay-rule-builder">
        <div className="ordinary-rule-builder-head ordinary-rule-builder-head--compact">
          <div>
            <h5>论述题分级阅卷要求</h5>
            <p>这里的结构化规则会直接进入论述题批阅，步骤五展示层保持原样不动。</p>
          </div>
          <div className="ordinary-rule-summary-chip">{formatCompactScore(getEssayRuleTreeTotalScore(tree))} 分</div>
        </div>

        <div className="essay-rule-global-row">
          <label className="ordinary-rule-inline-field ordinary-rule-inline-field--score">
            <span>跑题总分上限</span>
            <input
              type="number"
              min="0"
              step="1"
              value={tree.globalOffTopicCap}
              onChange={(event) => updateTree(setEssayGlobalOffTopicCap(tree, Number(event.target.value || 0)))}
            />
          </label>

          <label className="ordinary-rule-inline-field ordinary-rule-inline-field--score">
            <span>论述段数</span>
            <select
              value={tree.body.paragraphCount}
              onChange={(event) => updateTree(setEssayBodyParagraphCount(tree, Number(event.target.value || 3)))}
            >
              <option value={2}>2 段</option>
              <option value={3}>3 段</option>
            </select>
          </label>

          <div className="ordinary-rule-summary-chip ordinary-rule-summary-chip--light">
            论述过程：{buildBodySummary(tree)}
          </div>
        </div>

        <label className="subjective-card-field essay-notes-field">
          <span>补充阅卷说明</span>
          <textarea
            rows={4}
            value={tree.notes}
            onChange={(event) =>
              updateTree({
                ...tree,
                notes: event.target.value,
              })}
            placeholder="这里填写老师的补充要求，会和结构化规则一起进入论述题批阅。"
          />
        </label>

        <section className="essay-rule-section-card">
          <div className="essay-rule-section-head">
            <div>
              <strong>论题</strong>
              <span>{buildSectionSummary(tree.thesis.score, tree.thesis.criteria)}</span>
            </div>
            <label className="ordinary-rule-inline-field ordinary-rule-inline-field--score">
              <span>分值</span>
              <select
                value={tree.thesis.score}
                onChange={(event) =>
                  updateThesis((current) => ({
                    ...current,
                    score: Number(event.target.value || 0),
                  }))}
              >
                <option value={2}>2 分</option>
                <option value={3}>3 分</option>
              </select>
            </label>
          </div>

          {renderCriteriaRows(
            tree.thesis.criteria,
            updateCriteria.bind(null, 'thesis'),
            removeCriterion.bind(null, 'thesis'),
            { showThesisKeywordGroups: true },
          )}

          <div className="essay-thesis-compact-card">
            <div className="essay-thesis-pane">
              <div className="ordinary-rule-aux-head">
                <div>
                  <div className="essay-thesis-pane-title">参考论题</div>
                  <div className="essay-thesis-pane-hint">优先参考参考答案中的论题，也可以继续用 AI 生成补充。</div>
                </div>
                <div className="ordinary-rule-aux-head-actions">
                  <button className="pill-button cream ordinary-rule-mini-button" type="button" onClick={addThesisTemplate}>
                    <FolderPlus size={12} />
                    新增参考论题
                  </button>
                  <button
                    className="pill-button peach ordinary-rule-mini-button"
                    type="button"
                    disabled={assistantState.loading}
                    onClick={() => void handleGenerateThesisSuggestions('templates')}
                  >
                    {assistantState.loading ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={12} />}
                    AI 补充
                  </button>
                </div>
              </div>

              {assistantState.suggestions.length ? (
                <div className="ordinary-rule-suggestion-strip">
                  {assistantState.suggestions.map((suggestion) => (
                    <button
                      key={`essay-thesis-suggestion-${suggestion}`}
                      className="ordinary-rule-suggestion-chip"
                      type="button"
                      onClick={() => adoptSuggestedTemplate(suggestion)}
                    >
                      + {suggestion}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="essay-template-list">
                {tree.thesis.templates.length ? tree.thesis.templates.map((template, templateIndex) => (
                  <div key={`essay-template-${templateIndex}`} className="ordinary-rule-aux-row essay-template-row">
                    <input
                      value={template}
                      onChange={(event) =>
                        updateThesis((current) => ({
                          ...current,
                          templates: replaceAt(current.templates, templateIndex, event.target.value),
                        }))}
                      placeholder="参考论题，仅供教师参考"
                    />
                    <button
                      className="question-remove-button ordinary-rule-remove"
                      type="button"
                      aria-label="删除参考论题"
                      onClick={() => removeThesisTemplate(templateIndex)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )) : (
                  <div className="empty-inline ordinary-rule-empty-tip">可手动录入，也可用 AI 继续补充候选论题。</div>
                )}
              </div>
            </div>

            {assistantState.error ? <div className="ordinary-rule-inline-message">{assistantState.error}</div> : null}
          </div>

          <div className="ordinary-rule-actions ordinary-rule-actions--compact">
            <button className="pill-button cream" type="button" onClick={() => addCriterion('thesis')}>
              <FolderPlus size={14} />
              新增论题标准
            </button>
          </div>
        </section>

        <section className="essay-rule-section-card">
          <div className="essay-rule-section-head">
            <div>
              <strong>论述过程</strong>
              <span>{buildBodySummary(tree)}</span>
            </div>
          </div>

          <div className="essay-body-stack">
            {tree.body.paragraphs.slice(0, tree.body.paragraphCount).map((paragraph, paragraphIndex) => (
              <article key={paragraph.id} className="essay-body-card">
                <div className="essay-rule-section-head essay-rule-section-head--compact">
                  <label className="ordinary-rule-inline-field ordinary-rule-inline-field--grow">
                    <span>一级部分</span>
                    <input
                      value={paragraph.label}
                      onChange={(event) =>
                        updateBodyParagraph(paragraphIndex, (current) => ({
                          ...current,
                          label: event.target.value,
                        }))}
                      placeholder={`第${paragraphIndex + 1}段`}
                    />
                  </label>

                  <div className="ordinary-rule-summary-chip ordinary-rule-summary-chip--light">
                    {buildSectionSummary(paragraph.score, paragraph.criteria)}
                  </div>

                  <label className="ordinary-rule-inline-field ordinary-rule-inline-field--score">
                    <span>分值</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={paragraph.score}
                      onChange={(event) =>
                        updateBodyParagraph(paragraphIndex, (current) => ({
                          ...current,
                          score: Number(event.target.value || 0),
                        }))}
                    />
                  </label>
                </div>

                {renderCriteriaRows(
                  paragraph.criteria,
                  updateParagraphCriterion.bind(null, paragraphIndex),
                  removeParagraphCriterion.bind(null, paragraphIndex),
                  { bodyParagraphIndex: paragraphIndex },
                )}

                <div className="ordinary-rule-actions ordinary-rule-actions--compact">
                  <button className="pill-button cream" type="button" onClick={() => addParagraphCriterion(paragraphIndex)}>
                    <FolderPlus size={14} />
                    新增本段标准
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="essay-rule-section-card">
          <div className="essay-rule-section-head">
            <div>
              <strong>结论</strong>
              <span>{buildSectionSummary(tree.conclusion.score, tree.conclusion.criteria)}</span>
            </div>
            <label className="ordinary-rule-inline-field ordinary-rule-inline-field--score">
              <span>分值</span>
              <select
                value={tree.conclusion.score}
                onChange={(event) => updateTree(setEssayConclusionScore(tree, Number(event.target.value || 1)))}
              >
                <option value={1}>1 分</option>
                <option value={2}>2 分</option>
              </select>
            </label>
          </div>

          {renderCriteriaRows(
            tree.conclusion.criteria,
            updateCriteria.bind(null, 'conclusion'),
            removeCriterion.bind(null, 'conclusion'),
          )}

          <div className="ordinary-rule-actions ordinary-rule-actions--compact">
            <button className="pill-button cream" type="button" onClick={() => addCriterion('conclusion')}>
              <FolderPlus size={14} />
              新增结论标准
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
