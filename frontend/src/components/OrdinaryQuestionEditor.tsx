import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FolderPlus, LoaderCircle, Sparkles, Trash2 } from 'lucide-react';
import { generatePointAliasSuggestions as requestPointAliasSuggestions } from '../api';
import type { OrdinaryGradingRuleTree, QuestionDraft } from '../types';
import {
  createEmptyPoint,
  createEmptySection,
  createEmptySubquestion,
  ensureOrdinaryRuleTree,
  getOrdinaryRuleTreeTotalScore,
} from '../gradingRuleTree';

interface OrdinaryQuestionEditorProps {
  question: QuestionDraft;
  onChange: (patch: Partial<QuestionDraft>) => void;
}

interface PointAliasAssistantState {
  loading: boolean;
  suggestions: string[];
  error: string;
}

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
  return error instanceof Error ? error.message : '生成候选别名失败，请稍后重试。';
}

function formatCompactScore(value: number) {
  return Number.isInteger(value) ? String(value) : String(value).replace(/\.0$/, '');
}

function countSectionPoints(section: OrdinaryGradingRuleTree['sections'][number]) {
  return section.subquestions.reduce((sum, subquestion) => sum + subquestion.points.length, 0);
}

function buildSectionSummary(section: OrdinaryGradingRuleTree['sections'][number]) {
  const parts = [
    `${section.subquestions.length} 个子问题`,
    `${countSectionPoints(section)} 个采分点`,
    `${formatCompactScore(section.score)} 分`,
  ];
  if (section.pickEnabled && section.pickCount) {
    parts.push(`任答 ${section.pickCount} 个子问题`);
  }
  return parts.join(' · ');
}

function buildSubquestionSummary(subquestion: OrdinaryGradingRuleTree['sections'][number]['subquestions'][number]) {
  const parts = [`${subquestion.points.length} 个采分点`, `${formatCompactScore(subquestion.score)} 分`];
  if (subquestion.pickEnabled && subquestion.pickCount) {
    parts.push(`任答 ${subquestion.pickCount} 点`);
  }
  return parts.join(' · ');
}

function buildPointSummary(point: OrdinaryGradingRuleTree['sections'][number]['subquestions'][number]['points'][number]) {
  const parts = [`${formatCompactScore(point.score)} 分`];
  if (point.allowSimilar) parts.push('可近义');
  if (point.aliases.length) parts.push(`别名 ${point.aliases.length}`);
  if (point.notes.length) parts.push(`说明 ${point.notes.length}`);
  return parts.join(' · ');
}

