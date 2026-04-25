
import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileStack,
  LoaderCircle,
  RefreshCcw,
  Save,
  ScanText,
  Trash2,
  Upload,
  UserRound,
  WandSparkles,
} from 'lucide-react';
import type {
  AggregatedAnswerState,
  AnswerSheetRecognizerProfile,
  StudentAnswerSheetRecord,
  StudentProgressRecord,
  TaskDetail,
} from '../types';

export type AnswerSheetRecognizerOption = AnswerSheetRecognizerProfile;

interface AnswerSheetStageProps {
  task: TaskDetail | null;
  classroomStudents: string[];
  recognizer: AnswerSheetRecognizerOption;
  retainQuestionNosText: string;
  retainedQuestionNos: string[];
  isBusy: boolean;
  isRecognizing: boolean;
  questionConfigStatus: 'ready' | 'unconfigured' | 'updating' | 'unsaved';
  onRecognizerChange: (value: AnswerSheetRecognizerOption) => void;
  onRetainQuestionNosTextChange: (value: string) => void;
  onUpload: (files: FileList | null) => void;
  onRecognizePending: () => void;
  onRecognizeOne: (sheetId: string) => void;
  onUpdateName: (sheetId: string, manualStudentName: string) => void;
  onEditChoiceAnswer: (sheetId: string, questionNo: string, answer: string) => void;
  onEditSubjectiveAnswer: (sheetId: string, questionNo: string, content: string) => void;
  onSaveEdits: (sheetId: string) => void;
  onDeleteOne: (sheetId: string) => void;
  onDeleteAll: () => void;
}

type SubmissionTone = 'success' | 'warning' | 'danger';

type StudentSubmissionUnit = {
  key: string;
  label: string;
  detail: string;
  tone: SubmissionTone;
};

type QuestionSubmissionCard = {
  key: string;
  title: string;
  subtitle: string;
  statPills: Array<{ label: string; value: number; tone: SubmissionTone }>;
  groups: Array<{ label: string; names: string[]; tone: SubmissionTone }>;
  note: string;
};

type CollectableAnswer = {
  questionNo: string;
  baseState: AggregatedAnswerState;
  hasOverride: boolean;
};

function formatDateLabel(value: string) {
  if (!value) return '尚未处理';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function getSheetStatusMeta(status: StudentAnswerSheetRecord['status']) {
  switch (status) {
    case 'done':
      return { label: '已识别', tone: 'success' as const };
    case 'processing':
      return { label: '识别中', tone: 'info' as const };
    case 'error':
      return { label: '识别失败', tone: 'danger' as const };
    default:
      return { label: '待识别', tone: 'muted' as const };
  }
}

function getStudentStatusMeta(status: StudentProgressRecord['status']) {
  switch (status) {
    case 'ready':
      return { label: '可直接阅卷', tone: 'success' as const };
    case 'partial':
      return { label: '仍在补交', tone: 'info' as const };
    case 'needs_review':
      return { label: '需要复核', tone: 'danger' as const };
    default:
      return { label: '尚未交卷', tone: 'muted' as const };
  }
}

function getRecognizerLabel(value: AnswerSheetRecognizerOption) {
  if (value === 'answerSheet') return '答题卡识别';
  return '综合模型';
}

function getResolvedStudentName(sheet: StudentAnswerSheetRecord) {
  return (sheet.manualStudentName || sheet.studentName).trim();
}

function formatNameConfidence(value: number) {
  const normalized = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return `${Math.round(normalized * 100)}%`;
}

function getEngineLabel(sheet: StudentAnswerSheetRecord) {
  if (sheet.profile === 'answerSheet') return '答题卡识别';
  if (sheet.profile === 'general' || sheet.profile === 'strong' || sheet.profile === 'normal') return '综合模型';
  if (sheet.engine === 'doubao') return 'AI 识别';
  return '待识别';
}

function sortByQuestionNo<T extends { questionNo: string }>(items: T[]) {
  return [...items].sort((a, b) => a.questionNo.localeCompare(b.questionNo, 'zh-CN', { numeric: true }));
}

function getUniqueQuestionNos(values: string[]) {
  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean))).sort((left, right) =>
    left.localeCompare(right, 'zh-CN', { numeric: true }),
  );
}

