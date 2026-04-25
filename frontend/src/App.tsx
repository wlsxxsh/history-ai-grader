import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  BookOpenText,
  Brain,
  ClipboardCheck,
  FolderPlus,
  Layers3,
  LoaderCircle,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react';
import {
  createTask,
  clearChoiceExplanations,
  deleteAnswerSheet as deleteStudentAnswerSheet,
  deleteTask,
  deleteTaskUpload as deleteUploadedTaskFile,
  extractMaterials,
  exportChoiceExplanationDocx,
  fetchAnswerSheetBatchJob,
  fetchHealth,
  fetchSettings,
  fetchTask,
  fetchTasks,
  generateChoiceExplanations,
  recognizeAnswerSheet as recognizeStudentAnswerSheet,
  recognizeAnswerSheetsBatch,
  runChoiceGrading as runTaskChoiceGrading,
  runSettingsMaintenance,
  saveSettings,
  saveTaskBasic,
  saveTaskQuestions,
  testModelConnection,
  updateAnswerSheet as updateStudentAnswerSheet,
  updateStudentRecord,
  uploadAnswerSheets,
  uploadTaskFiles,
} from './api';
import { AnswerSheetStage } from './components/AnswerSheetStage';
import type { AnswerSheetRecognizerOption } from './components/AnswerSheetStage';
import { EssayQuestionEditor } from './components/EssayQuestionEditor';
import { OrdinaryQuestionEditor } from './components/OrdinaryQuestionEditor';
import { ChoiceGradingStage } from './components/ChoiceGradingStage';
import { SubjectiveGradingStage } from './components/SubjectiveGradingStage';
import { createEmptyEssayRuleTree, ensureEssayQuestionShape, getEssayRuleTreeTotalScore } from './essayRuleTree';
import { createEmptyOrdinaryRuleTree, ensureOrdinaryQuestionShape, getOrdinaryRuleTreeTotalScore } from './gradingRuleTree';
import type {
  AppSettings,
  AnswerSheetBatchJob,
  ExtractModelProfile,
  QuestionDraft,
  TaskDetail,
  TaskMode,
  TaskSummary,
  UploadKind,
} from './types';


const ORDINARY_RULE_TEXT = `普通型主观题
1. 先理解题目，再结合参考答案评分。
2. 只依据学生原文给分，不补写学生未表达的观点。
3. 命中采分点即可得分，表述接近也可酌情给分。
4. 轻微史实错误可酌情扣分，严重错误应影响对应要点得分。
5. 单题阅卷要求优先于通用规则。`;

const ESSAY_RULE_TEXT = `论述题
1. 按“论题 - 论述过程 - 结论”结构评分。
2. 先判断是否有明确论题，再判断是否切题、是否成立。
3. 重点检查是否围绕论题展开、是否有史实支撑、分析是否合理、史实是否准确。
4. 结论部分检查是否有总结和升华。
5. 只依据学生原文评分，不替学生补写观点。`;

const defaultSettings: AppSettings = {
  generalProvider: 'doubao',
  generalApiKey: '',
  generalModel: 'doubao-seed-2-0-pro-260215',
  answerSheetProvider: 'siliconflow',
  answerSheetApiKey: '',
  answerSheetModel: 'PaddlePaddle/PaddleOCR-VL',
  subjectiveGradingProvider: 'siliconflow',
  subjectiveGradingApiKey: '',
  subjectiveGradingModel: 'Pro/deepseek-ai/DeepSeek-R1',
  apiBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  answerSheetBatchConcurrency: 2,
  rolePreset: 'objective',
  customRolePrompt: '',
  subjectiveOrdinaryRulePrompt: ORDINARY_RULE_TEXT,
  subjectiveEssayRulePrompt: ESSAY_RULE_TEXT,
  classrooms: [],
};

const ANSWER_SHEET_MODEL_OPTIONS: readonly string[] = [
  'PaddlePaddle/PaddleOCR-VL',
  'zai-org/GLM-4.6V',
  'Pro/moonshotai/Kimi-K2.5',
  'Qwen/Qwen3.5-397B-A17B',
];

const GENERAL_MODEL_OPTIONS: readonly string[] = [
  'doubao-seed-2-0-pro-260215',
  'doubao-seed-2-0-lite-260215',
];

const SUBJECTIVE_GRADING_MODEL_OPTIONS: readonly string[] = [
  'Pro/deepseek-ai/DeepSeek-R1',
  'Pro/zai-org/GLM-5',
  'zai-org/GLM-4.6',
  'Pro/moonshotai/Kimi-K2.5',
  'moonshotai/Kimi-K2-Instruct-0905',
  'Pro/moonshotai/Kimi-K2-Instruct-0905',
  'Qwen/Qwen3.5-397B-A17B',
];

const stepTabs = [
  { id: 'basic', label: '步骤 1 基本信息', icon: Sparkles },
  { id: 'question', label: '步骤 2 题目配置', icon: BookOpenText },
  { id: 'ocr', label: '步骤 3 答题卡识别', icon: Upload },
  { id: 'review', label: '步骤 4 选择题批阅', icon: ClipboardCheck },
  { id: 'grading', label: '步骤 5 主观题批阅', icon: Brain },
] as const;

type StepId = (typeof stepTabs)[number]['id'];
type ConnectionTestTarget = 'general' | 'answerSheet' | 'subjectiveGrading';
const studentNameSplitPattern = /[\s,\uFF0C\u3001\uFF1B;]+/;

function pickModelOption(value: string | undefined, options: readonly string[], fallback: string) {
  const nextValue = String(value ?? '').trim();
  return options.includes(nextValue) ? nextValue : fallback;
}

function hydrateSettings(payload?: Partial<AppSettings> | null): AppSettings {
  return {
    ...defaultSettings,
    ...(payload ?? {}),
    generalModel: pickModelOption(
      payload?.generalModel,
      GENERAL_MODEL_OPTIONS,
      defaultSettings.generalModel,
    ),
    answerSheetModel: pickModelOption(
      payload?.answerSheetModel,
      ANSWER_SHEET_MODEL_OPTIONS,
      defaultSettings.answerSheetModel,
    ),
    subjectiveGradingModel: pickModelOption(
      payload?.subjectiveGradingModel,
      SUBJECTIVE_GRADING_MODEL_OPTIONS,
      defaultSettings.subjectiveGradingModel,
    ),
    answerSheetBatchConcurrency: Number.isFinite(Number(payload?.answerSheetBatchConcurrency))
      ? Math.max(1, Math.min(6, Math.floor(Number(payload?.answerSheetBatchConcurrency))))
      : defaultSettings.answerSheetBatchConcurrency,
    subjectiveOrdinaryRulePrompt: payload?.subjectiveOrdinaryRulePrompt || defaultSettings.subjectiveOrdinaryRulePrompt,
    subjectiveEssayRulePrompt: payload?.subjectiveEssayRulePrompt || defaultSettings.subjectiveEssayRulePrompt,
    classrooms: payload?.classrooms?.length ? payload.classrooms : defaultSettings.classrooms,
  };
}