export function OrdinaryQuestionEditor({ question, onChange }: OrdinaryQuestionEditorProps) {
  const tree = ensureOrdinaryRuleTree(question.gradingRuleTree, question.score || 10);
  const [activeSectionId, setActiveSectionId] = useState(tree.sections[0]?.id || '');
  const [expandedSubquestionIds, setExpandedSubquestionIds] = useState<Set<string>>(() => new Set());
  const [expandedPointIds, setExpandedPointIds] = useState<Set<string>>(() => new Set());
  const [aliasAssistantState, setAliasAssistantState] = useState<Record<string, PointAliasAssistantState>>({});

  useEffect(() => {
    if (!tree.sections.some((section) => section.id === activeSectionId)) {
      setActiveSectionId(tree.sections[0]?.id || '');
    }
  }, [activeSectionId, tree.sections]);

  const activeSectionIndex = useMemo(() => {
    const foundIndex = tree.sections.findIndex((section) => section.id === activeSectionId);
    return foundIndex >= 0 ? foundIndex : 0;
  }, [activeSectionId, tree.sections]);
  const activeSection = tree.sections[activeSectionIndex];

  function updateTree(nextTree: OrdinaryGradingRuleTree) {
    onChange({
      gradingRuleTree: nextTree,
      score: getOrdinaryRuleTreeTotalScore(nextTree),
    });
  }

  function updateSection(sectionIndex: number, updater: (section: OrdinaryGradingRuleTree['sections'][number]) => OrdinaryGradingRuleTree['sections'][number]) {
    const nextSections = replaceAt(tree.sections, sectionIndex, updater(tree.sections[sectionIndex]));
    updateTree({ ...tree, sections: nextSections });
  }

  function addSection() {
    const nextSection = createEmptySection({}, tree.sections.length);
    updateTree({ ...tree, sections: [...tree.sections, nextSection] });
    setActiveSectionId(nextSection.id);
  }

  function removeSection(sectionIndex: number) {
    const nextSections = tree.sections.filter((_, index) => index !== sectionIndex);
    const normalizedSections = nextSections.length ? nextSections : [createEmptySection({}, 0)];
    updateTree({ ...tree, sections: normalizedSections });
    setActiveSectionId(normalizedSections[0]?.id || '');
  }

  function updateSubquestion(
    sectionIndex: number,
    subquestionIndex: number,
    updater: (
      subquestion: OrdinaryGradingRuleTree['sections'][number]['subquestions'][number],
    ) => OrdinaryGradingRuleTree['sections'][number]['subquestions'][number],
  ) {
    updateSection(sectionIndex, (section) => ({
      ...section,
      subquestions: replaceAt(section.subquestions, subquestionIndex, updater(section.subquestions[subquestionIndex])),
    }));
  }

  function addSubquestion(sectionIndex: number) {
    const nextSubquestion = createEmptySubquestion({}, tree.sections[sectionIndex].subquestions.length);
    updateSection(sectionIndex, (section) => ({
      ...section,
      subquestions: [...section.subquestions, nextSubquestion],
    }));
    setExpandedSubquestionIds((current) => new Set([...current, nextSubquestion.id]));
  }

  function removeSubquestion(sectionIndex: number, subquestionIndex: number) {
    const targetId = tree.sections[sectionIndex].subquestions[subquestionIndex]?.id;
    updateSection(sectionIndex, (section) => {
      const nextSubquestions = section.subquestions.filter((_, index) => index !== subquestionIndex);
      return {
        ...section,
        subquestions: nextSubquestions.length ? nextSubquestions : [createEmptySubquestion({}, 0)],
      };
    });
    if (targetId) {
      setExpandedSubquestionIds((current) => {
        const next = new Set(current);
        next.delete(targetId);
        return next;
      });
    }
  }

  function updatePoint(
    sectionIndex: number,
    subquestionIndex: number,
    pointIndex: number,
    updater: (
      point: OrdinaryGradingRuleTree['sections'][number]['subquestions'][number]['points'][number],
    ) => OrdinaryGradingRuleTree['sections'][number]['subquestions'][number]['points'][number],
  ) {
    updateSubquestion(sectionIndex, subquestionIndex, (subquestion) => ({
      ...subquestion,
      points: replaceAt(subquestion.points, pointIndex, updater(subquestion.points[pointIndex])),
    }));
  }

  function addPoint(sectionIndex: number, subquestionIndex: number) {
    const nextPoint = createEmptyPoint();
    const subquestionId = tree.sections[sectionIndex].subquestions[subquestionIndex]?.id;
    updateSubquestion(sectionIndex, subquestionIndex, (subquestion) => ({
      ...subquestion,
      points: [...subquestion.points, nextPoint],
    }));
    if (subquestionId) {
      setExpandedSubquestionIds((current) => new Set([...current, subquestionId]));
    }
    setExpandedPointIds((current) => new Set([...current, nextPoint.id]));
  }

  function removePoint(sectionIndex: number, subquestionIndex: number, pointIndex: number) {
    const targetId = tree.sections[sectionIndex].subquestions[subquestionIndex]?.points[pointIndex]?.id;
    updateSubquestion(sectionIndex, subquestionIndex, (subquestion) => {
      const nextPoints = subquestion.points.filter((_, index) => index !== pointIndex);
      return {
        ...subquestion,
        points: nextPoints.length ? nextPoints : [createEmptyPoint()],
      };
    });
    if (targetId) {
      setExpandedPointIds((current) => {
        const next = new Set(current);
        next.delete(targetId);
        return next;
      });
    }
  }

  function updateStringList(
    sectionIndex: number,
    subquestionIndex: number,
    pointIndex: number,
    key: 'aliases' | 'notes',
    updater: (values: string[]) => string[],
  ) {
    const pointId = tree.sections[sectionIndex].subquestions[subquestionIndex]?.points[pointIndex]?.id;
    updatePoint(sectionIndex, subquestionIndex, pointIndex, (point) => ({
      ...point,
      [key]: updater(point[key]),
    }));
    if (pointId) {
      setExpandedPointIds((current) => new Set([...current, pointId]));
    }
  }

  function patchAliasAssistantState(pointId: string, patch: Partial<PointAliasAssistantState>) {
    setAliasAssistantState((current) => {
      const previous = current[pointId] || {
        loading: false,
        suggestions: [],
        error: '',
      };
      return {
        ...current,
        [pointId]: {
          ...previous,
          ...patch,
        },
      };
    });
  }

  async function handleGenerateAliasSuggestions(sectionIndex: number, subquestionIndex: number, pointIndex: number) {
    const point = tree.sections[sectionIndex]?.subquestions[subquestionIndex]?.points[pointIndex];
    const section = tree.sections[sectionIndex];
    const subquestion = section?.subquestions[subquestionIndex];
    if (!point || !section || !subquestion) {
      return;
    }

    if (!String(point.label || '').trim()) {
      patchAliasAssistantState(point.id, {
        loading: false,
        suggestions: [],
        error: '请先填写三级采分点名称。',
      });
      return;
    }

    patchAliasAssistantState(point.id, { loading: true, error: '' });

    try {
      const result = await requestPointAliasSuggestions({
        questionNo: question.questionNo,
        questionContent: question.content,
        standardAnswer: question.standardAnswer,
        sectionLabel: section.label,
        subquestionLabel: subquestion.label,
        pointLabel: point.label,
        existingAliases: point.aliases,
        notes: point.notes,
      });

      patchAliasAssistantState(point.id, {
        loading: false,
        suggestions: result.aliases,
        error: result.aliases.length ? '' : '这次没有生成新的候选别名。',
      });
    } catch (error) {
      patchAliasAssistantState(point.id, {
        loading: false,
        suggestions: [],
        error: getErrorMessage(error),
      });
    }
  }

  function adoptGeneratedAlias(sectionIndex: number, subquestionIndex: number, pointIndex: number, alias: string) {
    const pointId = tree.sections[sectionIndex]?.subquestions[subquestionIndex]?.points[pointIndex]?.id;
    updateStringList(sectionIndex, subquestionIndex, pointIndex, 'aliases', (values) =>
      values.includes(alias) ? values : [...values, alias],
    );
    if (!pointId) {
      return;
    }
    setAliasAssistantState((current) => ({
      ...current,
      [pointId]: {
        loading: false,
        suggestions: (current[pointId]?.suggestions || []).filter((item) => item !== alias),
        error: '',
      },
    }));
  }

  return (
    <div className="ordinary-question-editor">
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

      <div className="ordinary-rule-builder">
        <div className="ordinary-rule-builder-head ordinary-rule-builder-head--compact">
          <div>
            <h5>分级阅卷要求</h5>
            <p>默认展示摘要，需要时再展开细节。普通题总分由下方一级小题自动汇总。</p>
          </div>
          <button className="pill-button cream" type="button" onClick={addSection}>
            <FolderPlus size={14} />
            新增小题
          </button>
        </div>

        <div className="ordinary-rule-section-tabs">
          {tree.sections.map((section) => (
            <button
              key={section.id}
              className={`ordinary-rule-section-tab ${section.id === activeSection?.id ? 'active' : ''}`}
              type="button"
              onClick={() => setActiveSectionId(section.id)}
            >
              <strong>{section.label}</strong>
              <span>{buildSectionSummary(section)}</span>
            </button>
          ))}
        </div>

        {activeSection ? (
          <section className="ordinary-rule-section-card ordinary-rule-section-card--focused">
            <div className="ordinary-rule-section-head ordinary-rule-section-head--compact">
              <label className="ordinary-rule-inline-field ordinary-rule-inline-field--grow">
                <span>一级小题名称</span>
                <input
                  value={activeSection.label}
                  onChange={(event) => updateSection(activeSectionIndex, (current) => ({ ...current, label: event.target.value }))}
                  placeholder={`（${activeSectionIndex + 1}）小题`}
                />
              </label>
              <label className="ordinary-rule-inline-field ordinary-rule-inline-field--score">
                <span>一级分值</span>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={activeSection.score}
                  onChange={(event) =>
                    updateSection(activeSectionIndex, (current) => ({
                      ...current,
                      score: Number(event.target.value || 0),
                    }))}
                />
              </label>
              <label className="ordinary-rule-check-field ordinary-rule-check-field--compact">
                <input
                  type="checkbox"
                  checked={activeSection.pickEnabled}
                  onChange={(event) =>
                    updateSection(activeSectionIndex, (current) => ({
                      ...current,
                      pickEnabled: event.target.checked,
                      pickCount: event.target.checked ? (current.pickCount || 1) : null,
                    }))}
                />
                <span>任答几点</span>
              </label>
              <input
                className="ordinary-rule-pick-count"
                type="number"
                min="1"
                step="1"
                value={activeSection.pickCount ?? ''}
                disabled={!activeSection.pickEnabled}
                onChange={(event) =>
                  updateSection(activeSectionIndex, (current) => ({
                    ...current,
                    pickCount: current.pickEnabled ? Number(event.target.value || 0) || null : null,
                  }))}
                placeholder="2"
              />
              <button
                className="question-remove-button ordinary-rule-remove"
                type="button"
                title="删除这个小题"
                aria-label={`删除第 ${activeSectionIndex + 1} 个小题`}
                onClick={() => removeSection(activeSectionIndex)}
              >
                <Trash2 size={14} />
              </button>
            </div>

            <div className="ordinary-rule-subquestions">
              {activeSection.subquestions.map((subquestion, subquestionIndex) => {
                const subquestionExpanded = expandedSubquestionIds.has(subquestion.id);

                return (
                  <article key={subquestion.id} className="ordinary-rule-subquestion-card ordinary-rule-subquestion-card--compact">
                    <div className="ordinary-rule-subquestion-head ordinary-rule-subquestion-head--compact">
                      <button
                        className="ordinary-rule-fold-button"
                        type="button"
                        onClick={() => setExpandedSubquestionIds((current) => toggleSetValue(current, subquestion.id))}
                        aria-label={subquestionExpanded ? '收起子问题' : '展开子问题'}
                      >
                        {subquestionExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>

                      <label className="ordinary-rule-inline-field ordinary-rule-inline-field--grow">
                        <span>二级子问题</span>
                        <input
                          value={subquestion.label}
                          onChange={(event) =>
                            updateSubquestion(activeSectionIndex, subquestionIndex, (current) => ({
                              ...current,
                              label: event.target.value,
                            }))}
                          placeholder={`子问题${subquestionIndex + 1}`}
                        />
                      </label>

                      <div className="ordinary-rule-summary-chip">{buildSubquestionSummary(subquestion)}</div>

                      <label className="ordinary-rule-inline-field ordinary-rule-inline-field--score">
                        <span>分值</span>
                        <input
                          type="number"
                          min="0"
                          step="0.5"
                          value={subquestion.score}
                          onChange={(event) =>
                            updateSubquestion(activeSectionIndex, subquestionIndex, (current) => ({
                              ...current,
                              score: Number(event.target.value || 0),
                            }))}
                        />
                      </label>

                      <label className="ordinary-rule-check-field ordinary-rule-check-field--compact">
                        <input
                          type="checkbox"
                          checked={subquestion.pickEnabled}
                          onChange={(event) =>
                            updateSubquestion(activeSectionIndex, subquestionIndex, (current) => ({
                              ...current,
                              pickEnabled: event.target.checked,
                              pickCount: event.target.checked ? (current.pickCount || 1) : null,
                            }))}
                        />
                        <span>任答几点</span>
                      </label>

                      <input
                        className="ordinary-rule-pick-count"
                        type="number"
                        min="1"
                        step="1"
                        value={subquestion.pickCount ?? ''}
                        disabled={!subquestion.pickEnabled}
                        onChange={(event) =>
                          updateSubquestion(activeSectionIndex, subquestionIndex, (current) => ({
                            ...current,
                            pickCount: current.pickEnabled ? Number(event.target.value || 0) || null : null,
                          }))}
                        placeholder="2"
                      />

                      <button
                        className="question-remove-button ordinary-rule-remove"
                        type="button"
                        title="删除这个子问题"
                        aria-label={`删除第 ${activeSectionIndex + 1} 小题的第 ${subquestionIndex + 1} 个子问题`}
                        onClick={() => removeSubquestion(activeSectionIndex, subquestionIndex)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    {subquestionExpanded ? (
                      <div className="ordinary-rule-subquestion-body">
                        <div className="ordinary-rule-points ordinary-rule-points--compact">
                          {subquestion.points.map((point, pointIndex) => {
                            const pointExpanded = expandedPointIds.has(point.id);
                            const aliasAssistant = aliasAssistantState[point.id] || {
                              loading: false,
                              suggestions: [],
                              error: '',
                            };

                            return (
                              <div key={point.id} className="ordinary-rule-point-card ordinary-rule-point-card--compact">
                                <div className="ordinary-rule-point-row">
                                  <button
                                    className="ordinary-rule-fold-button ordinary-rule-fold-button--small"
                                    type="button"
                                    onClick={() => setExpandedPointIds((current) => toggleSetValue(current, point.id))}
                                    aria-label={pointExpanded ? '收起采分点详情' : '展开采分点详情'}
                                  >
                                    {pointExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                  </button>

                                  <label className="ordinary-rule-inline-field ordinary-rule-inline-field--grow">
                                    <span>三级采分点</span>
                                    <input
                                      value={point.label}
                                      onChange={(event) =>
                                        updatePoint(activeSectionIndex, subquestionIndex, pointIndex, (current) => ({
                                          ...current,
                                          label: event.target.value,
                                        }))}
                                      placeholder={`采分点${pointIndex + 1}`}
                                    />
                                  </label>

                                  <div className="ordinary-rule-summary-chip ordinary-rule-summary-chip--light">
                                    {buildPointSummary(point)}
                                  </div>

                                  <label className="ordinary-rule-inline-field ordinary-rule-inline-field--score">
                                    <span>分值</span>
                                    <input
                                      type="number"
                                      min="0"
                                      step="0.5"
                                      value={point.score}
                                      onChange={(event) =>
                                        updatePoint(activeSectionIndex, subquestionIndex, pointIndex, (current) => ({
                                          ...current,
                                          score: Number(event.target.value || 0),
                                        }))}
                                    />
                                  </label>

                                  <label className="ordinary-rule-check-field ordinary-rule-check-field--compact">
                                    <input
                                      type="checkbox"
                                      checked={point.allowSimilar}
                                      onChange={(event) =>
                                        updatePoint(activeSectionIndex, subquestionIndex, pointIndex, (current) => ({
                                          ...current,
                                          allowSimilar: event.target.checked,
                                        }))}
                                    />
                                    <span>允许近义表达</span>
                                  </label>

                                  <button
                                    className="question-remove-button ordinary-rule-remove"
                                    type="button"
                                    title="删除这个采分点"
                                    aria-label={`删除第 ${activeSectionIndex + 1} 小题第 ${subquestionIndex + 1} 个子问题的第 ${pointIndex + 1} 个采分点`}
                                    onClick={() => removePoint(activeSectionIndex, subquestionIndex, pointIndex)}
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>

                                {pointExpanded ? (
                                  <div className="ordinary-rule-point-extra">
                                    <div className="ordinary-rule-aux-card ordinary-rule-aux-card--compact">
                                      <div className="ordinary-rule-aux-head">
                                        <strong>别名</strong>
                                        <div className="ordinary-rule-aux-head-actions">
                                          <button
                                            className="pill-button cream ordinary-rule-mini-button"
                                            type="button"
                                            onClick={() => updateStringList(activeSectionIndex, subquestionIndex, pointIndex, 'aliases', (values) => [...values, ''])}
                                          >
                                            <FolderPlus size={12} />
                                            增加
                                          </button>
                                          <button
                                            className="pill-button peach ordinary-rule-mini-button"
                                            type="button"
                                            disabled={aliasAssistant.loading}
                                            onClick={() => handleGenerateAliasSuggestions(activeSectionIndex, subquestionIndex, pointIndex)}
                                          >
                                            {aliasAssistant.loading ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={12} />}
                                            AI生成
                                          </button>
                                        </div>
                                      </div>
                                      {aliasAssistant.suggestions.length ? (
                                        <div className="ordinary-rule-suggestion-strip">
                                          {aliasAssistant.suggestions.map((alias) => (
                                            <button
                                              key={`${point.id}-suggestion-${alias}`}
                                              className="ordinary-rule-suggestion-chip"
                                              type="button"
                                              onClick={() => adoptGeneratedAlias(activeSectionIndex, subquestionIndex, pointIndex, alias)}
                                            >
                                              + {alias}
                                            </button>
                                          ))}
                                        </div>
                                      ) : null}
                                      {aliasAssistant.error ? <div className="ordinary-rule-inline-message">{aliasAssistant.error}</div> : null}
                                      <div className="ordinary-rule-aux-list">
                                        {point.aliases.length ? point.aliases.map((alias, aliasIndex) => (
                                          <div key={`${point.id}-alias-${aliasIndex}`} className="ordinary-rule-aux-row">
                                            <input
                                              value={alias}
                                              onChange={(event) =>
                                                updateStringList(
                                                  activeSectionIndex,
                                                  subquestionIndex,
                                                  pointIndex,
                                                  'aliases',
                                                  (values) => replaceAt(values, aliasIndex, event.target.value),
                                                )}
                                              placeholder="近似表述"
                                            />
                                            <button
                                              className="question-remove-button ordinary-rule-remove"
                                              type="button"
                                              aria-label="删除别名"
                                              onClick={() =>
                                                updateStringList(
                                                  activeSectionIndex,
                                                  subquestionIndex,
                                                  pointIndex,
                                                  'aliases',
                                                  (values) => values.filter((_, index) => index !== aliasIndex),
                                                )}
                                            >
                                              <Trash2 size={12} />
                                            </button>
                                          </div>
                                        )) : (
                                          <div className="empty-inline ordinary-rule-empty-tip">需要时再补近似表述。</div>
                                        )}
                                      </div>
                                    </div>

                                    <div className="ordinary-rule-aux-card ordinary-rule-aux-card--compact">
                                      <div className="ordinary-rule-aux-head">
                                        <strong>说明</strong>
                                        <button
                                          className="pill-button cream ordinary-rule-mini-button"
                                          type="button"
                                          onClick={() => updateStringList(activeSectionIndex, subquestionIndex, pointIndex, 'notes', (values) => [...values, ''])}
                                        >
                                          <FolderPlus size={12} />
                                          增加
                                        </button>
                                      </div>
                                      <div className="ordinary-rule-aux-list">
                                        {point.notes.length ? point.notes.map((note, noteIndex) => (
                                          <div key={`${point.id}-note-${noteIndex}`} className="ordinary-rule-aux-row">
                                            <input
                                              value={note}
                                              onChange={(event) =>
                                                updateStringList(
                                                  activeSectionIndex,
                                                  subquestionIndex,
                                                  pointIndex,
                                                  'notes',
                                                  (values) => replaceAt(values, noteIndex, event.target.value),
                                                )}
                                              placeholder="评分说明"
                                            />
                                            <button
                                              className="question-remove-button ordinary-rule-remove"
                                              type="button"
                                              aria-label="删除说明"
                                              onClick={() =>
                                                updateStringList(
                                                  activeSectionIndex,
                                                  subquestionIndex,
                                                  pointIndex,
                                                  'notes',
                                                  (values) => values.filter((_, index) => index !== noteIndex),
                                                )}
                                            >
                                              <Trash2 size={12} />
                                            </button>
                                          </div>
                                        )) : (
                                          <div className="empty-inline ordinary-rule-empty-tip">这里只写评分边界或提醒。</div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>

                        <div className="ordinary-rule-actions ordinary-rule-actions--compact">
                          <button className="pill-button cream" type="button" onClick={() => addPoint(activeSectionIndex, subquestionIndex)}>
                            <FolderPlus size={14} />
                            新增采分点
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              })}

              <div className="ordinary-rule-actions ordinary-rule-actions--compact">
                <button className="pill-button lavender" type="button" onClick={() => addSubquestion(activeSectionIndex)}>
                  <FolderPlus size={14} />
                  新增子问题
                </button>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