function countCollectedAnswers<T extends CollectableAnswer>(items: T[]) {
  return items.filter((item) => item.baseState !== 'missing' || item.hasOverride).length;
}

function isCollectedAnswer<T extends CollectableAnswer>(item: T | null | undefined) {
  return Boolean(item && (item.baseState !== 'missing' || item.hasOverride));
}

function findByQuestionNo<T extends { questionNo: string }>(items: T[], questionNo: string) {
  return items.find((item) => item.questionNo === questionNo) ?? null;
}

function getAnswerStateMeta(state: AggregatedAnswerState) {
  switch (state) {
    case 'manual':
      return { label: '已手动改', tone: 'warning' as const };
    case 'answered':
      return { label: '已收录', tone: 'success' as const };
    case 'blank':
      return { label: '本页留空', tone: 'muted' as const };
    case 'conflict':
      return { label: '多版本', tone: 'danger' as const };
    default:
      return { label: '尚未收到', tone: 'info' as const };
  }
}

function getQuestionBuckets(task: TaskDetail, studentRecords: StudentProgressRecord[]) {
  const choiceQuestionNos = getUniqueQuestionNos([
    ...task.questions.filter((question) => question.type === 'choice').map((question) => question.questionNo),
    ...studentRecords.flatMap((record) => record.choiceAnswers.map((item) => item.questionNo)),
  ]);
  const subjectiveQuestionNos = getUniqueQuestionNos([
    ...task.questions.filter((question) => question.type !== 'choice').map((question) => question.questionNo),
    ...studentRecords.flatMap((record) => record.subjectiveAnswers.map((item) => item.questionNo)),
  ]);
  return { choiceQuestionNos, subjectiveQuestionNos };
}

function buildStudentSubmissionUnits(record: StudentProgressRecord | null, choiceQuestionNos: string[], subjectiveQuestionNos: string[]) {
  const units: StudentSubmissionUnit[] = [];

  if (choiceQuestionNos.length || record?.choiceAnswers.length) {
    const total = choiceQuestionNos.length || record?.choiceAnswers.length || 0;
    const collected = choiceQuestionNos.length
      ? choiceQuestionNos.filter((questionNo) => isCollectedAnswer(findByQuestionNo(record?.choiceAnswers ?? [], questionNo))).length
      : countCollectedAnswers(record?.choiceAnswers ?? []);
    let tone: SubmissionTone = 'danger';
    let detail = '未交';

    if (collected > 0 && choiceQuestionNos.length && collected < total) {
      tone = 'warning';
      detail = `${collected}/${total}`;
    } else if (collected > 0) {
      tone = 'success';
      detail = total > 0 ? `${collected}/${total}` : `已识别 ${collected} 题`;
    }

    units.push({ key: 'choice', label: '选择题', detail, tone });
  }

  subjectiveQuestionNos.forEach((questionNo) => {
    const item = findByQuestionNo(record?.subjectiveAnswers ?? [], questionNo);
    const collected = isCollectedAnswer(item);
    units.push({
      key: `subjective-${questionNo}`,
      label: `第${questionNo}题`,
      detail: collected ? '已交' : '未交',
      tone: collected ? 'success' : 'danger',
    });
  });

  return units;
}

function getStudentCollectionBucket(units: StudentSubmissionUnit[]) {
  const activeCount = units.filter((unit) => unit.tone !== 'danger').length;
  if (!units.length || activeCount === 0) return 'missing';
  if (units.every((unit) => unit.tone === 'success')) return 'complete';
  return 'partial';
}

