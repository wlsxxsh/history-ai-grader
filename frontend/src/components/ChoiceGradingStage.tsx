import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  FileDown,
  LoaderCircle,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  ChoiceGradeStatus,
  ChoiceExplanationQuestion,
  ChoiceQuestionGradeRecord,
  ChoiceQuestionOptionStat,
  ChoiceQuestionSummaryRecord,
  ChoiceStudentGradingRecord,
  TaskDetail,
} from '../types';

interface ChoiceGradingStageProps {
  task: TaskDetail | null;
  isRunning: boolean;
  isGeneratingExplanation: boolean;
  isExportingExplanation: boolean;
  onRun: () => void;
  onGenerateExplanation: (payload: { threshold: number; selectedQuestionNos: string[] }) => void;
  onClearExplanation: () => void;
  onExportExplanation: () => void;
}

interface StudentProgressMetrics {
  resolvedCount: number;
  attemptedCount: number;
  remainingCount: number;
  wrongRate: number | null;
}

interface QuestionProgressMetrics {
  resolvedCount: number;
  attemptedCount: number;
  remainingCount: number;
  wrongRate: number | null;
}

const PRIMARY_OPTIONS = ['A', 'B', 'C', 'D'] as const;

function formatDateLabel(value: string) {
  if (!value) return '尚未批阅';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function getRiskTone(rate: number | null) {
  if (rate === null || !Number.isFinite(rate)) return 'muted';
  if (rate <= 0.2) return 'good';
  if (rate <= 0.4) return 'mid';
  return 'low';
}

function getGradeTone(status: ChoiceGradeStatus) {
  if (status === 'correct') return 'good';
  if (status === 'wrong' || status === 'review') return 'low';
  if (status === 'blank' || status === 'pending') return 'mid';
  return 'muted';
}

function buildQuestionSummaryText(grade: ChoiceQuestionGradeRecord) {
  if (grade.status === 'correct') return `第 ${grade.questionNo} 题 · ${grade.answer}`;
  if (grade.status === 'wrong') return `第 ${grade.questionNo} 题 · ${grade.answer} -> ${grade.standardAnswer}`;
  if (grade.status === 'blank') return `第 ${grade.questionNo} 题 · 空白`;
  if (grade.status === 'pending') return `第 ${grade.questionNo} 题 · 待补`;
  if (grade.status === 'review') return `第 ${grade.questionNo} 题 · 待复核`;
  return `第 ${grade.questionNo} 题 · 未配置答案`;
}

function getStudentProgressMetrics(student: ChoiceStudentGradingRecord): StudentProgressMetrics {
  const resolvedCount = student.correctCount + student.wrongCount;
  const attemptedCount = resolvedCount + student.reviewCount;
  const remainingCount = student.blankCount + student.pendingCount;

  return {
    resolvedCount,
    attemptedCount,
    remainingCount,
    wrongRate: resolvedCount > 0 ? student.wrongCount / resolvedCount : null,
  };
}

function getQuestionProgressMetrics(question: ChoiceQuestionSummaryRecord): QuestionProgressMetrics {
  const resolvedCount = question.correctCount + question.wrongCount;
  const attemptedCount = resolvedCount + question.reviewCount;
  const remainingCount = question.blankCount + question.pendingCount;

  return {
    resolvedCount,
    attemptedCount,
    remainingCount,
    wrongRate: resolvedCount > 0 ? question.wrongCount / resolvedCount : null,
  };
}

function getPrimaryOptionStats(question: ChoiceQuestionSummaryRecord) {
  const optionMap = new Map(question.optionStats.map((item) => [item.option, item]));
  return PRIMARY_OPTIONS.map(
    (option) =>
      optionMap.get(option) || {
        option,
        count: 0,
        studentNames: [],
      },
  );
}

function getSecondaryOptionStats(question: ChoiceQuestionSummaryRecord) {
  return question.optionStats.filter((item) => !PRIMARY_OPTIONS.includes(item.option as (typeof PRIMARY_OPTIONS)[number]) && item.count > 0);
}

function getQuestionOptionLabel(option: ChoiceQuestionOptionStat['option']) {
  if (option === '空白') return '空白';
  if (option === '待补交') return '待补';
  if (option === '待复核') return '待复核';
  if (option === '未配置答案') return '未配答案';
  return option;
}

function compareQuestionNo(left: string, right: string) {
  return String(left || '').localeCompare(String(right || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function parseQuestionNosText(value: string) {
  return Array.from(
    new Set(
      String(value ?? '')
        .split(/[\s,\n\r\uFF0C\u3001\uFF1B;]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).sort(compareQuestionNo);
}

function _ChoiceExplanationCardLegacy({ question }: { question: ChoiceExplanationQuestion }) {
  return (
    <article className="choice-explanation-card">
      <div className="choice-explanation-card-head">
        <div>
          <h5>{`第 ${question.questionNo} 题${question.title ? `：${question.title}` : ''}`}</h5>
          <p>
            {question.correctRate == null ? '暂无正确率' : `正确率 ${formatPercent(question.correctRate)}`}
            {question.correctAnswer ? ` · 正确答案 ${question.correctAnswer}` : ''}
            {question.topWrongOption ? ` · 高频误选 ${question.topWrongOption}${question.topWrongOptionCount ? `（${question.topWrongOptionCount}人）` : ''}` : ''}
          </p>
        </div>
      </div>

      {question.promptStem ? <div className="choice-explanation-stem">{question.promptStem}</div> : null}

      <div className="choice-explanation-section">
        <strong>老师的思考过程与逻辑链条</strong>
        <div className="choice-explanation-step-list">
          {question.thinkingSteps.map((step, index) => (
            <div key={`${question.questionNo}-step-${index}`} className="choice-explanation-step">
              <span>{step.label}</span>
              <p>{step.content}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="choice-explanation-section">
        <strong>错误选项错在哪里</strong>
        <div className="choice-explanation-wrong-list">
          {question.wrongOptionAnalyses.map((item, index) => (
            <div key={`${question.questionNo}-wrong-${item.option}-${index}`} className="choice-explanation-wrong-item">
              <span>{`${item.option} 项${item.reasonType ? `（${item.reasonType}）` : ''}`}</span>
              <p>{item.analysis}</p>
            </div>
          ))}
        </div>
      </div>

      {question.summary ? (
        <div className="choice-explanation-summary">
          <strong>总结</strong>
          <p>{question.summary}</p>
        </div>
      ) : null}
    </article>
  );
}

function ChoiceExplanationCard({ question }: { question: ChoiceExplanationQuestion }) {
  const validWrongOptionAnalyses = question.wrongOptionAnalyses.filter(
    (item) => item.option || item.analysis || item.reasonType,
  );

  return (
    <article className="choice-explanation-card">
      <header className="choice-explanation-card-head">
        <h5>{`第 ${question.questionNo} 题${question.title ? `：${question.title}` : ''}`}</h5>
        <p className="choice-explanation-meta">
          {question.correctRate == null ? '暂无正确率' : `正确率 ${formatPercent(question.correctRate)}`}
          {question.correctAnswer ? ` · 正确答案 ${question.correctAnswer}` : ''}
          {question.topWrongOption ? ` · 高频误选 ${question.topWrongOption}${question.topWrongOptionCount ? `（${question.topWrongOptionCount}人）` : ''}` : ''}
        </p>
      </header>

      {question.promptStem ? (
        <p className="choice-explanation-stem">
          <strong>题目主旨：</strong>
          <span>{question.promptStem}</span>
        </p>
      ) : null}

      <section className="choice-explanation-section">
        <strong>【老师的思考过程与逻辑链条】</strong>
        <ul className="choice-explanation-bullet-list">
          {question.thinkingSteps.map((step, index) => (
            <li key={`${question.questionNo}-step-${index}`} className="choice-explanation-bullet-item">
              <span className="choice-explanation-bullet-label">{step.label}。</span>
              <span>{step.content}</span>
            </li>
          ))}
        </ul>
      </section>

      {validWrongOptionAnalyses.length ? (
        <section className="choice-explanation-section">
          <strong>【错误选项错在哪里？】</strong>
          <ul className="choice-explanation-bullet-list">
            {validWrongOptionAnalyses.map((item, index) => (
              <li key={`${question.questionNo}-wrong-${item.option}-${index}`} className="choice-explanation-bullet-item">
                <span className="choice-explanation-bullet-label">
                  {`${item.option || '?'}项${item.reasonType ? `（${item.reasonType}）` : ''}：`}
                </span>
                <span>{item.analysis || '该项分析暂未生成。'}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {question.summary ? (
        <section className="choice-explanation-summary">
          <strong>【讲题总结】</strong>
          <p>{question.summary}</p>
        </section>
      ) : null}
    </article>
  );
}

void _ChoiceExplanationCardLegacy;

function CollapsibleDetailBlock({
  title,
  summary,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="choice-detail-block">
      <button className="choice-collapse-button" type="button" onClick={onToggle}>
        <span className="choice-collapse-title">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <strong>{title}</strong>
        </span>
        <span className="choice-collapse-summary">{summary}</span>
      </button>
      {expanded ? children : null}
    </div>
  );
}

export function ChoiceGradingStage({
  task,
  isRunning,
  isGeneratingExplanation,
  isExportingExplanation,
  onRun,
  onGenerateExplanation,
  onClearExplanation,
  onExportExplanation,
}: ChoiceGradingStageProps) {
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [selectedQuestionNo, setSelectedQuestionNo] = useState('');
  const [remainingExpanded, setRemainingExpanded] = useState(false);
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [explanationThresholdText, setExplanationThresholdText] = useState('80');
  const [manualQuestionNosText, setManualQuestionNosText] = useState('');

  const choiceQuestions = useMemo(
    () => (task?.questions ?? []).filter((question) => question.type === 'choice' && question.enabled !== false),
    [task?.questions],
  );
  const choiceStudentsWithAnswer = useMemo(
    () =>
      (task?.studentRecords ?? []).filter((record) =>
        record.choiceAnswers.some((item) => item.hasOverride || item.baseState !== 'missing'),
      ),
    [task?.studentRecords],
  );
  const grading = task?.choiceGrading ?? null;
  const explanation = task?.choiceExplanation ?? null;
  const studentRecordMap = useMemo(
    () => new Map((task?.studentRecords ?? []).map((record) => [record.studentName, record])),
    [task?.studentRecords],
  );
  const totalChoiceQuestionCount = grading?.questionCount ?? choiceQuestions.length;
  const parsedThreshold = Number(explanationThresholdText);
  const normalizedThreshold = Number.isFinite(parsedThreshold) ? Math.max(0, Math.min(100, parsedThreshold)) : 80;

  useEffect(() => {
    const studentSummaries = grading?.studentSummaries ?? [];
    if (!studentSummaries.length) {
      setSelectedStudentId('');
      return;
    }
    if (selectedStudentId && studentSummaries.some((item) => item.studentId === selectedStudentId)) {
      return;
    }
    setSelectedStudentId('');
  }, [grading?.studentSummaries, selectedStudentId]);

  useEffect(() => {
    setRemainingExpanded(false);
    setReviewExpanded(false);
  }, [selectedStudentId]);

  useEffect(() => {
    const questionSummaries = grading?.questionSummaries ?? [];
    if (!questionSummaries.length) {
      setSelectedQuestionNo('');
      return;
    }
    if (selectedQuestionNo && questionSummaries.some((item) => item.questionNo === selectedQuestionNo)) {
      return;
    }
    setSelectedQuestionNo('');
  }, [grading?.questionSummaries, selectedQuestionNo]);

  useEffect(() => {
    if (explanation) {
      setExplanationThresholdText(String(explanation.threshold || 80));
      setManualQuestionNosText((explanation.selectedQuestionNos || []).join('、'));
      return;
    }
    setExplanationThresholdText('80');
    setManualQuestionNosText('');
  }, [task?.id, explanation]);

  useEffect(() => {
    if ((!selectedQuestionNo && !selectedStudentId) || typeof document === 'undefined') {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedQuestionNo('');
        setSelectedStudentId('');
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedQuestionNo, selectedStudentId]);

  const selectedStudent = useMemo(
    () => grading?.studentSummaries.find((item) => item.studentId === selectedStudentId) ?? null,
    [grading?.studentSummaries, selectedStudentId],
  );
  const selectedStudentRecord = selectedStudent ? studentRecordMap.get(selectedStudent.studentName) ?? null : null;
  const selectedQuestion = useMemo(
    () => grading?.questionSummaries.find((item) => item.questionNo === selectedQuestionNo) ?? null,
    [grading?.questionSummaries, selectedQuestionNo],
  );
  const pendingUpdateStudents = useMemo(() => {
    if (!task) return [];
    if (!grading) return choiceStudentsWithAnswer;
    return task.studentRecords.filter(
      (record) =>
        record.choiceAnswers.some((item) => item.hasOverride || item.baseState !== 'missing') &&
        record.updatedAt > grading.lastRunAt,
    );
  }, [choiceStudentsWithAnswer, grading, task]);

  const hasConfigIssue = choiceQuestions.some((question) => !String(question.standardAnswer || '').trim());
  const recommendedQuestionNos = useMemo(
    () =>
      (grading?.questionSummaries ?? [])
        .filter((question) => Number.isFinite(question.correctRate) && question.correctRate < normalizedThreshold / 100)
        .map((question) => question.questionNo)
        .sort(compareQuestionNo),
    [grading?.questionSummaries, normalizedThreshold],
  );
  const selectedExplanationQuestionNos = useMemo(() => {
    const manualQuestionNos = parseQuestionNosText(manualQuestionNosText);
    return manualQuestionNos.length ? manualQuestionNos : recommendedQuestionNos;
  }, [manualQuestionNosText, recommendedQuestionNos]);

  if (!task) {
    return <div className="empty-state">先创建任务并完成前 3 步，再进入第 4 步批阅选择题。</div>;
  }

  if (task.mode === 'subjective') {
    return <div className="empty-state">当前任务是主观题模式，第 4 步不会显示选择题批阅页。</div>;
  }

  if (!choiceQuestions.length) {
    return <div className="empty-state">请先在第 2 步配置选择题答案，再开始第 4 步批阅。</div>;
  }

  const selectedStudentMetrics = selectedStudent ? getStudentProgressMetrics(selectedStudent) : null;
  const selectedQuestionMetrics = selectedQuestion ? getQuestionProgressMetrics(selectedQuestion) : null;
  const selectedQuestionPrimaryStats = selectedQuestion ? getPrimaryOptionStats(selectedQuestion) : [];
  const selectedQuestionSecondaryStats = selectedQuestion ? getSecondaryOptionStats(selectedQuestion) : [];
  const remainingGrades = selectedStudent?.questionGrades.filter((item) => item.status === 'blank' || item.status === 'pending') ?? [];
  const reviewGrades = selectedStudent?.questionGrades.filter((item) => item.status === 'review') ?? [];
  const wrongGrades = selectedStudent?.questionGrades.filter((item) => item.status === 'wrong') ?? [];

  const studentDrawer =
    selectedStudent && selectedStudentMetrics && typeof document !== 'undefined'
      ? createPortal(
          <div className="choice-drawer-backdrop" role="presentation" onClick={() => setSelectedStudentId('')}>
            <aside
              className="choice-drawer"
              role="dialog"
              aria-modal="true"
              aria-labelledby={`choice-student-drawer-${selectedStudent.studentId}`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="choice-drawer-head">
                <div className="choice-drawer-head-main">
                  <span className="choice-drawer-kicker">学生详情</span>
                  <h4 id={`choice-student-drawer-${selectedStudent.studentId}`}>{selectedStudent.studentName}</h4>
                  <p>
                    已作答 {selectedStudentMetrics.attemptedCount}/{totalChoiceQuestionCount}
                    {' · '}
                    待完成 {selectedStudentMetrics.remainingCount}
                    {' · '}
                    待复核 {selectedStudent.reviewCount}
                    {selectedStudent.isExtra ? ' · 名单外学生' : ''}
                  </p>
                </div>
                <div className="choice-drawer-head-actions">
                  <span className={`status-pill ${getRiskTone(selectedStudentMetrics.wrongRate)}`}>
                    {selectedStudentMetrics.wrongRate === null ? '暂无错误率' : `错误率 ${formatPercent(selectedStudentMetrics.wrongRate)}`}
                  </span>
                  <button className="mini-icon-button" type="button" onClick={() => setSelectedStudentId('')}>
                    <X size={14} />
                    关闭
                  </button>
                </div>
              </div>

              <div className="choice-drawer-body">
                <div className="choice-drawer-metrics">
                  <div className="choice-drawer-metric">
                    <strong>{selectedStudentMetrics.attemptedCount}</strong>
                    <span>已作答</span>
                  </div>
                  <div className="choice-drawer-metric">
                    <strong>{selectedStudentMetrics.resolvedCount}</strong>
                    <span>已判定</span>
                  </div>
                  <div className="choice-drawer-metric">
                    <strong>{selectedStudent.correctCount}</strong>
                    <span>答对</span>
                  </div>
                  <div className="choice-drawer-metric">
                    <strong>{selectedStudent.wrongCount}</strong>
                    <span>答错</span>
                  </div>
                  <div className="choice-drawer-metric">
                    <strong>{selectedStudentMetrics.remainingCount}</strong>
                    <span>待完成</span>
                  </div>
                  <div className="choice-drawer-metric">
                    <strong>{selectedStudent.reviewCount}</strong>
                    <span>待复核</span>
                  </div>
                </div>

                {selectedStudentRecord?.warnings.length ? (
                  <div className="choice-detail-block warning-block">
                    <div className="choice-detail-block-head">
                      <strong>提醒</strong>
                      <span>{selectedStudentRecord.warnings.length} 条</span>
                    </div>
                    <div className="choice-chip-wrap">
                      {selectedStudentRecord.warnings.map((warning, index) => (
                        <span key={`${selectedStudent.studentId}-warning-${index}`} className="choice-chip muted">
                          {warning}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="choice-detail-block">
                  <div className="choice-detail-block-head">
                    <strong>错误题目</strong>
                    <span>{wrongGrades.length} 题</span>
                  </div>
                  <div className="choice-chip-wrap">
                    {wrongGrades.length ? (
                      wrongGrades.map((item) => (
                        <span key={`${selectedStudent.studentId}-wrong-${item.questionNo}`} className="choice-chip low">
                          {buildQuestionSummaryText(item)}
                        </span>
                      ))
                    ) : (
                      <span className="choice-chip good">当前没有答错题目</span>
                    )}
                  </div>
                </div>

                <CollapsibleDetailBlock
                  title="待完成题目"
                  summary={`${remainingGrades.length} 题`}
                  expanded={remainingExpanded}
                  onToggle={() => setRemainingExpanded((current) => !current)}
                >
                  <div className="choice-chip-wrap">
                    {remainingGrades.length ? (
                      remainingGrades.map((item) => (
                        <span key={`${selectedStudent.studentId}-remaining-${item.questionNo}`} className={`choice-chip ${getGradeTone(item.status)}`}>
                          {buildQuestionSummaryText(item)}
                        </span>
                      ))
                    ) : (
                      <span className="choice-chip good">没有待完成题目</span>
                    )}
                  </div>
                </CollapsibleDetailBlock>

                <CollapsibleDetailBlock
                  title="待复核题目"
                  summary={`${reviewGrades.length} 题`}
                  expanded={reviewExpanded}
                  onToggle={() => setReviewExpanded((current) => !current)}
                >
                  <div className="choice-chip-wrap">
                    {reviewGrades.length ? (
                      reviewGrades.map((item) => (
                        <span key={`${selectedStudent.studentId}-review-${item.questionNo}`} className={`choice-chip ${getGradeTone(item.status)}`}>
                          {buildQuestionSummaryText(item)}
                        </span>
                      ))
                    ) : (
                      <span className="choice-chip good">当前没有待复核题目</span>
                    )}
                  </div>
                </CollapsibleDetailBlock>

                <div className="choice-detail-block">
                  <div className="choice-detail-block-head">
                    <strong>来源页</strong>
                    <span>{selectedStudentRecord?.sources.length ?? 0} 页</span>
                  </div>
                  <div className="choice-chip-wrap">
                    {selectedStudentRecord?.sources.length ? (
                      selectedStudentRecord.sources.map((source) => (
                        <span key={`${selectedStudent.studentId}-${source.sheetId}`} className="choice-chip muted">
                          {source.label}
                        </span>
                      ))
                    ) : (
                      <span className="choice-chip muted">当前还没有来源页记录</span>
                    )}
                  </div>
                </div>
              </div>
            </aside>
          </div>,
          document.body,
        )
      : null;

  const questionDrawer =
    selectedQuestion && typeof document !== 'undefined'
      ? createPortal(
          <div className="choice-drawer-backdrop" role="presentation" onClick={() => setSelectedQuestionNo('')}>
            <aside
              className="choice-drawer"
              role="dialog"
              aria-modal="true"
              aria-labelledby={`choice-question-drawer-${selectedQuestion.questionNo}`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="choice-drawer-head">
                <div className="choice-drawer-head-main">
                  <span className="choice-drawer-kicker">题目详情</span>
                  <h4 id={`choice-question-drawer-${selectedQuestion.questionNo}`}>第 {selectedQuestion.questionNo} 题作答分布</h4>
                  <p>
                    标准答案：{selectedQuestion.standardAnswer || '未配置答案'}
                    {' · '}
                    已作答 {selectedQuestionMetrics?.attemptedCount ?? 0} 人
                    {' · '}
                    {selectedQuestionMetrics?.wrongRate === null || selectedQuestionMetrics?.wrongRate === undefined
                      ? '暂无已判定错误率'
                      : `错误率 ${formatPercent(selectedQuestionMetrics.wrongRate)}`}
                  </p>
                </div>
                <button className="mini-icon-button" type="button" onClick={() => setSelectedQuestionNo('')}>
                  <X size={14} />
                  关闭
                </button>
              </div>

              <div className="choice-drawer-body">
                <div className="choice-drawer-metrics">
                  <div className="choice-drawer-metric">
                    <strong>{selectedQuestionMetrics?.attemptedCount ?? 0}</strong>
                    <span>已作答</span>
                  </div>
                  <div className="choice-drawer-metric">
                    <strong>{selectedQuestionMetrics?.resolvedCount ?? 0}</strong>
                    <span>已判定</span>
                  </div>
                  <div className="choice-drawer-metric">
                    <strong>{selectedQuestion.correctCount}</strong>
                    <span>答对</span>
                  </div>
                  <div className="choice-drawer-metric">
                    <strong>{selectedQuestion.wrongCount}</strong>
                    <span>答错</span>
                  </div>
                  <div className="choice-drawer-metric">
                    <strong>{selectedQuestionMetrics?.remainingCount ?? 0}</strong>
                    <span>待完成</span>
                  </div>
                  <div className="choice-drawer-metric">
                    <strong>{selectedQuestion.reviewCount}</strong>
                    <span>待复核</span>
                  </div>
                </div>

                <section className="choice-primary-option-grid">
                  {selectedQuestionPrimaryStats.map((item) => {
                    const isStandard = item.option === selectedQuestion.standardAnswer;
                    return (
                      <article
                        key={`${selectedQuestion.questionNo}-${item.option}`}
                        className={`choice-primary-option-card ${isStandard ? 'standard' : ''}`}
                      >
                        <div className="choice-primary-option-top">
                          <div>
                            <span className="choice-primary-option-letter">{item.option}</span>
                            <div className="choice-primary-option-subtitle">{isStandard ? '标准答案' : '作答人数'}</div>
                          </div>
                          <strong className="choice-primary-option-count">{item.count}</strong>
                        </div>
                        <div className="choice-name-wrap">
                          {item.studentNames.length ? (
                            item.studentNames.map((name) => (
                              <span key={`${selectedQuestion.questionNo}-${item.option}-${name}`} className="choice-chip muted">
                                {name}
                              </span>
                            ))
                          ) : (
                            <span className="choice-chip muted">暂无学生</span>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </section>

                {selectedQuestionSecondaryStats.length > 0 ? (
                  <section className="choice-secondary-panel">
                    <div className="choice-secondary-panel-head">
                      <strong>补充状态</strong>
                      <span>这部分不作为主视觉，只用于辅助判断当前题目的完成情况。</span>
                    </div>
                    <div className="choice-secondary-strip">
                      {selectedQuestionSecondaryStats.map((item) => (
                        <span key={`${selectedQuestion.questionNo}-${item.option}`} className="choice-secondary-pill">
                          {getQuestionOptionLabel(item.option)} {item.count} 人
                        </span>
                      ))}
                    </div>
                  </section>
                ) : null}
              </div>
            </aside>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div className="panel-title-row">
        <h3>批阅选择题</h3>
        <span>步骤 4</span>
      </div>

      <section className="editor-section choice-grading-toolbar">
        <div className="choice-grading-toolbar-top">
          <div>
            <h4>自动比对标准答案，并可在补交后重新刷新统计</h4>
            <p>步骤 4 现在更强调“已作答进度”和“错误率”。学生后续继续补交答题卡后，只要重新运行本步骤，下面的全班统计和题目分布就会一起刷新。</p>
          </div>
          <div className="choice-grading-actions">
            <button className="pill-button peach" type="button" onClick={onRun} disabled={isRunning || !choiceStudentsWithAnswer.length}>
              {isRunning ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              {isRunning ? '正在批阅选择题...' : '批阅选择题'}
            </button>
          </div>
        </div>

        {pendingUpdateStudents.length > 0 && (
          <div className="notice-inline warning">
            检测到 {pendingUpdateStudents.length} 名学生有新增或补交的选择题作答。当前全班统计仍以上一次批阅结果为准，重新点击“批阅选择题”后会整体刷新。
          </div>
        )}

        {hasConfigIssue && (
          <div className="choice-grading-inline-tip">
            <AlertCircle size={16} />
            <span>当前仍有部分选择题未填写标准答案。它们会继续显示“未配置答案”，但不会影响其他已配置题目的统计。</span>
          </div>
        )}

        <div className="choice-grading-metrics">
          <div className="choice-grading-metric">
            <strong>{choiceStudentsWithAnswer.length}</strong>
            <span>已有作答学生</span>
          </div>
          <div className="choice-grading-metric">
            <strong>{choiceQuestions.length}</strong>
            <span>选择题总数</span>
          </div>
          <div className="choice-grading-metric">
            <strong>{grading?.newlyGradedCount ?? 0}</strong>
            <span>上次新增判定</span>
          </div>
          <div className="choice-grading-metric">
            <strong>{grading ? formatDateLabel(grading.lastRunAt) : '尚未开始'}</strong>
            <span>最近批阅时间</span>
          </div>
        </div>
      </section>

      {grading ? (
        <>
          <div className="choice-grading-layout">
            <section className="editor-section">
              <div className="section-head compact-head">
                <div>
                  <h4>全班答题情况</h4>
                  <p>每位学生一个方块，颜色按错误率变化。点击学生卡片后，会在抽屉里展开这位学生的作答详情、错误题目和来源页。</p>
                </div>
              </div>

              <div className="choice-student-grid">
                {grading.studentSummaries.map((student) => {
                  const metrics = getStudentProgressMetrics(student);
                  const tone = getRiskTone(metrics.wrongRate);
                  return (
                    <button
                      key={student.studentId}
                      type="button"
                      className={`choice-score-tile ${tone} ${selectedStudentId === student.studentId ? 'active' : ''}`}
                      onClick={() => {
                        setSelectedQuestionNo('');
                        setSelectedStudentId(student.studentId);
                      }}
                    >
                      <div className="choice-score-tile-head">
                        <strong>{student.studentName}</strong>
                        {student.isExtra ? <span className="choice-tile-kicker">名单外</span> : null}
                      </div>
                      <span>已作答 {metrics.attemptedCount}/{totalChoiceQuestionCount}</span>
                      <small>{metrics.wrongRate === null ? '暂无已判定错误率' : `答错 ${student.wrongCount} 题 · 错误率 ${formatPercent(metrics.wrongRate)}`}</small>
                      <div className="choice-score-footer">
                        <span>待完成 {metrics.remainingCount}</span>
                        <span>待复核 {student.reviewCount}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>

          <section className="editor-section">
            <div className="section-head">
              <div>
                <h4>每一道题的得分情况</h4>
                <p>题目卡片优先显示 A、B、C、D 的人数。点击任意题目后，会在右侧抽屉中展开完整名单和辅助状态信息。</p>
              </div>
            </div>

            <div className="choice-question-grid">
              {grading.questionSummaries.map((question) => {
                const metrics = getQuestionProgressMetrics(question);
                const primaryStats = getPrimaryOptionStats(question);
                return (
                  <button
                    key={question.questionNo}
                    type="button"
                    className={`choice-score-tile choice-question-tile ${getRiskTone(metrics.wrongRate)} ${
                      selectedQuestionNo === question.questionNo ? 'active' : ''
                    }`}
                    onClick={() => {
                      setSelectedStudentId('');
                      setSelectedQuestionNo(question.questionNo);
                    }}
                  >
                    <div className="choice-score-tile-head">
                      <strong>第 {question.questionNo} 题</strong>
                      <span className="choice-tile-kicker">{question.standardAnswer ? `标准 ${question.standardAnswer}` : '未配答案'}</span>
                    </div>
                    <span>已作答 {metrics.attemptedCount} 人</span>
                    <small>{metrics.wrongRate === null ? '暂无已判定错误率' : `错误率 ${formatPercent(metrics.wrongRate)}`}</small>
                    <div className="choice-tile-primary-row">
                      {primaryStats.map((item) => (
                        <span key={`${question.questionNo}-${item.option}`} className="choice-tile-primary-stat">
                          <strong>{item.option}</strong>
                          <small>{item.count}</small>
                        </span>
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="editor-section choice-explanation-panel">
            <div className="section-head">
              <div>
                <h4>选择题详细解析</h4>
                <p>系统会结合步骤二上传的题目 PDF、标准答案和步骤四统计，生成老师式详细讲题解析。</p>
              </div>
            </div>

            <div className="choice-explanation-toolbar">
              <label className="mini-switch">
                <span>正确率阈值</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={explanationThresholdText}
                  onChange={(event) => setExplanationThresholdText(event.target.value)}
                  disabled={isGeneratingExplanation}
                />
              </label>
              <button
                className="pill-button peach"
                type="button"
                onClick={() => onGenerateExplanation({ threshold: normalizedThreshold, selectedQuestionNos: selectedExplanationQuestionNos })}
                disabled={isGeneratingExplanation || !selectedExplanationQuestionNos.length}
              >
                {isGeneratingExplanation ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
                {isGeneratingExplanation ? '正在生成解析...' : '生成解析'}
              </button>
              <button className="pill-button cream" type="button" onClick={onClearExplanation} disabled={isGeneratingExplanation || !explanation}>
                清空解析
              </button>
            </div>

            <div className="choice-explanation-config">
              <label className="choice-explanation-field">
                <span>自动推荐题号</span>
                <div className="choice-chip-wrap">
                  {recommendedQuestionNos.length ? (
                    recommendedQuestionNos.map((questionNo) => (
                      <span key={`recommended-${questionNo}`} className="choice-chip low">
                        {questionNo}
                      </span>
                    ))
                  ) : (
                    <span className="choice-chip muted">当前没有低于阈值的题目</span>
                  )}
                </div>
              </label>

              <label className="choice-explanation-field">
                <span>待解析题号</span>
                <textarea
                  value={manualQuestionNosText}
                  onChange={(event) => setManualQuestionNosText(event.target.value)}
                  placeholder={recommendedQuestionNos.join('、') || '例如：2、5、9'}
                  rows={2}
                  disabled={isGeneratingExplanation}
                />
                <small>留空时默认使用自动推荐题号；支持顿号、逗号、空格或换行。</small>
              </label>
            </div>

            <div className="choice-explanation-selection">
              <strong>本次将解析：</strong>
              <div className="choice-chip-wrap">
                {selectedExplanationQuestionNos.length ? (
                  selectedExplanationQuestionNos.map((questionNo) => (
                    <span key={`selected-${questionNo}`} className="choice-chip mid">
                      {questionNo}
                    </span>
                  ))
                ) : (
                  <span className="choice-chip muted">还没有可解析的题号</span>
                )}
              </div>
            </div>

            {explanation?.warnings?.length ? <div className="notice-inline warning">{explanation.warnings.join('；')}</div> : null}

            <div className="choice-explanation-toolbar">
              <button
                className="pill-button mint"
                type="button"
                onClick={onExportExplanation}
                disabled={isGeneratingExplanation || isExportingExplanation || !explanation?.questions?.length}
              >
                {isExportingExplanation ? <LoaderCircle className="spin" size={16} /> : <FileDown size={16} />}
                {isExportingExplanation ? '正在导出 DOCX...' : '导出 DOCX'}
              </button>
            </div>

            {explanation?.questions?.length ? (
              <div className="choice-explanation-list">
                {explanation.questions.map((question) => (
                  <ChoiceExplanationCard key={`explanation-${question.questionNo}`} question={question} />
                ))}
              </div>
            ) : (
              <div className="empty-inline">生成后，这里会按“老师思维过程 + 错误选项逐项分析”的格式展示详细解析。</div>
            )}
          </section>
        </>
      ) : (
        <div className="empty-state">点击上方“批阅选择题”后，系统会自动比对标准答案，并把后续补交的新选择题一起纳入最新统计。</div>
      )}

      {studentDrawer}
      {questionDrawer}
    </>
  );
}