function formatDateLabel(value: string) {
  if (!value) return '尚未保存';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function getModeLabel(mode: TaskMode) {
  if (mode === 'choice') return '选择题批阅';
  if (mode === 'subjective') return '主观题批阅';
  return '综合批阅';
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

function sortNamesByPinyin(names: string[]) {
  const collator = new Intl.Collator('zh-CN-u-co-pinyin');
  return [...names].sort((a, b) => collator.compare(a, b));
}

function splitStudentNames(value: string) {
  return Array.from(
    new Set(
      String(value ?? '')
        .split(studentNameSplitPattern)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeClassroomName(value: string) {
  return String(value ?? '')
    .replace(/[\s()\[\]{}\uFF08\uFF09\u3010\u3011]+/g, '')
    .toLowerCase();
}

function findMatchingClassroom(classrooms: AppSettings['classrooms'], className: string | undefined) {
  const rawName = String(className ?? '').trim();
  if (!rawName) return null;

  const exactMatch = classrooms.find((item) => String(item.name ?? '').trim() === rawName);
  if (exactMatch) return exactMatch;

  const normalizedTarget = normalizeClassroomName(rawName);
  if (!normalizedTarget) return null;

  return classrooms.find((item) => normalizeClassroomName(item.name) === normalizedTarget) ?? null;
}

function normalizeText(value: string) {
  return String(value || '').replace(/\r/g, '').trim();
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

function buildRecognitionConfigSignature(task: TaskDetail | null) {
  if (!task) return '';

  const questionHints = [...(task.questions ?? [])]
    .map((question) => ({
      questionNo: normalizeText(question.questionNo),
      type: question.type,
    }))
    .filter((question) => question.questionNo)
    .sort((left, right) => {
      const questionNoCompare = compareQuestionNo(left.questionNo, right.questionNo);
      return questionNoCompare || left.type.localeCompare(right.type);
    });

  return JSON.stringify({
    mode: task.mode,
    className: normalizeText(task.className),
    questionHints,
  });
}

function buildEmptyQuestion(type: QuestionDraft['type'], questionNo: string): QuestionDraft {
  const baseQuestion: QuestionDraft = {
    id: crypto.randomUUID(),
    questionNo,
    type,
    score: type === 'choice' ? 2 : 10,
    content: '',
    standardAnswer: '',
    analysis: '',
    gradingRule: '',
    gradingRuleTree: type === 'subjective' ? createEmptyOrdinaryRuleTree(10) : null,
    essayRuleTree: type === 'essay' ? createEmptyEssayRuleTree() : null,
    tags: [],
    enabled: true,
    source: 'manual',
  };

  if (type === 'subjective') {
    return ensureOrdinaryQuestionShape(baseQuestion);
  }
  if (type === 'essay') {
    return ensureEssayQuestionShape(baseQuestion);
  }
  return baseQuestion;
}

function getNextQuestionNo(questions: QuestionDraft[]) {
  const values = questions.map((item) => Number(item.questionNo)).filter((item) => Number.isFinite(item));
  return String((values.length ? Math.max(...values) : 0) + 1);
}

function normalizeQuestionsForMode(mode: TaskMode, questions: QuestionDraft[]) {
  if (mode === 'choice') {
    return questions.map((item, index) => ({
      ...item,
      questionNo: item.questionNo || String(index + 1),
      type: 'choice' as const,
      score: item.score || 2,
      content: '',
      analysis: '',
      gradingRule: '',
    }));
  }

  if (mode === 'subjective') {
    return questions.map((item, index) => {
      const normalizedQuestion = item.type === 'essay' ? ensureEssayQuestionShape(item) : ensureOrdinaryQuestionShape(item);
      return {
        ...normalizedQuestion,
        questionNo: item.questionNo || String(index + 1),
        type: (item.type === 'essay' ? 'essay' : 'subjective') as QuestionDraft['type'],
        score: item.type === 'essay'
          ? (getEssayRuleTreeTotalScore(normalizedQuestion.essayRuleTree) || normalizedQuestion.score || 10)
          : (getOrdinaryRuleTreeTotalScore(normalizedQuestion.gradingRuleTree) || normalizedQuestion.score || 10),
      };
    });
  }

  return questions.map((item, index) => ({
    ...(item.type === 'subjective' ? ensureOrdinaryQuestionShape(item) : item.type === 'essay' ? ensureEssayQuestionShape(item) : item),
    questionNo: item.questionNo || String(index + 1),
    type: (item.type || 'subjective') as QuestionDraft['type'],
  }));
}

export default function App() {
  const [health, setHealth] = useState('正在连接本地服务...');
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [activeTask, setActiveTask] = useState<TaskDetail | null>(null);
  const [persistedTask, setPersistedTask] = useState<TaskDetail | null>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeStep, setActiveStep] = useState<StepId>('basic');
  const [appBusyText, setAppBusyText] = useState('');
  const [questionBusyText, setQuestionBusyText] = useState('');
  const [answerSheetBusyText, setAnswerSheetBusyText] = useState('');
  const [toast, setToast] = useState('');
  const [testResult, setTestResult] = useState('');
  const [extractProfile, setExtractProfile] = useState<ExtractModelProfile>('general');
  const [choiceScoreValue, setChoiceScoreValue] = useState('2');
  const [ocrRecognizer, setOcrRecognizer] = useState<AnswerSheetRecognizerOption>('general');
  const [answerSheetRetainQuestionNosText, setAnswerSheetRetainQuestionNosText] = useState('');
  const [isRecognizingSheets, setIsRecognizingSheets] = useState(false);
  const [isRunningChoiceGrading, setIsRunningChoiceGrading] = useState(false);
  const [isGeneratingChoiceExplanation, setIsGeneratingChoiceExplanation] = useState(false);
  const [isExportingChoiceExplanation, setIsExportingChoiceExplanation] = useState(false);
  const activeTaskRef = useRef<TaskDetail | null>(null);

  function setTaskDraft(next: TaskDetail | null | ((current: TaskDetail | null) => TaskDetail | null)) {
    setActiveTask((current) => {
      const resolved = typeof next === 'function' ? (next as (current: TaskDetail | null) => TaskDetail | null)(current) : next;
      activeTaskRef.current = resolved;
      return resolved;
    });
  }

  function setLoadedTask(detail: TaskDetail | null) {
    activeTaskRef.current = detail;
    setActiveTask(detail);
    setPersistedTask(detail);
  }

  useEffect(() => {
    activeTaskRef.current = activeTask;
  }, [activeTask]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (toast) setToast('');
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const [healthPayload, settingsPayload, taskList] = await Promise.all([fetchHealth(), fetchSettings(), fetchTasks()]);
        if (cancelled) return;

        setHealth(`服务在线 · ${formatDateLabel(healthPayload.now)}`);
        const hydrated = hydrateSettings(settingsPayload);
        setSettings(hydrated);
        setTasks(taskList);

        if (taskList[0]) {
          const detail = await fetchTask(taskList[0].id);
          if (!cancelled) {
            setLoadedTask(detail);
          }
        }
      } catch (error) {
        if (!cancelled) {
          const message = getErrorMessage(error);
          setHealth(`服务异常 · ${message}`);
          setToast(message);
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen) return undefined;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false);
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [settingsOpen]);

  useEffect(() => {
    setAnswerSheetRetainQuestionNosText('');
  }, [activeTask?.id]);

  const selectedClassroom = useMemo(
    () => findMatchingClassroom(settings.classrooms, activeTask?.className),
    [activeTask?.className, settings.classrooms],
  );

  const sortedClassroomStudents = useMemo(
    () => sortNamesByPinyin(splitStudentNames(selectedClassroom?.studentsText ?? '')),
    [selectedClassroom?.studentsText],
  );

  const questionRows = useMemo(() => {
    const rows = (activeTask?.questions ?? [])
      .map((question, index) => ({ question, index }))
      .sort((left, right) => compareQuestionNo(left.question.questionNo, right.question.questionNo));

    return {
      choice: rows.filter((item) => item.question.type === 'choice'),
      subjective: rows.filter((item) => item.question.type !== 'choice'),
    };
  }, [activeTask?.questions]);

  const uploadSummary = useMemo(() => {
    const uploads = activeTask?.uploads ?? [];
    return {
      question: uploads.filter((item) => item.kind === 'question'),
      answer: uploads.filter((item) => item.kind === 'answer'),
    };
  }, [activeTask?.uploads]);

  const isQuestionStageBusy = Boolean(questionBusyText);
  const isQuestionStageLocked = Boolean(appBusyText) || isQuestionStageBusy;
  const hasSavedQuestionConfig = useMemo(
    () => Boolean((persistedTask?.questions ?? []).some((question) => normalizeText(question.questionNo))),
    [persistedTask],
  );
  const hasUnsavedRecognitionConfig = useMemo(() => {
    if (!activeTask || !persistedTask || activeTask.id !== persistedTask.id) {
      return false;
    }

    return buildRecognitionConfigSignature(activeTask) !== buildRecognitionConfigSignature(persistedTask);
  }, [activeTask, persistedTask]);
  const questionConfigStatus = useMemo<'ready' | 'unconfigured' | 'updating' | 'unsaved'>(() => {
    if (!hasSavedQuestionConfig) return 'unconfigured';
    if (isQuestionStageBusy) return 'updating';
    if (hasUnsavedRecognitionConfig) return 'unsaved';
    return 'ready';
  }, [hasSavedQuestionConfig, hasUnsavedRecognitionConfig, isQuestionStageBusy]);
  const answerSheetStageTask = useMemo(() => {
    if (!activeTask) return null;
    if (!persistedTask || activeTask.id !== persistedTask.id) return activeTask;

    return {
      ...activeTask,
      className: persistedTask.className,
      mode: persistedTask.mode,
      questions: persistedTask.questions,
    };
  }, [activeTask, persistedTask]);
  const answerSheetClassroom = useMemo(
    () => findMatchingClassroom(settings.classrooms, answerSheetStageTask?.className),
    [answerSheetStageTask?.className, settings.classrooms],
  );
  const answerSheetClassroomStudents = useMemo(
    () => sortNamesByPinyin(splitStudentNames(answerSheetClassroom?.studentsText ?? '')),
    [answerSheetClassroom?.studentsText],
  );
  const retainedAnswerSheetQuestionNos = useMemo(
    () => parseQuestionNosText(answerSheetRetainQuestionNosText),
    [answerSheetRetainQuestionNosText],
  );
  const busyMessages = useMemo(
    () =>
      [
        appBusyText ? { key: 'app', text: appBusyText } : null,
        questionBusyText ? { key: 'question', text: `步骤 2：${questionBusyText}` } : null,
        answerSheetBusyText ? { key: 'answer-sheet', text: `步骤 3：${answerSheetBusyText}` } : null,
      ].filter((item): item is { key: string; text: string } => item !== null),
    [appBusyText, questionBusyText, answerSheetBusyText],
  );

  async function refreshTaskList() {
    setTasks(await fetchTasks());
  }

  async function loadTaskDetail(taskId: string) {
    const detail = await fetchTask(taskId);
    setLoadedTask(detail);
    return detail;
  }

  async function refreshTask(taskId: string) {
    const detail = await loadTaskDetail(taskId);
    await refreshTaskList();
    return detail;
  }

  async function waitForAnswerSheetBatchJob(taskId: string, initialJob: AnswerSheetBatchJob) {
    let job = initialJob;
    let lastProcessedCount = -1;
    let lastStatus = '';

    while (true) {
      if (job.processedCount !== lastProcessedCount || job.status !== lastStatus) {
        const workerCount = job.workerCount || settings.answerSheetBatchConcurrency;
        setAnswerSheetBusyText(
          job.status === 'queued'
            ? `已启动后台识别任务，准备处理 ${job.requestedCount} 张答题卡（${workerCount} 路并发）...`
            : `正在后台识别 ${job.processedCount}/${job.requestedCount} 张答题卡（${workerCount} 路并发）...`,
        );
        await refreshTask(taskId);
        lastProcessedCount = job.processedCount;
        lastStatus = job.status;
      }

      if (job.status === 'completed' || job.status === 'failed') {
        return job;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      job = (await fetchAnswerSheetBatchJob(taskId, job.id)).job;
    }
  }

  function updateTaskDraft(patch: Partial<TaskDetail>) {
    setTaskDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function updateTaskMode(mode: TaskMode) {
    setTaskDraft((current) =>
      current
        ? {
            ...current,
            mode,
            questions: normalizeQuestionsForMode(mode, current.questions),
          }
        : current,
    );
  }

  function updateQuestion(index: number, patch: Partial<QuestionDraft>) {
    setTaskDraft((current) => {
      if (!current) return current;
      const questions = [...current.questions];
      const nextQuestion = { ...questions[index], ...patch, source: patch.source ?? 'manual' };
      questions[index] = nextQuestion.type === 'subjective'
        ? ensureOrdinaryQuestionShape(nextQuestion)
        : nextQuestion.type === 'essay'
          ? ensureEssayQuestionShape(nextQuestion, { preserveDraftRows: true })
          : nextQuestion;
      return { ...current, questions };
    });
  }

  function appendQuestion(type: QuestionDraft['type']) {
    setTaskDraft((current) =>
      current
        ? {
            ...current,
            questions: [...current.questions, buildEmptyQuestion(type, getNextQuestionNo(current.questions))],
          }
        : current,
    );
  }

  function removeQuestion(index: number) {
    setTaskDraft((current) => {
      if (!current) return current;
      const target = current.questions[index];
      if (!target) return current;

      const questions = current.questions.filter((_, questionIndex) => questionIndex !== index);
      return { ...current, questions };
    });
    setToast('主观题已从当前配置中移除，保存题目配置后生效。');
  }

  function applyChoiceScoreToAll() {
    const score = Number(choiceScoreValue);
    if (!Number.isFinite(score)) {
      setToast('请先填写有效的统一分值。');
      return;
    }

    setTaskDraft((current) =>
      current
        ? {
            ...current,
            questions: current.questions.map((item) => (item.type === 'choice' ? { ...item, score } : item)),
          }
        : current,
    );
    setToast('选择题分值已统一更新。');
  }

  function getRecognizerPayload(
    value: AnswerSheetRecognizerOption,
    retainQuestionNos: string[],
  ): { engine: 'doubao'; profile: AnswerSheetRecognizerOption; retainQuestionNos?: string[] } {
    const profile = value === 'answerSheet' ? 'answerSheet' : 'general';
    return retainQuestionNos.length ? { engine: 'doubao', profile, retainQuestionNos } : { engine: 'doubao', profile };
  }

  async function flushPendingTaskEdits() {
    if (typeof document === 'undefined') return;

    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName)) {
      flushSync(() => {
        activeElement.blur();
      });
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  }

  async function handleCreateTask(mode: TaskMode) {
    try {
      setAppBusyText('正在新建任务...');
      const task = await createTask(mode);
      setLoadedTask(task);
      await refreshTaskList();
      setActiveStep('basic');
      setToast('新任务已经准备好了。');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAppBusyText('');
    }
  }

  async function handleSaveTask() {
    if (!activeTaskRef.current) return;

    try {
      await flushPendingTaskEdits();
      const taskToSave = activeTaskRef.current;
      if (!taskToSave) return;
      const questionsToSave = normalizeQuestionsForMode(taskToSave.mode, taskToSave.questions);

      activeTaskRef.current = {
        ...taskToSave,
        questions: questionsToSave,
      };
      setActiveTask((current) => (current && current.id === taskToSave.id ? { ...current, questions: questionsToSave } : current));

      setAppBusyText('正在保存任务...');
      await saveTaskBasic(activeTaskRef.current.id, {
        name: activeTaskRef.current.name,
        className: activeTaskRef.current.className,
        homeworkDate: activeTaskRef.current.homeworkDate,
        mode: activeTaskRef.current.mode,
        questionScope: activeTaskRef.current.questionScope,
        description: activeTaskRef.current.description,
      });
      await saveTaskQuestions(activeTaskRef.current.id, questionsToSave);
      await refreshTask(activeTaskRef.current.id);
      setToast('任务已保存。');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAppBusyText('');
    }
  }

  async function handleOpenTask(taskId: string) {
    try {
      setAppBusyText('正在打开任务...');
      await refreshTask(taskId);
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAppBusyText('');
    }
  }

  async function handleDeleteTask(taskId: string) {
    if (!window.confirm('确定要删除这个任务吗？对应的题目配置、上传文件和答题卡也会一起删除。')) {
      return;
    }

    try {
      setAppBusyText('正在删除任务...');
      await deleteTask(taskId);
      const taskList = await fetchTasks();
      setTasks(taskList);

      if (activeTask?.id === taskId) {
        setLoadedTask(taskList[0] ? await fetchTask(taskList[0].id) : null);
      }

      setToast('任务已删除。');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAppBusyText('');
    }
  }

  async function handleSaveSettings() {
    try {
      setAppBusyText('正在保存后台设置...');
      const saved = await saveSettings(settings);
      setSettings(hydrateSettings(saved));
      setSettingsOpen(false);
      setToast('后台设置已保存。');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAppBusyText('');
    }
  }

  async function handleConnectionTest(target: ConnectionTestTarget) {
    const labelMap: Record<ConnectionTestTarget, string> = {
      general: '综合',
      answerSheet: '答题卡专用',
      subjectiveGrading: '阅卷专用',
    };
    const label = labelMap[target];

    try {
      setAppBusyText(`正在测试${label}模型连接...`);
      const result = await testModelConnection(target);
      setTestResult(`[${label}] ${result.message}\n${result.preview}`);
      setToast(`${label}模型连接成功。`);
    } catch (error) {
      const message = getErrorMessage(error);
      setTestResult(message);
      setToast(message);
    } finally {
      setAppBusyText('');
    }
  }

  async function handleRunSettingsMaintenance(scope: 'cache' | 'data') {
    const confirmText =
      scope === 'cache'
        ? '确定要清理缓存吗？这会清理临时文件、日志和模型缓存，不会删除任务数据。'
        : '确定要清空数据吗？这会删除所有任务、题目、上传文件与批改结果，但会保留后台设置。';
    if (!window.confirm(confirmText)) {
      return;
    }

    try {
      setAppBusyText(scope === 'cache' ? '正在清理缓存...' : '正在清空数据...');
      const result = await runSettingsMaintenance(scope);

      if (scope === 'data') {
        const taskList = await fetchTasks();
        setTasks(taskList);
        setLoadedTask(taskList[0] ? await fetchTask(taskList[0].id) : null);
      }

      setToast(result.message || (scope === 'cache' ? '缓存已清理。' : '数据已清空。'));
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAppBusyText('');
    }
  }

  async function handleUpload(kind: UploadKind, fileList: FileList | null) {
    if (!activeTask || !fileList?.length) return;

    try {
      setQuestionBusyText(kind === 'question' ? '正在上传题目文件...' : '正在上传参考答案文件...');
      await uploadTaskFiles(activeTask.id, kind, Array.from(fileList));
      await refreshTask(activeTask.id);
      setToast(kind === 'question' ? '题目文件已上传。' : '参考答案文件已上传。');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setQuestionBusyText('');
    }
  }

  async function handleDeleteUploads(
    uploadIds: string[],
    options: { confirmText: string; busy: string; success: string },
  ) {
    if (!activeTask || !uploadIds.length) return;
    if (!window.confirm(options.confirmText)) return;

    try {
      setQuestionBusyText(options.busy);
      for (const uploadId of uploadIds) {
        await deleteUploadedTaskFile(activeTask.id, uploadId);
      }
      await refreshTask(activeTask.id);
      setToast(options.success);
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setQuestionBusyText('');
    }
  }

  async function handleDeleteUpload(uploadId: string) {
    await handleDeleteUploads([uploadId], {
      confirmText: '确定删除这个已上传文件吗？删除后需要重新上传才能再次识别。',
      busy: '正在删除上传文件...',
      success: '上传文件已删除。',
    });
  }

  async function handleDeleteUploadsByKind(kind: UploadKind) {
    if (!activeTask) return;
    const targets = activeTask.uploads.filter((item) => item.kind === kind).map((item) => item.id);
    if (!targets.length) return;

    await handleDeleteUploads(targets, {
      confirmText: `确定清空当前任务下的全部${kind === 'question' ? '题目' : '答案'}文件吗？`,
      busy: `正在删除${kind === 'question' ? '题目' : '答案'}文件...`,
      success: `${kind === 'question' ? '题目' : '答案'}文件已清空。`,
    });
  }

  async function handleDeleteAllTaskUploads() {
    if (!activeTask?.uploads.length) return;

    await handleDeleteUploads(
      activeTask.uploads.map((item) => item.id),
      {
        confirmText: '确定清空当前任务下的全部上传文件吗？',
        busy: '正在清空上传文件...',
        success: '上传文件已清空。',
      },
    );
  }

  async function handleExtract() {
    if (!activeTask) return;

    try {
      const hasQuestionUploads = uploadSummary.question.length > 0;
      const hasAnswerUploads = uploadSummary.answer.length > 0;
      const extractBusyText =
        hasQuestionUploads && hasAnswerUploads
          ? '正在并行识别题目与参考答案...'
          : hasQuestionUploads
            ? '正在识别题目并填充配置...'
            : '正在识别参考答案并填充配置...';

      setQuestionBusyText(extractBusyText);
      const result = await extractMaterials(activeTask.id, extractProfile);
      await refreshTask(activeTask.id);
      setToast(result.warnings.length ? `题目已识别，另有 ${result.warnings.length} 条提示。` : '题目配置已自动填充。');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setQuestionBusyText('');
    }
  }

  async function handleRunChoiceGrading() {
    if (!activeTask) return;

    try {
      setIsRunningChoiceGrading(true);
      setAppBusyText('正在批阅选择题...');
      const result = await runTaskChoiceGrading(activeTask.id);
      setLoadedTask(result.task);
      await refreshTaskList();
      setActiveStep('review');
      setToast('选择题批阅结果已更新。');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAppBusyText('');
      setIsRunningChoiceGrading(false);
    }
  }

  async function handleGenerateChoiceExplanation(payload: { threshold: number; selectedQuestionNos: string[] }) {
    if (!activeTask) return;

    try {
      setIsGeneratingChoiceExplanation(true);
      setAppBusyText('正在生成选择题详细解析...');
      const result = await generateChoiceExplanations(activeTask.id, {
        profile: 'general',
        threshold: payload.threshold,
        selectedQuestionNos: payload.selectedQuestionNos,
      });
      setLoadedTask(result.task);
      await refreshTaskList();
      setToast('选择题详细解析已生成。');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAppBusyText('');
      setIsGeneratingChoiceExplanation(false);
    }
  }

  async function handleClearChoiceExplanation() {
    if (!activeTask) return;

    try {
      setIsGeneratingChoiceExplanation(true);
      setAppBusyText('正在清空选择题详细解析...');
      const result = await clearChoiceExplanations(activeTask.id);
      setLoadedTask(result.task);
      await refreshTaskList();
      setToast('选择题详细解析已清空。');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAppBusyText('');
      setIsGeneratingChoiceExplanation(false);
    }
  }

  async function handleExportChoiceExplanation() {
    if (!activeTask) return;

    try {
      setIsExportingChoiceExplanation(true);
      setAppBusyText('正在导出选择题解析 DOCX...');
      const result = await exportChoiceExplanationDocx(activeTask.id);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setToast('选择题解析 DOCX 已开始下载。');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAppBusyText('');
      setIsExportingChoiceExplanation(false);
    }
  }

  async function handleUploadAnswerSheets(fileList: FileList | null) {
    if (!activeTask || !fileList?.length) return;

    try {
      setAnswerSheetBusyText('正在上传学生答题卡...');
      await uploadAnswerSheets(activeTask.id, Array.from(fileList));
      await refreshTask(activeTask.id);
      setToast('答题卡已上传。');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAnswerSheetBusyText('');
    }
  }

  async function handleRecognizeOneAnswerSheet(sheetId: string) {
    if (!activeTask) return;

    try {
      setIsRecognizingSheets(true);
      setAnswerSheetBusyText('正在识别这张答题卡...');
      await recognizeStudentAnswerSheet(
        activeTask.id,
        sheetId,
        getRecognizerPayload(ocrRecognizer, retainedAnswerSheetQuestionNos),
      );
      await refreshTask(activeTask.id);
      setToast('这张答题卡已重新识别。');
    } catch (error) {
      await refreshTask(activeTask.id);
      setToast(getErrorMessage(error));
    } finally {
      setAnswerSheetBusyText('');
      setIsRecognizingSheets(false);
    }
  }

  async function handleRecognizePendingSheets() {
    if (!activeTask) return;

    const pendingSheets = activeTask.answerSheets.filter((sheet) => sheet.status !== 'done');
    if (!pendingSheets.length) {
      setToast('当前没有待识别的答题卡。');
      return;
    }

    try {
      setIsRecognizingSheets(true);
      const taskId = activeTask.id;
      const payload = getRecognizerPayload(ocrRecognizer, retainedAnswerSheetQuestionNos);
      setAnswerSheetBusyText(`正在启动后台批量识别任务（${settings.answerSheetBatchConcurrency} 路并发）...`);
      const started = await recognizeAnswerSheetsBatch(taskId, {
        sheetIds: pendingSheets.map((sheet) => sheet.id),
        ...payload,
      });
      const result = await waitForAnswerSheetBatchJob(taskId, started.job);
      await refreshTask(taskId);
      await refreshTaskList();
      setToast(
        result.errorCount
          ? `识别完成：成功 ${result.successCount} 张，失败 ${result.errorCount} 张。`
          : `已识别 ${result.successCount} 张答题卡。`,
      );
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAnswerSheetBusyText('');
      setIsRecognizingSheets(false);
    }
  }

  async function handleDeleteAnswerSheet(sheetId: string) {
    if (!activeTask) return;
    if (!window.confirm('确定删除这张答题卡吗？')) return;

    try {
      setAnswerSheetBusyText('正在删除答题卡...');
      await deleteStudentAnswerSheet(activeTask.id, sheetId);
      await refreshTask(activeTask.id);
      setToast('答题卡已删除。');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAnswerSheetBusyText('');
    }
  }

  async function handleDeleteAllAnswerSheets() {
    if (!activeTask?.answerSheets.length) return;
    if (!window.confirm('确定清空当前任务下的全部学生答题卡吗？')) return;

    try {
      setAnswerSheetBusyText('正在清空学生答题卡...');
      for (const sheet of activeTask.answerSheets) {
        await deleteStudentAnswerSheet(activeTask.id, sheet.id);
      }
      await refreshTask(activeTask.id);
      setToast('学生答题卡已清空。');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAnswerSheetBusyText('');
    }
  }

  async function handleUpdateAnswerSheetName(sheetId: string, manualStudentName: string) {
    if (!activeTask) return;

    try {
      setAnswerSheetBusyText('正在更新答题卡归属...');
      await updateStudentAnswerSheet(activeTask.id, sheetId, { manualStudentName });
      await refreshTask(activeTask.id);
      setToast('答题卡归属已更新。');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAnswerSheetBusyText('');
    }
  }

  function handleEditChoiceAnswer(studentId: string, questionNo: string, answer: string) {
    setTaskDraft((current) => {
      if (!current) return current;
      const studentRecords = current.studentRecords.map((record) => {
        if (record.id !== studentId) return record;

        const nextAnswers = [...record.choiceAnswers];
        const index = nextAnswers.findIndex((item) => item.questionNo === questionNo);
        if (index >= 0) {
          nextAnswers[index] = { ...nextAnswers[index], answer };
        } else {
          nextAnswers.push({
            questionNo,
            answer,
            baseAnswer: '',
            state: 'manual',
            baseState: 'missing',
            hasOverride: true,
            sourceSheetIds: [],
            sourceLabels: [],
          });
          nextAnswers.sort((left, right) => compareQuestionNo(left.questionNo, right.questionNo));
        }

        return { ...record, choiceAnswers: nextAnswers };
      });
      return { ...current, studentRecords };
    });
  }

  function handleEditSubjectiveAnswer(studentId: string, questionNo: string, content: string) {
    setTaskDraft((current) => {
      if (!current) return current;
      const studentRecords = current.studentRecords.map((record) => {
        if (record.id !== studentId) return record;

        const nextAnswers = [...record.subjectiveAnswers];
        const index = nextAnswers.findIndex((item) => item.questionNo === questionNo);
        if (index >= 0) {
          nextAnswers[index] = { ...nextAnswers[index], content };
        } else {
          nextAnswers.push({
            questionNo,
            content,
            baseContent: '',
            state: 'manual',
            baseState: 'missing',
            hasOverride: true,
            sourceSheetIds: [],
            sourceLabels: [],
          });
          nextAnswers.sort((left, right) => compareQuestionNo(left.questionNo, right.questionNo));
        }

        return { ...record, subjectiveAnswers: nextAnswers };
      });
      return { ...current, studentRecords };
    });
  }

  async function handleSaveAnswerSheetEdits(studentId: string) {
    if (!activeTask) return;
    const student = activeTask.studentRecords.find((item) => item.id === studentId);
    if (!student) return;

    try {
      setAnswerSheetBusyText(`正在保存 ${student.studentName} 的汇总作答...`);
      const result = await updateStudentRecord(activeTask.id, {
        studentName: student.studentName,
        choiceOverrides: student.choiceAnswers
          .filter((item) => String(item.answer || '').trim() !== String(item.baseAnswer || '').trim())
          .map((item) => ({ questionNo: item.questionNo, answer: item.answer })),
        subjectiveOverrides: student.subjectiveAnswers
          .filter((item) => normalizeText(item.content) !== normalizeText(item.baseContent))
          .map((item) => ({ questionNo: item.questionNo, content: item.content })),
      });

      setTaskDraft((current) => (current ? { ...current, studentRecords: result.studentRecords } : current));
      await refreshTaskList();
      setToast(`${student.studentName} 的汇总作答已保存。`);
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setAnswerSheetBusyText('');
    }
  }

  function handleSubjectiveTaskUpdated(task: TaskDetail) {
    setLoadedTask(task);
  }

  function updateClassroom(index: number, patch: Partial<AppSettings['classrooms'][number]>) {
    setSettings((current) => {
      const classrooms = [...current.classrooms];
      classrooms[index] = { ...classrooms[index], ...patch };
      return { ...current, classrooms };
    });
  }

  function addClassroom() {
    setSettings((current) => ({
      ...current,
      classrooms: [...current.classrooms, { id: crypto.randomUUID(), name: '', studentsText: '' }],
    }));
  }

  function removeClassroom(id: string) {
    setSettings((current) => ({
      ...current,
      classrooms: current.classrooms.filter((item) => item.id !== id),
    }));
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <aside className="sidebar">
        <section className="brand-card">
          <div className="brand-badge">
            <Layers3 size={16} />
            历史批改工作台
          </div>
          <h1>历史批改工作台</h1>
          <p>使用 AI 自动识别并批阅历史作业。</p>
        </section>

        <section className="task-panel">
          <div className="panel-title-row">
            <h3>任务列表</h3>
            <span>{tasks.length} 个任务</span>
          </div>

          <div className="sidebar-actions">
            <button className="pill-button peach" type="button" onClick={() => void handleCreateTask('mixed')}>
              <FolderPlus size={16} />
              新建综合任务
            </button>
            <button className="pill-button mint" type="button" onClick={() => void handleCreateTask('subjective')}>
              <FolderPlus size={16} />
              新建主观题任务
            </button>
            <button className="pill-button cream" type="button" onClick={() => void handleCreateTask('choice')}>
              <FolderPlus size={16} />
              新建选择题任务
            </button>
          </div>

          <div className="task-list">
            {tasks.length ? (
              tasks.map((task) => (
                <button
                  key={task.id}
                  className={`task-card ${task.id === activeTask?.id ? 'active' : ''}`}
                  type="button"
                  onClick={() => void handleOpenTask(task.id)}
                >
                  <div className="task-card-top">
                    <strong>{task.name || '未命名任务'}</strong>
                    <div className="task-card-actions">
                      <span className="status-bubble">{getModeLabel(task.mode)}</span>
                      <button
                        className="task-delete-button"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDeleteTask(task.id);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <p>{task.className || '未选择班级'} · {task.questionCount} 题</p>
                  <div className="task-card-bottom">
                      <span>最近更新</span>
                    <strong>{formatDateLabel(task.updatedAt)}</strong>
                  </div>
                </button>
              ))
            ) : (
              <div className="empty-inline">左侧会保留你已经创建的批阅任务。</div>
            )}
          </div>
        </section>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <div className="eyebrow">当前工作区</div>
            <h2>{activeTask?.name || '先从左侧创建一个任务'}</h2>
            <p>
              {activeTask
                ? `${getModeLabel(activeTask.mode)} · ${activeTask.className || '未选择班级'} · 最近更新 ${formatDateLabel(activeTask.updatedAt)}`
                : '先新建任务，再填写基本信息、题目配置和答题卡。'}
            </p>
          </div>

          <div className="header-actions">
            <span className="status-bubble">{health}</span>
            <button className="ghost-arrow" type="button" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={16} />
              后台设置
            </button>
            <button className="pill-button peach" type="button" onClick={() => void handleSaveTask()} disabled={!activeTask}>
              <Save size={16} />
              保存当前任务
            </button>
          </div>
        </header>

        {busyMessages.map((message) => (
          <div key={message.key} className="notice-bar busy">
            <LoaderCircle className="spin" size={16} />
            <span>{message.text}</span>
          </div>
        ))}

        {!busyMessages.length && toast ? (
          <div className="notice-bar">
            <span>{toast}</span>
          </div>
        ) : null}

        <div className="step-tabs">
          {stepTabs.map((step) => {
            const Icon = step.icon;
            return (
              <button
                key={step.id}
                className={`step-tab ${activeStep === step.id ? 'active' : ''}`}
                type="button"
                onClick={() => setActiveStep(step.id)}
              >
                <Icon size={16} />
                {step.label}
              </button>
            );
          })}
        </div>

        <div className="content-grid">
          <section className="content-panel main-panel">
            {activeStep === 'basic' && (
              <>
                <div className="panel-title-row">
                  <h3>任务基本信息</h3>
                  <span>步骤 1</span>
                </div>

                {activeTask ? (
                  <>
                    <div className="form-grid">
                      <label className="field">
                        <span>任务名称</span>
                        <input value={activeTask.name} onChange={(event) => updateTaskDraft({ name: event.target.value })} placeholder="例如：4 月历史作业" />
                      </label>
                      <label className="field">
                        <span>班级</span>
                        <select value={activeTask.className} onChange={(event) => updateTaskDraft({ className: event.target.value })}>
                          <option value="">请选择班级</option>
                          {settings.classrooms.map((classroom) => (
                            <option key={classroom.id} value={classroom.name}>
                              {classroom.name || '未命名班级'}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>作业日期</span>
                        <input type="date" value={activeTask.homeworkDate} onChange={(event) => updateTaskDraft({ homeworkDate: event.target.value })} />
                      </label>
                      <label className="field">
                        <span>任务模式</span>
                        <select value={activeTask.mode} onChange={(event) => updateTaskMode(event.target.value as TaskMode)}>
                          <option value="choice">选择题</option>
                          <option value="subjective">主观题</option>
                          <option value="mixed">综合</option>
                        </select>
                      </label>
                      <label className="field field-span-2">
                        <span>题号范围</span>
                        <input
                          value={activeTask.questionScope}
                          onChange={(event) => updateTaskDraft({ questionScope: event.target.value })}
                          placeholder="例如：第 1-30 题，或第 26、27、28 题"
                        />
                      </label>
                      <label className="field field-span-2">
                        <span>任务备注</span>
                        <textarea
                          rows={4}
                          value={activeTask.description}
                          onChange={(event) => updateTaskDraft({ description: event.target.value })}
                          placeholder="这里可以补充本次作业说明、批阅提醒或班级情况"
                        />
                      </label>
                    </div>

                    <div className="split-cards">
                      <article className="soft-card">
                        <div className="soft-card-title">
                          <Sparkles size={18} />
                          模型连通性测试
                        </div>
                        <p>分别测试综合、答题卡专用、阅卷专用三组配置，确保三条链路都可用。</p>
                        <div className="button-row">
                          <button className="pill-button cream" type="button" onClick={() => void handleConnectionTest('general')}>
                            测试综合
                          </button>
                          <button className="pill-button mint" type="button" onClick={() => void handleConnectionTest('answerSheet')}>
                            测试答题卡专用
                          </button>
                          <button className="pill-button peach" type="button" onClick={() => void handleConnectionTest('subjectiveGrading')}>
                            测试阅卷专用
                          </button>
                        </div>
                        <div className="result-box">{testResult || '测试结果会显示在这里。'}</div>
                      </article>

                      <article className="soft-card">
                        <div className="soft-card-title">
                          <Layers3 size={18} />
                          班级名单预览
                        </div>
                        <p>
                          当前班级：<strong>{selectedClassroom?.name || '尚未选择'}</strong>
                          {sortedClassroomStudents.length ? ` · 共 ${sortedClassroomStudents.length} 人` : ''}
                        </p>
                        {sortedClassroomStudents.length ? (
                          <div className="roster-chip-wrap">
                            {sortedClassroomStudents.map((student) => (
                              <span key={student} className="roster-chip">
                                {student}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <div className="empty-inline">选择班级后，这里会完整显示班级名单。</div>
                        )}
                      </article>
                    </div>
                  </>
                ) : (
                  <div className="empty-state">先在左侧创建任务，再填写这里的基本信息。</div>
                )}
              </>
            )}

            {activeStep === 'question' && (
              <>
                <div className="panel-title-row">
                  <h3>题目识别与配置</h3>
                  <span>步骤 2</span>
                </div>

                {activeTask ? (
                  <>
                    <div className="mode-banner">
                      <strong>{getModeLabel(activeTask.mode)}</strong>
                      <span>
                        {activeTask.mode === 'choice'
                          ? '当前只配置选择题标准答案。'
                          : activeTask.mode === 'subjective'
                            ? '当前只配置普通型主观题和论述题。'
                            : '当前同时配置选择题和主观题。'}
                      </span>
                    </div>

                    <fieldset className="panel-fieldset" disabled={isQuestionStageLocked}>
                    <div className={`uploader-grid ${activeTask.mode === 'choice' ? 'single-upload' : ''}`}>
                      {activeTask.mode !== 'choice' ? (
                        <label className="upload-tile peach-tile">
                          <input type="file" hidden multiple accept=".pdf,image/*" onChange={(event) => void handleUpload('question', event.target.files)} />
                          <Upload size={22} />
                          <strong>上传原题目</strong>
                          <span>支持 PDF 和图片，系统会提取题号、题干和主观题结构。</span>
                        </label>
                      ) : null}

                      <label className="upload-tile mint-tile">
                        <input type="file" hidden multiple accept=".pdf,image/*" onChange={(event) => void handleUpload('answer', event.target.files)} />
                        <Upload size={22} />
                        <strong>{activeTask.mode === 'choice' ? '上传选择题答案' : '上传参考答案'}</strong>
                        <span>{activeTask.mode === 'choice' ? '系统会整理成题号 + 标准答案。' : '系统会整理参考答案并尽量生成阅卷要求。'}</span>
                      </label>
                    </div>

                    <div className="split-cards">
                      <article className="soft-card">
                        <div className="soft-card-title">
                          <WandSparkles size={18} />
                          AI 识别并填充
                        </div>
                        <p>识别后会直接回填到下面的题目配置区。主观题会保留普通型主观题 / 论述题两种题型。</p>
                        <div className="button-row">
                          <label className="mini-switch">
                            <span>识别模型</span>
                            <select
                              value={extractProfile}
                              onChange={(event) => setExtractProfile(event.target.value as ExtractModelProfile)}
                            >
                              <option value="general">综合模型</option>
                              <option value="subjectiveGrading">阅卷专用模型</option>
                            </select>
                          </label>
                          <button className="pill-button peach" type="button" onClick={() => void handleExtract()}>
                            <WandSparkles size={16} />
                            AI 识别并填充
                          </button>
                        </div>
                      </article>

                      <article className="soft-card">
                        <div className="upload-card-head">
                          <div className="soft-card-title">
                            <BookOpenText size={18} />
                            已上传文件
                          </div>
                          <div className="upload-card-tools">
                            {uploadSummary.question.length ? (
                              <button className="mini-icon-button danger" type="button" onClick={() => void handleDeleteUploadsByKind('question')}>
                                <Trash2 size={14} />
                                清空题目
                              </button>
                            ) : null}
                            {uploadSummary.answer.length ? (
                              <button className="mini-icon-button danger" type="button" onClick={() => void handleDeleteUploadsByKind('answer')}>
                                <Trash2 size={14} />
                                清空答案
                              </button>
                            ) : null}
                            {activeTask.uploads.length > 1 ? (
                              <button className="mini-icon-button danger" type="button" onClick={() => void handleDeleteAllTaskUploads()}>
                                <Trash2 size={14} />
                                清空全部
                              </button>
                            ) : null}
                          </div>
                        </div>

                        <div className="upload-badges">
                          <span className="upload-badge peach-badge">题目 {uploadSummary.question.length}</span>
                          <span className="upload-badge mint-badge">答案 {uploadSummary.answer.length}</span>
                        </div>

                        <div className="upload-list">
                          {activeTask.uploads.length ? (
                            activeTask.uploads.map((file) => (
                              <div key={file.id} className="upload-row">
                                <div className="upload-row-main">
                                  <span>{file.kind === 'question' ? '题目' : '答案'}</span>
                                  <strong>{file.originalName}</strong>
                                </div>
                                <button className="mini-icon-button danger" type="button" onClick={() => void handleDeleteUpload(file.id)}>
                                  <Trash2 size={14} />
                                  删除
                                </button>
                              </div>
                            ))
                          ) : (
                            <div className="empty-inline">这里会显示当前任务已上传的题目和答案文件。</div>
                          )}
                        </div>
                      </article>
                    </div>

                    {(activeTask.mode === 'choice' || activeTask.mode === 'mixed') ? (
                      <div className="editor-section">
                        <div className="section-head">
                          <div>
                            <h4>选择题答案区</h4>
                            <p>只保留题号、标准答案和分值。</p>
                          </div>
                          <div className="table-actions">
                            <label className="mini-switch">
                              <span>统一分值</span>
                              <input type="number" min="0" step="0.5" value={choiceScoreValue} onChange={(event) => setChoiceScoreValue(event.target.value)} />
                            </label>
                            <button className="pill-button cream" type="button" onClick={applyChoiceScoreToAll}>
                              一键统一分值
                            </button>
                            <button className="pill-button mint" type="button" onClick={() => appendQuestion('choice')}>
                              <FolderPlus size={16} />
                              新增选择题
                            </button>
                          </div>
                        </div>

                        <div className="choice-table">
                          <div className="choice-table-header">
                            <span>题号</span>
                            <span>标准答案</span>
                            <span>分值</span>
                          </div>
                          {questionRows.choice.length ? (
                            questionRows.choice.map(({ question, index }) => (
                              <div key={question.id} className="choice-row">
                                <input value={question.questionNo} onChange={(event) => updateQuestion(index, { questionNo: event.target.value })} placeholder="1" />
                                <input
                                  value={question.standardAnswer}
                                  onChange={(event) =>
                                    updateQuestion(index, {
                                      standardAnswer: event.target.value.toUpperCase().replace(/[^A-D]/g, '').slice(0, 1),
                                    })
                                  }
                                  placeholder="A"
                                />
                                <input type="number" min="0" step="0.5" value={question.score} onChange={(event) => updateQuestion(index, { score: Number(event.target.value) })} />
                              </div>
                            ))
                          ) : (
                            <div className="empty-inline">还没有选择题配置，上传答案后点击“AI 识别并填充”。</div>
                          )}
                        </div>
                      </div>
                    ) : null}

                    {(activeTask.mode === 'subjective' || activeTask.mode === 'mixed') ? (
                      <div className="editor-section">
                        <div className="section-head">
                          <div>
                            <h4>主观题配置区</h4>
                            <p>这里可以明确区分普通型主观题和论述题，两类题会在步骤五按不同后台规则批阅。</p>
                          </div>
                          <div className="table-actions">
                            <button className="pill-button cream" type="button" onClick={() => appendQuestion('subjective')}>
                              <FolderPlus size={16} />
                              新增普通主观题
                            </button>
                            <button className="pill-button lavender" type="button" onClick={() => appendQuestion('essay')}>
                              <FolderPlus size={16} />
                              新增论述题
                            </button>
                          </div>
                        </div>

                        <div className="subjective-table">
                          {questionRows.subjective.length ? (
                            questionRows.subjective.map(({ question, index }) => (
                              <article key={question.id} className="subjective-card">
                                <div className="subjective-card-top">
                                  <div className="subjective-card-meta">
                                    <label className="subjective-meta-field">
                                      <span>题号</span>
                                      <input
                                        value={question.questionNo}
                                        onChange={(event) => updateQuestion(index, { questionNo: event.target.value })}
                                        placeholder="26"
                                      />
                                    </label>
                                    <label className="subjective-meta-field">
                                      <span>题型</span>
                                      <select value={question.type} onChange={(event) => updateQuestion(index, { type: event.target.value as QuestionDraft['type'] })}>
                                        <option value="subjective">普通型主观题</option>
                                        <option value="essay">论述题</option>
                                      </select>
                                    </label>
                                    <label className="subjective-meta-field subjective-score-field">
                                      <span>{question.type === 'choice' ? '分值' : '分值（自动汇总）'}</span>
                                      <input
                                        type="number"
                                        min="0"
                                        step="0.5"
                                        value={question.score}
                                        readOnly={question.type !== 'choice'}
                                        title={question.type === 'subjective'
                                          ? '普通型主观题总分由下方一级小题分值自动汇总。'
                                          : question.type === 'essay'
                                            ? '论述题总分由论题、论述过程、结论分值自动汇总。'
                                            : ''}
                                        onChange={(event) => updateQuestion(index, { score: Number(event.target.value) })}
                                      />
                                    </label>
                                  </div>
                                  <button
                                    className="question-remove-button"
                                    type="button"
                                    title="删除这道主观题"
                                    aria-label={`删除第 ${question.questionNo || index + 1} 题`}
                                    onClick={() => removeQuestion(index)}
                                  >
                                    <X size={14} />
                                  </button>
                                </div>

                                {question.type === 'subjective' ? (
                                  <OrdinaryQuestionEditor
                                    question={question}
                                    onChange={(patch) => updateQuestion(index, patch)}
                                  />
                                ) : (
                                  <EssayQuestionEditor
                                    question={question}
                                    onChange={(patch) => updateQuestion(index, patch)}
                                  />
                                )}
                              </article>
                            ))
                          ) : (
                            <div className="empty-inline">还没有主观题内容，上传题目和答案后点击“AI识别并填充”。</div>
                          )}
                        </div>
                      </div>
                    ) : null}

                    <div className="table-actions">
                      <button className="pill-button mint" type="button" onClick={() => void handleSaveTask()}>
                        <Save size={16} />
                        保存题目配置
                      </button>
                    </div>
                    </fieldset>
                  </>
                ) : (
                  <div className="empty-state">先创建任务，再进入步骤 2。</div>
                )}
              </>
            )}

            {activeStep === 'ocr' ? (
              <AnswerSheetStage
                task={answerSheetStageTask}
                classroomStudents={answerSheetClassroomStudents}
                recognizer={ocrRecognizer}
                retainQuestionNosText={answerSheetRetainQuestionNosText}
                retainedQuestionNos={retainedAnswerSheetQuestionNos}
                isBusy={Boolean(answerSheetBusyText)}
                isRecognizing={isRecognizingSheets}
                questionConfigStatus={questionConfigStatus}
                onRecognizerChange={setOcrRecognizer}
                onRetainQuestionNosTextChange={setAnswerSheetRetainQuestionNosText}
                onUpload={handleUploadAnswerSheets}
                onRecognizePending={handleRecognizePendingSheets}
                onRecognizeOne={handleRecognizeOneAnswerSheet}
                onUpdateName={handleUpdateAnswerSheetName}
                onEditChoiceAnswer={handleEditChoiceAnswer}
                onEditSubjectiveAnswer={handleEditSubjectiveAnswer}
                onSaveEdits={handleSaveAnswerSheetEdits}
                onDeleteOne={handleDeleteAnswerSheet}
                onDeleteAll={handleDeleteAllAnswerSheets}
              />
            ) : null}

            {activeStep === 'review' ? (
              <ChoiceGradingStage
                task={activeTask}
                isRunning={isRunningChoiceGrading}
                isGeneratingExplanation={isGeneratingChoiceExplanation}
                isExportingExplanation={isExportingChoiceExplanation}
                onRun={handleRunChoiceGrading}
                onGenerateExplanation={handleGenerateChoiceExplanation}
                onClearExplanation={handleClearChoiceExplanation}
                onExportExplanation={handleExportChoiceExplanation}
              />
            ) : null}

            {activeStep === 'grading' ? <SubjectiveGradingStage task={activeTask} onTaskUpdated={handleSubjectiveTaskUpdated} /> : null}
          </section>
        </div>
      </main>

      {settingsOpen ? (
        <div className="settings-modal-backdrop" role="presentation" onClick={() => setSettingsOpen(false)}>
          <div
            className="settings-modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
        <div className="settings-modal-head">
          <div>
            <div className="eyebrow">后台设置</div>
            <h3>模型、主观题规则与班级名单</h3>
          </div>
            <button className="ghost-arrow" type="button" onClick={() => setSettingsOpen(false)}>
            收起
          </button>
        </div>

            <div className="settings-modal-layout">
              <section className="settings-section-card">
                <div className="settings-section-head">
                  <div>
                    <div className="eyebrow">阅卷规则</div>
                    <h4>后台规则与教师逐题要求</h4>
                  </div>
                  <p>后台统一规则负责兜底，步骤 2 中教师逐题填写的“阅卷要求”优先生效；重新提取题目时，也会保留已写好的单题要求。</p>
                </div>
                <div className="settings-note">
                  <strong>当前生效关系</strong>
                  <p>兼顾后台阅卷标准和教师人工逐题设置；如果二者冲突，以教师人工设置为准。</p>
                </div>
                <div className="settings-form-grid">
          <label className="field field-span-2">
            <span>普通型主观题阅卷原则</span>
            <textarea
              rows={10}
              value={settings.subjectiveOrdinaryRulePrompt}
              onChange={(event) => setSettings({ ...settings, subjectiveOrdinaryRulePrompt: event.target.value })}
               placeholder="填写普通型主观题的后台阅卷原则"
            />
          </label>

          <label className="field field-span-2">
            <span>论述题阅卷原则</span>
            <textarea
              rows={10}
              value={settings.subjectiveEssayRulePrompt}
              onChange={(event) => setSettings({ ...settings, subjectiveEssayRulePrompt: event.target.value })}
               placeholder="填写论述题的后台阅卷原则"
            />
          </label>

                </div>
              </section>
              <section className="settings-section-card">
                <div className="settings-section-head">
                  <div>
                    <div className="eyebrow">模型接入</div>
                    <h4>三段式 API 配置</h4>
                  </div>
                  <p>按用途拆分为三段：综合模型、答题卡识别、主观题阅卷。先完成后台配置，后续再接入对应调用链路。</p>
                </div>
                <div className="settings-note">
                  <strong>1. 综合模型（默认豆包 API）</strong>
                  <p>用于综合模型配置，默认模型可按需微调。</p>
                </div>
                <div className="settings-form-grid">
                  <label className="field">
            <span>服务商</span>
            <input value="豆包（Doubao）" readOnly />
          </label>
          <label className="field">
             <span>豆包 API Key</span>
            <input
              value={settings.generalApiKey}
              onChange={(event) => setSettings({ ...settings, generalApiKey: event.target.value })}
               placeholder="填写豆包 API Key"
            />
          </label>
          <label className="field field-span-2">
             <span>默认模型</span>
            <select
              value={settings.generalModel}
              onChange={(event) => setSettings({ ...settings, generalModel: event.target.value })}
            >
              {GENERAL_MODEL_OPTIONS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="settings-note">
          <strong>2. 答题卡识别（默认硅基流动）</strong>
          <p>默认接入模型：PaddlePaddle/PaddleOCR-VL。</p>
        </div>
        <div className="settings-form-grid">
          <label className="field">
            <span>服务商</span>
            <input value="硅基流动（SiliconFlow）" readOnly />
          </label>
          <label className="field">
             <span>硅基流动 API Key</span>
            <input
              value={settings.answerSheetApiKey}
              onChange={(event) => setSettings({ ...settings, answerSheetApiKey: event.target.value })}
               placeholder="填写硅基流动 API Key"
            />
          </label>
          <label className="field field-span-2">
             <span>默认模型</span>
            <select
              value={settings.answerSheetModel}
              onChange={(event) => setSettings({ ...settings, answerSheetModel: event.target.value })}
            >
              {ANSWER_SHEET_MODEL_OPTIONS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>批量并发数</span>
            <input
              type="number"
              min={1}
              max={6}
              value={settings.answerSheetBatchConcurrency}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  answerSheetBatchConcurrency: Math.max(1, Math.min(6, Math.floor(Number(event.target.value) || 1))),
                })
              }
            />
          </label>
        </div>

                <div className="settings-note">
                  <strong>3. 主观题阅卷（默认硅基流动）</strong>
                  <p>默认接入模型：Pro/deepseek-ai/DeepSeek-R1。</p>
                </div>
                <div className="settings-form-grid">
                  <label className="field">
            <span>服务商</span>
            <input value="硅基流动（SiliconFlow）" readOnly />
          </label>
          <label className="field">
             <span>硅基流动 API Key</span>
            <input
              value={settings.subjectiveGradingApiKey}
              onChange={(event) => setSettings({ ...settings, subjectiveGradingApiKey: event.target.value })}
               placeholder="填写硅基流动 API Key"
            />
          </label>
          <label className="field field-span-2">
             <span>默认模型</span>
            <select
              value={settings.subjectiveGradingModel}
              onChange={(event) => setSettings({ ...settings, subjectiveGradingModel: event.target.value })}
            >
              {SUBJECTIVE_GRADING_MODEL_OPTIONS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
                </div>

                <div className="settings-note">
                  <strong>评语风格</strong>
                  <p>保留原有评语角色配置，作用于主观题评语口吻。</p>
                </div>
                <div className="settings-form-grid">
          <label className="field">
            <span>评语角色</span>
            <select value={settings.rolePreset} onChange={(event) => setSettings({ ...settings, rolePreset: event.target.value as AppSettings['rolePreset'] })}>
              <option value="strict">严厉导师</option>
              <option value="gentle">温和助教</option>
              <option value="objective">客观考官</option>
              <option value="custom">自定义</option>
            </select>
          </label>
          <label className="field field-span-2">
            <span>自定义角色提示词</span>
            <textarea
              rows={4}
              value={settings.customRolePrompt}
              onChange={(event) => setSettings({ ...settings, customRolePrompt: event.target.value })}
               placeholder="如果选择了自定义角色，可在这里补充提示词"
            />
          </label>

                </div>
              </section>
              <section className="settings-section-card">
                <div className="settings-section-head">
                  <div>
                  <div className="eyebrow">班级名单</div>
                    <h4>班级与学生花名册</h4>
                  </div>
                  <p>班级名单会参与姓名匹配、缺交统计和答题卡汇总，可用逗号、分号或换行分隔学生姓名。</p>
                </div>
                <div className="panel-title-row">
            <h4>班级名单管理</h4>
            <button className="ghost-arrow" type="button" onClick={addClassroom}>
              新增班级
            </button>
          </div>

          <div className="classroom-stack">
            {settings.classrooms.map((classroom, index) => (
              <div key={classroom.id} className="classroom-card">
                <div className="panel-title-row">
                  <strong>{classroom.name || `班级 ${index + 1}`}</strong>
                  {settings.classrooms.length > 1 ? (
                    <button className="mini-icon-button danger" type="button" onClick={() => removeClassroom(classroom.id)}>
                      <Trash2 size={14} />
                        删除
                    </button>
                  ) : null}
                </div>
                <input value={classroom.name} onChange={(event) => updateClassroom(index, { name: event.target.value })} placeholder="例如：高一（8）班" />
                <textarea
                  rows={4}
                  value={classroom.studentsText}
                  onChange={(event) => updateClassroom(index, { studentsText: event.target.value })}
                  placeholder="学生名单可用逗号、分号或换行分隔"
                />
              </div>
            ))}
          </div>
              </section>
              <section className="settings-section-card">
                <div className="settings-section-head">
                  <div>
                    <div className="eyebrow">数据维护</div>
                    <h4>缓存与数据清理</h4>
                  </div>
                  <p>用于控制本地占用空间；“清空数据”会删除任务数据，请谨慎操作。</p>
                </div>
                <div className="settings-note warning">
                  <strong>高风险操作提示</strong>
                  <p>清空数据后不可恢复。建议先导出需要保留的结果再执行。</p>
                </div>
                <div className="settings-maintenance-actions">
                  <button className="pill-button cream" type="button" onClick={() => void handleRunSettingsMaintenance('cache')} disabled={Boolean(appBusyText)}>
                    一键清理缓存
                  </button>
                  <button className="pill-button coral" type="button" onClick={() => void handleRunSettingsMaintenance('data')} disabled={Boolean(appBusyText)}>
                    一键清空数据
                  </button>
                </div>
                <p className="settings-maintenance-hint">清理缓存不会影响任务；清空数据会保留当前后台设置（API、规则、班级名单）。</p>
              </section>
        </div>

            <div className="settings-modal-footer">
              <span className="settings-helper">保存后会立即影响后续答题卡识别和主观题批改。</span>
              <div className="settings-modal-actions">
                <button className="ghost-arrow" type="button" onClick={() => setSettingsOpen(false)}>
                  取消
                </button>
                <button className="pill-button peach" type="button" onClick={() => void handleSaveSettings()}>
            <Save size={16} />
            保存后台设置
          </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