function buildQuestionSubmissionCards(task: TaskDetail, studentRecords: StudentProgressRecord[], classroomStudents: string[], choiceQuestionNos: string[], subjectiveQuestionNos: string[]) {
  const cards: QuestionSubmissionCard[] = [];
  const recordMap = new Map(studentRecords.map((record) => [record.studentName, record]));
  const rosterNames = classroomStudents.length ? classroomStudents : studentRecords.map((record) => record.studentName);
  const canCountMissing = classroomStudents.length > 0;
  const extraStudents = classroomStudents.length ? studentRecords.filter((record) => record.isExtra) : [];

  if (task.mode !== 'subjective' && (choiceQuestionNos.length || task.mode === 'choice' || task.mode === 'mixed')) {
    const completeNames: string[] = [];
    const partialNames: string[] = [];
    const missingNames: string[] = [];

    rosterNames.forEach((studentName) => {
      const record = recordMap.get(studentName) ?? null;
      const choiceUnit = buildStudentSubmissionUnits(record, choiceQuestionNos, []).find((unit) => unit.key === 'choice');
      if (!choiceUnit || choiceUnit.tone === 'danger') {
        if (canCountMissing) missingNames.push(studentName);
        return;
      }
      if (choiceUnit.tone === 'warning') {
        partialNames.push(studentName);
        return;
      }
      completeNames.push(studentName);
    });

    const extraSubmitted = extraStudents
      .filter((record) => buildStudentSubmissionUnits(record, choiceQuestionNos, []).some((unit) => unit.key === 'choice' && unit.tone !== 'danger'))
      .map((record) => record.studentName);

    cards.push({
      key: 'choice',
      title: '选择题',
      subtitle: choiceQuestionNos.length ? `按 ${choiceQuestionNos.length} 题累计核算，可分批补交。` : '尚未配置选择题范围，先按已识别结果展示。',
      statPills: canCountMissing
        ? [
            { label: '已交齐', value: completeNames.length, tone: 'success' },
            { label: '待补齐', value: partialNames.length, tone: 'warning' },
            { label: '未交', value: missingNames.length, tone: 'danger' },
          ]
        : [{ label: '已提交', value: completeNames.length + partialNames.length, tone: 'success' }],
      groups: [
        { label: '已交齐名单', names: completeNames, tone: 'success' },
        ...(partialNames.length ? [{ label: '待补齐名单', names: partialNames, tone: 'warning' as const }] : []),
        ...(canCountMissing ? [{ label: '未交名单', names: missingNames, tone: 'danger' as const }] : []),
      ],
      note: extraSubmitted.length ? `名单外识别：${extraSubmitted.join('、')}` : canCountMissing ? '仅按当前班级名单统计。' : '未选择班级，暂不统计未交名单。',
    });
  }

  if (task.mode !== 'choice') {
    subjectiveQuestionNos.forEach((questionNo) => {
      const submittedNames: string[] = [];
      const missingNames: string[] = [];

      rosterNames.forEach((studentName) => {
        const record = recordMap.get(studentName) ?? null;
        const item = findByQuestionNo(record?.subjectiveAnswers ?? [], questionNo);
        if (isCollectedAnswer(item)) {
          submittedNames.push(studentName);
          return;
        }
        if (canCountMissing) missingNames.push(studentName);
      });

      const extraSubmitted = extraStudents
        .filter((record) => isCollectedAnswer(findByQuestionNo(record.subjectiveAnswers, questionNo)))
        .map((record) => record.studentName);

      cards.push({
        key: `subjective-${questionNo}`,
        title: `主观题第 ${questionNo} 题`,
        subtitle: '只要该题已提交并识别，就会计入这里。',
        statPills: canCountMissing
          ? [
              { label: '已交', value: submittedNames.length, tone: 'success' },
              { label: '未交', value: missingNames.length, tone: 'danger' },
            ]
          : [{ label: '已提交', value: submittedNames.length, tone: 'success' }],
        groups: [
          { label: '已交名单', names: submittedNames, tone: 'success' },
          ...(canCountMissing ? [{ label: '未交名单', names: missingNames, tone: 'danger' as const }] : []),
        ],
        note: extraSubmitted.length ? `名单外识别：${extraSubmitted.join('、')}` : canCountMissing ? '仅按当前班级名单统计。' : '未选择班级，暂不统计未交名单。',
      });
    });
  }

  return cards;
}

function buildStudentOverview(studentRecords: StudentProgressRecord[], classroomStudents: string[], choiceQuestionNos: string[], subjectiveQuestionNos: string[]) {
  const rosterNames = classroomStudents.length ? classroomStudents : studentRecords.map((record) => record.studentName);
  const recordMap = new Map(studentRecords.map((record) => [record.studentName, record]));
  let completeCount = 0;
  let partialCount = 0;
  let reviewCount = 0;

  rosterNames.forEach((studentName) => {
    const record = recordMap.get(studentName) ?? null;
    const bucket = getStudentCollectionBucket(buildStudentSubmissionUnits(record, choiceQuestionNos, subjectiveQuestionNos));
    if (bucket === 'complete') completeCount += 1;
    else if (bucket === 'partial') partialCount += 1;
    if (record?.warnings.length) reviewCount += 1;
  });

  return { totalCount: rosterNames.length, completeCount, partialCount, reviewCount };
}

function getRawSheetHint(sheet: StudentAnswerSheetRecord, classroomStudents: string[]) {
  const resolvedName = getResolvedStudentName(sheet);
  const recognizedQuestionCount = sheet.choiceAnswers.length + sheet.subjectiveAnswers.length;
  if (!resolvedName && !sheet.observedNames.length && recognizedQuestionCount === 0) {
    return '姓名和有效作答都没有识别出来，可以先打开答题卡切片人工确认，再决定是否归属或删除。';
  }
  if (!resolvedName && sheet.suggestedStudentName) {
    return '系统已经按班级名单给出一个猜测，但还没有自动归属；请打开答题卡切片核对后手动归属。';
  }
  if (!resolvedName) return '这张原始页暂未归属到学生名下；需要时可打开答题卡切片人工查看后再手动归属。';
  if (classroomStudents.length && !classroomStudents.includes(resolvedName) && !sheet.manualStudentName) {
    return '识别出的姓名不在当前班级名单中，建议手动归属后再并入学生汇总。';
  }
  return '';
}

export function AnswerSheetStage({
  task,
  classroomStudents,
  recognizer,
  retainQuestionNosText,
  retainedQuestionNos,
  isBusy,
  isRecognizing,
  questionConfigStatus,
  onRecognizerChange,
  onRetainQuestionNosTextChange,
  onUpload,
  onRecognizePending,
  onRecognizeOne,
  onUpdateName,
  onEditChoiceAnswer,
  onEditSubjectiveAnswer,
  onSaveEdits,
  onDeleteOne,
  onDeleteAll,
}: AnswerSheetStageProps) {
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const sheets = task?.answerSheets ?? [];
  const studentRecords = task?.studentRecords ?? [];
  const savedQuestionCount = task?.questions.length ?? 0;
  const questionConfigNotice = useMemo(() => {
    if (questionConfigStatus === 'ready') return '';
    if (questionConfigStatus === 'unsaved') {
      return '第 2 步里有未保存的题号或班级变更。第 3 步当前仍按上一次已保存的配置识别；等你保存后，学生汇总和题目缴纳情况会自动切换到最新配置。';
    }
    if (questionConfigStatus === 'updating') {
      if (savedQuestionCount > 0) {
        return '第 2 步正在更新题号配置。第 3 步现在会继续使用上一次已保存的配置；等更新完成并保存后，学生汇总和题目缴纳情况会自动重算。';
      }
      return '第 2 步正在识别题号配置，但目前还没有已保存配置。第 3 步会先按“预识别”继续收集答题卡；等第 2 步保存后，学生汇总和题目缴纳情况会自动重算。';
    }
    return '当前还没有已保存的题号配置。现在开始识别会先按“预识别”收集原始页和学生作答；等你在第 2 步保存题号配置后，学生汇总和题目缴纳情况会自动重算。';
  }, [questionConfigStatus, savedQuestionCount]);

  useEffect(() => {
    if (!studentRecords.length) {
      setSelectedStudentId('');
      return;
    }
    if (!studentRecords.some((record) => record.id === selectedStudentId)) {
      const preferred = studentRecords.find((record) => record.sheetCount > 0) ?? studentRecords[0];
      setSelectedStudentId(preferred.id);
    }
  }, [selectedStudentId, studentRecords]);

  const selectedStudent = useMemo(() => studentRecords.find((record) => record.id === selectedStudentId) ?? null, [selectedStudentId, studentRecords]);
  const { choiceQuestionNos, subjectiveQuestionNos } = useMemo(() => (task ? getQuestionBuckets(task, studentRecords) : { choiceQuestionNos: [], subjectiveQuestionNos: [] }), [task, studentRecords]);
  const studentOverview = useMemo(() => buildStudentOverview(studentRecords, classroomStudents, choiceQuestionNos, subjectiveQuestionNos), [studentRecords, classroomStudents, choiceQuestionNos, subjectiveQuestionNos]);
  const questionSubmissionCards = useMemo(() => (task ? buildQuestionSubmissionCards(task, studentRecords, classroomStudents, choiceQuestionNos, subjectiveQuestionNos) : []), [task, studentRecords, classroomStudents, choiceQuestionNos, subjectiveQuestionNos]);
  const unresolvedSheets = useMemo(() => {
    const roster = new Set(classroomStudents);
    return sheets.filter((sheet) => {
      const resolvedName = getResolvedStudentName(sheet);
      return !resolvedName || (classroomStudents.length > 0 && !roster.has(resolvedName));
    });
  }, [sheets, classroomStudents]);

  const renderSheetList = (sheetList: StudentAnswerSheetRecord[], emptyText: string) => {
    if (!sheetList.length) return <div className="empty-inline">{emptyText}</div>;

    return (
      <div className="raw-page-list">
        {sheetList.map((sheet) => {
          const statusMeta = getSheetStatusMeta(sheet.status);
          const resolvedStudentName = getResolvedStudentName(sheet);
          const recognizedQuestionCount = sheet.choiceAnswers.length + sheet.subjectiveAnswers.length;
          const hint = getRawSheetHint(sheet, classroomStudents);

          return (
            <div key={sheet.id} className="answer-sheet-mini-item raw-page-item">
              <div className="mini-item-top">
                <strong>{resolvedStudentName || `${sheet.displayName}（待归属）`}</strong>
                <span className={`status-pill ${statusMeta.tone}`}>{statusMeta.label}</span>
              </div>
              <div className="mini-item-meta">
                <span>{sheet.displayName}</span>
                <span>{getEngineLabel(sheet)}{sheet.selectedModel ? ` · ${sheet.selectedModel}` : ''}</span>
                <span>识别到题目 {recognizedQuestionCount} 道</span>
                <span>最近更新 {formatDateLabel(sheet.updatedAt)}</span>
              </div>
              {!sheet.manualStudentName && sheet.observedNames.length > 0 && (
                <div className="raw-page-note">识别姓名：{sheet.observedNames.join('、')}</div>
              )}
              {!resolvedStudentName && sheet.suggestedStudentName && (
                <div className="raw-page-note">系统猜测：{sheet.suggestedStudentName} · 置信度 {formatNameConfidence(sheet.suggestedStudentConfidence)}</div>
              )}
              {hint && <div className="raw-page-note muted">{hint}</div>}
              {sheet.warnings.length > 0 && <div className="row-warning">{sheet.warnings.join('；')}</div>}
              <div className="mini-item-controls">
                <select value={sheet.manualStudentName || ''} onChange={(event) => onUpdateName(sheet.id, event.target.value)} disabled={isRecognizing || classroomStudents.length === 0}>
                  <option value="">{classroomStudents.length ? '手动归属到学生名下' : '请先选择班级'}</option>
                  {classroomStudents.map((student) => <option key={`${sheet.id}-${student}`} value={student}>{student}</option>)}
                </select>
                <button
                  className="mini-icon-button"
                  type="button"
                  onClick={() => {
                    if (sheet.previewUrl) {
                      window.open(sheet.previewUrl, '_blank', 'noopener,noreferrer');
                    }
                  }}
                  disabled={!sheet.previewUrl}
                >
                  <FileStack size={14} />
                  打开答题卡切片
                </button>
                <button className="mini-icon-button" type="button" onClick={() => onRecognizeOne(sheet.id)} disabled={isRecognizing}><RefreshCcw size={14} />重识别</button>
                <button className="mini-icon-button danger" type="button" onClick={() => onDeleteOne(sheet.id)} disabled={isRecognizing}><Trash2 size={14} />删除</button>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  if (!task) return <div className="empty-state">先创建任务并完成题目配置，再进入第 3 步处理学生答题卡。</div>;

  return (
    <>
      <div className="panel-title-row">
        <h3>学生答题卡识别</h3>
        <span>步骤 3</span>
      </div>

      <div className="mode-banner">
        <strong>{task.mode === 'choice' ? '选择题模式' : task.mode === 'subjective' ? '主观题模式' : '综合模式'}</strong>
        <span>支持多次补交、多次识别、多次累加。学生和题目两侧视图会同步更新。</span>
      </div>

      {questionConfigNotice && <div className="notice-inline warning">{questionConfigNotice}</div>}

      <fieldset className="panel-fieldset" disabled={isBusy} aria-busy={isBusy}>
        <div className="split-cards answer-sheet-toolbar">
          <article className="soft-card">
            <div className="soft-card-title"><Upload size={18} />上传原始答题卡</div>
            <p>支持 PDF 和图片。PDF 会自动拆页，原始页会完整保留，后续可以继续往同一个任务里追加。</p>
            <label className="upload-tile mint-tile compact-upload">
              <input type="file" hidden multiple accept=".pdf,image/*" onChange={(event) => onUpload(event.target.files)} disabled={isRecognizing} />
              <Upload size={20} />
              <strong>继续添加答题卡</strong>
              <span>{isRecognizing ? '识别进行中，暂时锁定上传。' : '今天交一部分、明天再交一部分，也可以继续往当前任务里补。'}</span>
            </label>
          </article>

          <article className="soft-card">
            <div className="soft-card-title"><ScanText size={18} />AI 识别模式</div>
            <p>默认综合模型。系统只识别本页真实出现的题号，不会把整套题一次性补空；如果你只想收某几题，也可以在下面直接限定保留题号。</p>
            <div className="ocr-model-picker">
              <button type="button" className={recognizer === 'general' ? 'active' : ''} onClick={() => onRecognizerChange('general')} disabled={isRecognizing}>综合模型</button>
              <button type="button" className={recognizer === 'answerSheet' ? 'active' : ''} onClick={() => onRecognizerChange('answerSheet')} disabled={isRecognizing}>答题卡识别</button>
            </div>
            <label className="ocr-filter-field">
              <span>只保留这些题号</span>
              <input
                type="text"
                value={retainQuestionNosText}
                onChange={(event) => onRetainQuestionNosTextChange(event.target.value)}
                placeholder="例如：64 或 63,64"
                disabled={isRecognizing}
              />
              <small>留空表示不过滤。填写后，批量识别和单张重识别都会只保留这些题号。</small>
            </label>
            {retainedQuestionNos.length > 0 && (
              <div className="raw-page-note">
                当前仅保留：{retainedQuestionNos.join('、')}
              </div>
            )}
            <div className="button-row">
              <button className="pill-button peach" type="button" onClick={onRecognizePending} disabled={isRecognizing || !sheets.length}>
                {isRecognizing ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}
                {isRecognizing ? '识别进行中...' : `开始识别未处理页 · ${getRecognizerLabel(recognizer)}`}
              </button>
              <button className="pill-button cream" type="button" onClick={onDeleteAll} disabled={isRecognizing || !sheets.length}><Trash2 size={16} />清空当前批次</button>
            </div>
          </article>
        </div>

        <div className="answer-stage-dashboard">
          <section className="editor-section compact-section">
            <div className="section-head compact-head">
              <div>
                <h4>学生汇总列表</h4>
                <p>按学生查看累计提交情况。选择题按整体进度累计，主观题按单题累计。</p>
              </div>
            </div>

            <div className="section-metrics">
              <div className="section-metric"><strong>{studentOverview.totalCount}</strong><span>班级人数</span></div>
              <div className="section-metric"><strong>{studentOverview.completeCount}</strong><span>已交齐</span></div>
              <div className="section-metric"><strong>{studentOverview.partialCount}</strong><span>待补交</span></div>
              <div className="section-metric"><strong>{studentOverview.reviewCount}</strong><span>待复核</span></div>
            </div>

            <div className="submission-note">姓名未识别的原始页不会卡住这里的学生汇总；它们会下沉到页面底部的原始页辅助区，等你需要时再处理。</div>

            {studentRecords.length ? (
              <div className="student-progress-list">
                {studentRecords.map((record) => {
                  const statusMeta = getStudentStatusMeta(record.status);
                  const units = buildStudentSubmissionUnits(record, choiceQuestionNos, subjectiveQuestionNos);

                  return (
                    <div
                      key={record.id}
                      className={`student-progress-item ${selectedStudentId === record.id ? 'active' : ''}`}
                      onClick={() => setSelectedStudentId(record.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedStudentId(record.id);
                        }
                      }}
                    >
                      <div className="student-progress-head">
                        <div>
                          <strong>{record.studentName}</strong>
                          <div className="student-progress-meta">
                            <span>{record.isExtra ? '名单外学生' : `已关联 ${record.sheetCount} 张来源页`}</span>
                            <span>最近更新 {formatDateLabel(record.updatedAt)}</span>
                            {record.warnings.length > 0 && <span>有 {record.warnings.length} 条提示</span>}
                          </div>
                        </div>
                        <span className={`status-pill ${statusMeta.tone}`}>{statusMeta.label}</span>
                      </div>

                      <div className="student-unit-grid">
                        {units.map((unit) => <span key={`${record.id}-${unit.key}`} className={`submission-chip ${unit.tone}`}><b>{unit.label}</b><small>{unit.detail}</small></span>)}
                      </div>

                      {record.sources.length > 0 && (
                        <div className="student-progress-meta">
                          <span>{record.sources.slice(0, 2).map((item) => item.label).join(' · ')}</span>
                          {record.sources.length > 2 && <span>另有 {record.sources.length - 2} 张</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : <div className="empty-inline">班级学生档案会在这里汇总显示。</div>}
          </section>

          <section className="editor-section compact-section">
            <div className="section-head compact-head">
              <div>
                <h4>题目缴纳情况</h4>
                <p>按题目看谁已经交齐、谁还没交，方便随时只阅某一道题、某几道题或只阅选择题。</p>
              </div>
            </div>

            {!classroomStudents.length && <div className="notice-inline warning">当前还没有选择班级，右侧暂时只能显示已识别名单，无法统计未交名单。</div>}

            {questionSubmissionCards.length ? (
              <div className="question-submission-stack">
                {questionSubmissionCards.map((card) => (
                  <article key={card.key} className="question-submission-card">
                    <div className="question-card-top">
                      <div><h5>{card.title}</h5><p>{card.subtitle}</p></div>
                      <div className="question-stat-wrap">
                        {card.statPills.map((item) => <span key={`${card.key}-${item.label}`} className={`question-stat-pill ${item.tone}`}><b>{item.value}</b><small>{item.label}</small></span>)}
                      </div>
                    </div>
                    <div className="question-name-group-stack">
                      {card.groups.map((group) => (
                        <section key={`${card.key}-${group.label}`} className="question-name-group">
                          <div className="question-name-group-head"><strong>{group.label}</strong><span>{group.names.length} 人</span></div>
                          <div className="name-pill-wrap">
                            {group.names.length ? group.names.map((name) => <span key={`${card.key}-${group.label}-${name}`} className={`name-pill ${group.tone}`}>{name}</span>) : <span className="name-pill muted">暂无</span>}
                          </div>
                        </section>
                      ))}
                    </div>
                    <div className="raw-page-note">{card.note}</div>
                  </article>
                ))}
              </div>
            ) : <div className="empty-inline">配置好题号后，这里会按“选择题 / 主观题第 X 题”显示缴纳情况。</div>}
          </section>
        </div>

        <section className="editor-section">
          <div className="section-head">
            <div>
              <h4>学生累计作答编辑区</h4>
              <p>这里编辑的是该学生目前累计收到的最终作答。保存后，后续补交的新页仍会继续并入这里。</p>
            </div>
            {selectedStudent && <button className="pill-button mint" type="button" onClick={() => onSaveEdits(selectedStudent.id)} disabled={isRecognizing}><Save size={16} />保存当前学生汇总</button>}
          </div>

          {selectedStudent ? (
            <div className="student-editor-card">
              <header className="student-result-header">
                <div>
                  <div className="student-result-title"><UserRound size={18} /><h5>{selectedStudent.studentName}</h5></div>
                  <p>{selectedStudent.sources.length ? `${selectedStudent.sources.length} 张来源页 · 最近更新 ${formatDateLabel(selectedStudent.updatedAt)}` : '当前还没有关联到任何答题页'}</p>
                </div>
                <span className={`status-pill ${getStudentStatusMeta(selectedStudent.status).tone}`}>{getStudentStatusMeta(selectedStudent.status).label}</span>
              </header>

              {selectedStudent.sources.length > 0 && (
                <section className="student-result-section">
                  <div className="student-result-section-head"><strong>来源页</strong><span>新页补进来后会继续出现在这里</span></div>
                  <div className="source-chip-wrap">
                    {selectedStudent.sources.map((source) => <span key={`${selectedStudent.id}-${source.sheetId}`} className="source-chip">{source.label}</span>)}
                  </div>
                </section>
              )}

              {task.mode !== 'subjective' && (
                <section className="student-result-section">
                  <div className="student-result-section-head"><strong>选择题累计作答</strong><span>“尚未收到”表示这道题还没在任何已收页里出现过。</span></div>
                  <div className="choice-edit-grid">
                    {sortByQuestionNo(selectedStudent.choiceAnswers).map((item) => {
                      const stateMeta = getAnswerStateMeta(item.state);
                      return (
                        <label key={`${selectedStudent.id}-${item.questionNo}`} className="choice-edit-item">
                          <div className="choice-edit-item-head"><span>{item.questionNo}</span><b className={`answer-state-badge ${stateMeta.tone}`}>{stateMeta.label}</b></div>
                          <select value={item.answer} onChange={(event) => onEditChoiceAnswer(selectedStudent.id, item.questionNo, event.target.value)} disabled={isRecognizing}>
                            <option value="">空</option>
                            <option value="A">A</option>
                            <option value="B">B</option>
                            <option value="C">C</option>
                            <option value="D">D</option>
                          </select>
                        </label>
                      );
                    })}
                  </div>
                </section>
              )}

              {task.mode !== 'choice' && (
                <section className="student-result-section">
                  <div className="student-result-section-head"><strong>主观题累计作答</strong><span>如果某题状态仍是“尚未收到”，说明这道题对应的页面还没交来。</span></div>
                  <div className="subjective-edit-stack">
                    {sortByQuestionNo(selectedStudent.subjectiveAnswers).map((item) => {
                      const stateMeta = getAnswerStateMeta(item.state);
                      return (
                        <article key={`${selectedStudent.id}-${item.questionNo}`} className="subjective-edit-card">
                          <div className="subjective-answer-head"><strong>第 {item.questionNo} 题</strong><span>{stateMeta.label}{item.sourceLabels.length ? ` · ${item.sourceLabels.join('、')}` : ''}</span></div>
                          <textarea rows={6} value={item.content} onChange={(event) => onEditSubjectiveAnswer(selectedStudent.id, item.questionNo, event.target.value)} placeholder="这里填写该学生这道题目前累计确认后的最终作答" disabled={isRecognizing} />
                        </article>
                      );
                    })}
                  </div>
                </section>
              )}

              {selectedStudent.warnings.length > 0 && (
                <div className="result-warning-list">
                  <div className="student-result-section-head"><strong>汇总提醒</strong><span>这些提示通常意味着需要人工确认后再进入阅卷。</span></div>
                  {selectedStudent.warnings.map((warning, index) => <div key={`${selectedStudent.id}-warning-${index}`} className="result-warning-box"><AlertCircle size={16} /><span>{warning}</span></div>)}
                </div>
              )}

              {selectedStudent.status === 'ready' && selectedStudent.warnings.length === 0 && (
                <div className="result-success-box"><CheckCircle2 size={16} /><span>该学生当前累计作答已经整理完成，后续可以直接进入阅卷；如果再补交新页，也会继续并入这里。</span></div>
              )}
            </div>
          ) : <div className="empty-inline">请先在上面的学生汇总列表中选择一名学生。</div>}
        </section>

        <section className="editor-section">
          <div className="section-head">
            <div>
              <h4>原始页辅助区</h4>
              <p>这里保留每一张原始页。姓名识别失败不会阻塞主视图，完全无效的页可以直接忽略或删除。</p>
            </div>
          </div>

          <div className="raw-page-grid">
            <article className="raw-page-card">
              <div className="raw-page-card-head"><div className="soft-card-title"><AlertCircle size={18} />待归属原始页</div><span>{unresolvedSheets.length} 张</span></div>
              <p>这里只放姓名未识别、或识别出的姓名不在班级名单里的页面。它们不会进入上面的学生汇总。</p>
              {renderSheetList(unresolvedSheets, '当前没有待归属原始页。')}
            </article>

            <article className="raw-page-card">
              <div className="raw-page-card-head"><div className="soft-card-title"><FileStack size={18} />全部原始页</div><span>{sheets.length} 张</span></div>
              <p>需要重识别、改名或删除时，在这里操作即可。</p>
              {renderSheetList(sheets, '还没有上传学生答题卡。上传后，这里会保留每一张原始页。')}
            </article>
          </div>
        </section>
      </fieldset>
    </>
  );
}
