const fs = require('node:fs');
const path = require('node:path');
const {
  buildOverallComment,
  buildOrdinarySectionContext,
  buildQuestionComment,
  buildAnnotationRanges,
  buildSectionReviews,
  buildSubjectiveConsistencyWarnings,
  normalizePointReviews,
  toLegacySubReview,
} = require('./subjectiveReviewUtils');
const { buildEssayReviewArtifacts } = require('./essayReviewUtils');
const { applyAutoSplitGradingRule } = require('./gradingRuleAutoSplit');

const rootDir = path.resolve(__dirname, '..', '..');
const dataDir = path.join(rootDir, 'data');
const uploadDir = path.join(dataDir, 'uploads');
const generatedDir = path.join(dataDir, 'generated');
const logsDir = path.join(rootDir, 'logs');
const tempDocxDir = path.join(rootDir, '.codex_temp_docx');
const npmCacheDir = path.join(rootDir, '.npm-cache');
const statePath = path.join(dataDir, 'app-state.json');
let cachedState = null;
let cachedStateMtimeMs = 0;

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(generatedDir, { recursive: true });

const ANSWER_SHEET_MODEL_OPTIONS = [
  'PaddlePaddle/PaddleOCR-VL',
  'zai-org/GLM-4.6V',
  'Pro/moonshotai/Kimi-K2.5',
  'Qwen/Qwen3.5-397B-A17B',
];

const GENERAL_MODEL_OPTIONS = [
  'doubao-seed-2-0-pro-260215',
  'doubao-seed-2-0-lite-260215',
];

const INTERRUPTED_ANSWER_SHEET_ERROR_MESSAGE = '上次答题卡识别因服务重启或中断未完成，已恢复为可重试状态，请重新识别。';

const SUBJECTIVE_GRADING_MODEL_OPTIONS = [
  'Pro/deepseek-ai/DeepSeek-R1',
  'Pro/zai-org/GLM-5',
  'zai-org/GLM-4.6',
  'Pro/moonshotai/Kimi-K2.5',
  'moonshotai/Kimi-K2-Instruct-0905',
  'Pro/moonshotai/Kimi-K2-Instruct-0905',
  'Qwen/Qwen3.5-397B-A17B',
];

function repairUploadName(name) {
  if (!name || typeof name !== 'string') return '';

  if (!/^[\x00-\xff]+$/.test(name)) {
    return name;
  }

  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('锟') ? name : decoded;
  } catch {
    return name;
  }
}

function normalizeClassroomName(value) {
  return String(value ?? '')
    .replace(/[\s()\[\]{}\uFF08\uFF09\u3010\u3011]+/g, '')
    .toLowerCase();
}

function findMatchingClassroom(classrooms = [], className) {
  const rawName = String(className ?? '').trim();
  if (!rawName) return null;

  const exactMatch = classrooms.find((item) => String(item?.name ?? '').trim() === rawName);
  if (exactMatch) return exactMatch;

  const normalizedTarget = normalizeClassroomName(rawName);
  if (!normalizedTarget) return null;

  return (
    classrooms.find((item) => normalizeClassroomName(item?.name) === normalizedTarget) || null
  );
}

function getDefaultOrdinaryRulePrompt() {
  return `普通型主观题
1、要求 AI 先读题目，再读参考答案，对题目有充分理解。
2、有采分点的句子（老师会在阅卷要求中列出），学生必须答到采分点才能给分，所有表达都要围绕采分点。
3、如果没有相应采分点的句子，意思相近即可得分。
4、如果某一点意思到位了，但出现轻微史实错误，扣 1 分；如果这一点本来就是 1 分，则该点不得分。
5、学生写的其他和参考答案不符合的话，不扣分。
6、要关注每一点的给分，常见是一点 2 分，也可能一点 1 分。
7、优先参考题目的阅卷要求；如果阅卷要求与这些原则冲突，以阅卷要求为准；如果没有阅卷要求，则以这些原则为主。
AI 约束：只能依据学生作答原文评分；不能补充学生未写出的观点；不能因为文采好就替代知识点命中。`;
}

function getDefaultEssayRulePrompt() {
  return `论述型主观题
1、按“论题-论述过程-结论”三个部分评分。优先参考题目的阅卷要求；如果阅卷要求与这些原则冲突，以阅卷要求为准。
2、论题一般 2-3 分。论题应当是一句完整、明确、可论证的陈述句，能够概括全文主旨；切题且明确可得满分，表述不完整或不够鲜明可酌情扣分，跑题论题 0 分。
3、论述过程一般 8-9 分，通常分为 2 段或 3 段。每段先按该段满分计分，再按规则扣分：围绕论题展开则保留满分，明显偏题则该段记 0 分；有史实但缺少论述，扣 2 分；有论述但缺少史实，扣 2 分；段首没有小标题或分论点引导，扣 1 分；每出现 1 个史实错误，扣 1 分。最低扣到 0 分为止。
4、结论一般 1-2 分。结论应总结前文并有升华、启示或历史认识；只有简单重复前文、没有升华，可扣 1 分或不给分。
5、AI 必须输出结构化结果：论题、各段论述、结论分别点评；每部分点评先概括完成度，再指出主要问题，并给出一条可执行建议。
AI 约束：只能依据学生作答原文评分；不能补充学生未写出的观点；不能因为文采好就替代知识点命中。`;
}

function isLegacyEssayRulePrompt(value) {
  const text = String(value || '').replace(/\s+/g, '');
  if (!text) return false;
  return (
    text.includes('阐述过程至少围绕三个方面写')
    && text.includes('每个方面3分')
    && text.includes('结论一般1分')
  );
}

function normalizeEssayRulePrompt(value, fallback) {
  const nextValue = String(value ?? '').trim();
  if (!nextValue) {
    return getDefaultEssayRulePrompt();
  }
  if (isLegacyEssayRulePrompt(nextValue)) {
    return getDefaultEssayRulePrompt();
  }
  return nextValue || fallback || getDefaultEssayRulePrompt();
}

function getDefaultSettings() {
  return {
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
    subjectiveOrdinaryRulePrompt: getDefaultOrdinaryRulePrompt(),
    subjectiveEssayRulePrompt: getDefaultEssayRulePrompt(),
    classrooms: [],
  };
}

function sanitizeClassrooms(classrooms, fallback) {
  const normalized = (Array.isArray(classrooms) ? classrooms : [])
    .map((classroom, index) => ({
      id: String(classroom?.id || `classroom-${index + 1}`),
      name: String(classroom?.name ?? '').trim(),
      studentsText: String(classroom?.studentsText ?? '').trim(),
    }))
    .filter((classroom) => classroom.name || classroom.studentsText);

  return normalized.length ? normalized : fallback;
}

function pickModelOption(value, options, fallback) {
  const nextValue = String(value ?? '').trim();
  return options.includes(nextValue) ? nextValue : fallback;
}

function normalizeGeneralModelOption(value, fallback) {
  const nextValue = String(value ?? '').trim();
  const normalized = nextValue.toLowerCase();

  if (normalized === 'doubao-seed-2.0-pro') {
    return 'doubao-seed-2-0-pro-260215';
  }

  if (normalized === 'doubao-seed-2.0-lite') {
    return 'doubao-seed-2-0-lite-260215';
  }

  return pickModelOption(nextValue, GENERAL_MODEL_OPTIONS, fallback);
}

function sanitizeSettingsRecord(record = {}) {
  const defaults = getDefaultSettings();
  const rolePreset = ['strict', 'gentle', 'objective', 'custom'].includes(record?.rolePreset)
    ? record.rolePreset
    : defaults.rolePreset;
  const generalProvider = String(record?.generalProvider ?? defaults.generalProvider).trim().toLowerCase() || defaults.generalProvider;
  const generalApiKey = String(record?.generalApiKey ?? record?.normalApiKey ?? defaults.generalApiKey);
  const generalModel = normalizeGeneralModelOption(record?.generalModel, defaults.generalModel);
  const answerSheetProvider = String(record?.answerSheetProvider ?? defaults.answerSheetProvider).trim().toLowerCase() || defaults.answerSheetProvider;
  const answerSheetApiKey = String(record?.answerSheetApiKey ?? record?.strongApiKey ?? defaults.answerSheetApiKey);
  const answerSheetModel = pickModelOption(record?.answerSheetModel, ANSWER_SHEET_MODEL_OPTIONS, defaults.answerSheetModel);
  const subjectiveGradingProvider =
    String(record?.subjectiveGradingProvider ?? defaults.subjectiveGradingProvider).trim().toLowerCase() || defaults.subjectiveGradingProvider;
  const subjectiveGradingApiKey = String(record?.subjectiveGradingApiKey ?? record?.strongApiKey ?? defaults.subjectiveGradingApiKey);
  const subjectiveGradingModel = pickModelOption(
    record?.subjectiveGradingModel,
    SUBJECTIVE_GRADING_MODEL_OPTIONS,
    defaults.subjectiveGradingModel,
  );
  const answerSheetBatchConcurrency = Number.isFinite(Number(record?.answerSheetBatchConcurrency))
    ? Math.max(1, Math.min(6, Math.floor(Number(record.answerSheetBatchConcurrency))))
    : defaults.answerSheetBatchConcurrency;

  return {
    generalProvider,
    generalApiKey,
    generalModel,
    answerSheetProvider,
    answerSheetApiKey,
    answerSheetModel,
    subjectiveGradingProvider,
    subjectiveGradingApiKey,
    subjectiveGradingModel,
    apiBaseUrl: String(record?.apiBaseUrl ?? defaults.apiBaseUrl),
    answerSheetBatchConcurrency,
    rolePreset,
    customRolePrompt: String(record?.customRolePrompt ?? defaults.customRolePrompt),
    subjectiveOrdinaryRulePrompt: String(record?.subjectiveOrdinaryRulePrompt ?? defaults.subjectiveOrdinaryRulePrompt),
    subjectiveEssayRulePrompt: normalizeEssayRulePrompt(
      record?.subjectiveEssayRulePrompt,
      defaults.subjectiveEssayRulePrompt,
    ),
    classrooms: sanitizeClassrooms(record?.classrooms, defaults.classrooms),
  };
}

function createDefaultState() {
  return {
    settings: getDefaultSettings(),
    tasks: [],
    questions: [],
    uploads: [],
    answerSheets: [],
    studentSummaries: [],
  };
}

function sanitizeChoiceExplanationQuestionRecord(record = {}) {
  return {
    questionNo: String(record?.questionNo ?? '').trim(),
    title: String(record?.title ?? '').trim(),
    correctAnswer: String(record?.correctAnswer ?? '')
      .toUpperCase()
      .replace(/[^A-D]/g, '')
      .slice(0, 1),
    promptStem: String(record?.promptStem ?? '').trim(),
    correctRate: Number.isFinite(Number(record?.correctRate)) ? Math.max(0, Math.min(1, Number(record.correctRate))) : null,
    wrongCount: Number.isFinite(Number(record?.wrongCount)) ? Math.max(0, Math.floor(Number(record.wrongCount))) : 0,
    topWrongOption: String(record?.topWrongOption ?? '')
      .toUpperCase()
      .replace(/[^A-D]/g, '')
      .slice(0, 1),
    topWrongOptionCount: Number.isFinite(Number(record?.topWrongOptionCount)) ? Math.max(0, Math.floor(Number(record.topWrongOptionCount))) : 0,
    thinkingSteps: Array.isArray(record?.thinkingSteps)
      ? record.thinkingSteps
        .map((item) => ({
          label: String(item?.label ?? '').trim(),
          content: String(item?.content ?? '').trim(),
        }))
        .filter((item) => item.label || item.content)
      : [],
    wrongOptionAnalyses: Array.isArray(record?.wrongOptionAnalyses)
      ? record.wrongOptionAnalyses
        .map((item) => ({
          option: String(item?.option ?? '')
            .toUpperCase()
            .replace(/[^A-D]/g, '')
            .slice(0, 1),
          reasonType: String(item?.reasonType ?? '').trim(),
          analysis: String(item?.analysis ?? '').trim(),
        }))
        .filter((item) => item.option || item.reasonType || item.analysis)
      : [],
    summary: String(record?.summary ?? '').trim(),
  };
}

function sanitizeChoiceExplanationSnapshot(snapshot = null) {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  return {
    threshold: Number.isFinite(Number(snapshot.threshold)) ? Math.max(0, Math.min(100, Number(snapshot.threshold))) : 80,
    selectedQuestionNos: Array.from(
      new Set(
        (Array.isArray(snapshot.selectedQuestionNos) ? snapshot.selectedQuestionNos : [])
          .map((item) => String(item ?? '').trim())
          .filter(Boolean),
      ),
    ).sort((left, right) => String(left).localeCompare(String(right), 'zh-CN', { numeric: true, sensitivity: 'base' })),
    generatedAt: String(snapshot.generatedAt ?? '').trim(),
    sourceUploadIds: Array.from(
      new Set(
        (Array.isArray(snapshot.sourceUploadIds) ? snapshot.sourceUploadIds : [])
          .map((item) => String(item ?? '').trim())
          .filter(Boolean),
      ),
    ),
    modelProfile: 'general',
    questions: Array.isArray(snapshot.questions)
      ? snapshot.questions.map(sanitizeChoiceExplanationQuestionRecord).filter((item) => item.questionNo)
      : [],
    warnings: Array.isArray(snapshot.warnings) ? snapshot.warnings.map((item) => String(item ?? '').trim()).filter(Boolean) : [],
  };
}

function loadState() {
  if (!fs.existsSync(statePath)) {
    const defaults = createDefaultState();
    fs.writeFileSync(statePath, JSON.stringify(defaults, null, 2), 'utf8');
    cachedState = defaults;
    cachedStateMtimeMs = fs.statSync(statePath).mtimeMs;
    return defaults;
  }

  const stat = fs.statSync(statePath);
  if (cachedState && stat.mtimeMs === cachedStateMtimeMs) {
    return cachedState;
  }

  const raw = fs.readFileSync(statePath, 'utf8');
  const parsed = raw ? JSON.parse(raw) : createDefaultState();
  cachedState = {
    settings: sanitizeSettingsRecord(parsed.settings),
    tasks: (parsed.tasks || []).map((task) => ({
      ...task,
      choiceExplanation: sanitizeChoiceExplanationSnapshot(task?.choiceExplanation ?? null),
    })),
    questions: parsed.questions || [],
    uploads: parsed.uploads || [],
    answerSheets: parsed.answerSheets || [],
    studentSummaries: parsed.studentSummaries || [],
  };
  cachedStateMtimeMs = stat.mtimeMs;
  return cachedState;
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  cachedState = state;
  cachedStateMtimeMs = fs.statSync(statePath).mtimeMs;
}

function resolveStoredFilePath(storedPath, taskId, storedName) {
  const normalizedStoredPath = String(storedPath ?? '').trim();
  if (normalizedStoredPath && fs.existsSync(normalizedStoredPath)) {
    return normalizedStoredPath;
  }

  const fileName = String(storedName ?? '').trim() || path.basename(normalizedStoredPath);
  if (!taskId || !fileName) {
    return normalizedStoredPath;
  }

  const candidate = path.join(uploadDir, String(taskId), fileName);
  if (fs.existsSync(candidate)) {
    return candidate;
  }

  return normalizedStoredPath;
}

function getSettings() {
  return loadState().settings;
}

function saveSettings(payload) {
  const state = loadState();
  state.settings = sanitizeSettingsRecord(payload);
  saveState(state);
  return state.settings;
}

function ensureDirectory(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
}

function clearDirectoryEntries(targetDir) {
  if (!fs.existsSync(targetDir)) return 0;
  let removedCount = 0;
  const names = fs.readdirSync(targetDir);
  names.forEach((name) => {
    const targetPath = path.join(targetDir, name);
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      removedCount += 1;
    } catch {
      // Ignore locked files and continue clearing the rest.
    }
  });
  return removedCount;
}

function clearAppCacheStorage() {
  const removed = {
    generated: clearDirectoryEntries(generatedDir),
    logs: clearDirectoryEntries(logsDir),
    tempDocx: clearDirectoryEntries(tempDocxDir),
    npmCache: clearDirectoryEntries(npmCacheDir),
  };

  ensureDirectory(generatedDir);
  ensureDirectory(logsDir);
  ensureDirectory(tempDocxDir);
  ensureDirectory(npmCacheDir);

  return {
    scope: 'cache',
    removed,
  };
}

function clearAppDataStorage({ keepSettings = true } = {}) {
  const state = loadState();
  const preservedSettings = state.settings;
  const summary = {
    removedTasks: state.tasks.length,
    removedQuestions: state.questions.length,
    removedUploads: state.uploads.length,
    removedAnswerSheets: state.answerSheets.length,
    removedStudentSummaries: state.studentSummaries.length,
  };

  const nextState = createDefaultState();
  if (keepSettings) {
    nextState.settings = preservedSettings;
  }
  saveState(nextState);

  const removedUploadFiles = clearDirectoryEntries(uploadDir);
  ensureDirectory(uploadDir);
  const cacheResult = clearAppCacheStorage();

  return {
    scope: 'data',
    summary,
    removedUploadFiles,
    cacheRemoved: cacheResult.removed,
    keepSettings,
  };
}

function compareQuestionNo(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function getUniqueQuestionNos(values = []) {
  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean))).sort(compareQuestionNo);
}

const STUDENT_NAME_SPLIT_PATTERN = /[\s,\uFF0C\u3001\uFF1B;]+/;

function splitStudentNames(raw) {
  return String(raw ?? '')
    .split(STUDENT_NAME_SPLIT_PATTERN)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getTaskQuestionBuckets(questions = []) {
  return {
    choiceQuestionNos: getUniqueQuestionNos(questions.filter((item) => item.type === 'choice').map((item) => item.questionNo)),
    subjectiveQuestionNos: getUniqueQuestionNos(questions.filter((item) => item.type !== 'choice').map((item) => item.questionNo)),
  };
}

function sanitizeChoiceAnswers(choiceAnswers = []) {
  return choiceAnswers
    .map((item, index) => ({
      questionNo: String(item?.questionNo ?? index + 1).trim(),
      answer: String(item?.answer ?? '')
        .toUpperCase()
        .replace(/[^A-D]/g, ''),
    }))
    .filter((item) => item.questionNo)
    .sort((a, b) => compareQuestionNo(a.questionNo, b.questionNo));
}

function sanitizeSubjectiveAnswers(subjectiveAnswers = []) {
  return subjectiveAnswers
    .map((item, index) => ({
      questionNo: String(item?.questionNo ?? index + 1).trim(),
      content: String(item?.content ?? '').trim(),
    }))
    .filter((item) => item.questionNo)
    .sort((a, b) => compareQuestionNo(a.questionNo, b.questionNo));
}

function sanitizeStudentSummaryRecord(record) {
  return {
    id: record.id,
    taskId: record.taskId,
    studentName: String(record.studentName ?? '').trim(),
    choiceOverrides: sanitizeChoiceAnswers(record.choiceOverrides || []),
    subjectiveOverrides: sanitizeSubjectiveAnswers(record.subjectiveOverrides || []),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function normalizeAnswerSheetEngine(engine) {
  return String(engine ?? '').trim() ? 'doubao' : '';
}

function sanitizeObservedNames(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((item) => String(item ?? '').trim())
        .filter(Boolean),
    ),
  ).slice(0, 3);
}

function buildAnswerSheetPreviewUrl(record) {
  if (!record?.taskId || !record?.id) return '';
  return `/api/tasks/${record.taskId}/answer-sheets/${record.id}/preview`;
}

function sanitizeAnswerSheetRecord(record) {
  return {
    id: record.id,
    sourceOriginalName: repairUploadName(record.sourceOriginalName),
    sourcePage: Number(record.sourcePage ?? 1),
    displayName: repairUploadName(record.displayName || record.sourceOriginalName),
    mimeType: record.mimeType || 'image/jpeg',
    size: Number(record.size ?? 0),
    status: record.status || 'pending',
    engine: normalizeAnswerSheetEngine(record.engine),
    profile: record.profile || '',
    provider: record.provider || '',
    selectedModel: record.selectedModel || '',
    studentName: String(record.studentName ?? '').trim(),
    manualStudentName: String(record.manualStudentName ?? '').trim(),
    observedNames: sanitizeObservedNames(record.observedNames),
    suggestedStudentName: String(record.suggestedStudentName ?? '').trim(),
    suggestedStudentConfidence: Number.isFinite(Number(record.suggestedStudentConfidence))
      ? Math.max(0, Math.min(1, Number(record.suggestedStudentConfidence)))
      : 0,
    previewUrl: buildAnswerSheetPreviewUrl(record),
    choiceAnswers: sanitizeChoiceAnswers(record.choiceAnswers || []),
    subjectiveAnswers: sanitizeSubjectiveAnswers(record.subjectiveAnswers || []),
    warnings: Array.isArray(record.warnings) ? record.warnings.filter(Boolean).map(String) : [],
    errorMessage: String(record.errorMessage ?? '').trim(),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    recognizedAt: record.recognizedAt || '',
  };
}

function listStudentSummaries(taskId) {
  const state = loadState();
  return state.studentSummaries.filter((item) => item.taskId === taskId).map(sanitizeStudentSummaryRecord);
}

function getResolvedSheetStudentName(sheet) {
  return String(sheet?.manualStudentName || sheet?.studentName || '').trim();
}

function getStudentRecordNameFromSheet(sheet, rosterSet) {
  const manualStudentName = String(sheet?.manualStudentName || '').trim();
  if (manualStudentName) {
    return manualStudentName;
  }

  const recognizedStudentName = String(sheet?.studentName || '').trim();
  if (!recognizedStudentName) {
    return '';
  }

  if (rosterSet?.size && !rosterSet.has(recognizedStudentName)) {
    return '';
  }

  return recognizedStudentName;
}

function buildStudentSourceMeta(sheet) {
  return {
    sheetId: sheet.id,
    label: repairUploadName(sheet.displayName || sheet.sourceOriginalName || `第 ${sheet.sourcePage || 1} 页`),
    updatedAt: sheet.updatedAt,
    status: sheet.status || 'pending',
  };
}

function getLatestTimestamp(values = []) {
  return [...values].filter(Boolean).sort().at(-1) || '';
}

function getLatestMatch(matches, valueKey) {
  return [...matches]
    .filter((item) => String(item[valueKey] ?? '').trim())
    .sort((left, right) => String(left.updatedAt || '').localeCompare(String(right.updatedAt || '')))
    .at(-1);
}

function isResolvableNameWarning(warning) {
  return [
    /姓名未识别出来/,
    /无法确定正确姓名/,
    /不在当前班级名单/,
    /给定候选名单/,
    /姓名字段留空/,
  ].some((pattern) => pattern.test(String(warning || '')));
}

function isInformationalStudentWarning(warning) {
  return [/匹配班级名单确定中/].some((pattern) => pattern.test(String(warning || '')));
}

function collectStudentWarnings(sheets) {
  return [
    ...new Set(
      sheets.flatMap((sheet) =>
        (Array.isArray(sheet.warnings) ? sheet.warnings : []).filter((warning) => {
          const normalized = String(warning || '').trim();
          if (!normalized) return false;
          if (isInformationalStudentWarning(normalized)) return false;
          if (sheet.manualStudentName && isResolvableNameWarning(normalized)) return false;
          return true;
        }),
      ),
    ),
  ];
}

function getChoiceAnswerState(matches, questionNo, studentName, warnings) {
  const distinctAnswers = Array.from(new Set(matches.map((item) => item.answer).filter(Boolean)));
  if (distinctAnswers.length > 1) {
    const latest = getLatestMatch(matches, 'answer');
    warnings.push(`学生“${studentName}”的选择题第 ${questionNo} 题出现了多个版本，系统暂按最新一页展示，请人工复核。`);
    return {
      baseAnswer: latest?.answer || '',
      baseState: 'conflict',
    };
  }

  if (distinctAnswers.length === 1) {
    return {
      baseAnswer: distinctAnswers[0],
      baseState: 'answered',
    };
  }

  if (matches.length > 0) {
    return {
      baseAnswer: '',
      baseState: 'blank',
    };
  }

  return {
    baseAnswer: '',
    baseState: 'missing',
  };
}

function getSubjectiveAnswerState(matches, questionNo, studentName, warnings) {
  const distinctContents = Array.from(new Set(matches.map((item) => item.content).filter(Boolean)));
  if (distinctContents.length > 1) {
    const latest = getLatestMatch(matches, 'content');
    warnings.push(`学生“${studentName}”的主观题第 ${questionNo} 题出现了多个版本，系统暂按最新一页展示，请人工复核。`);
    return {
      baseContent: latest?.content || '',
      baseState: 'conflict',
    };
  }

  if (distinctContents.length === 1) {
    return {
      baseContent: distinctContents[0],
      baseState: 'answered',
    };
  }

  if (matches.length > 0) {
    return {
      baseContent: '',
      baseState: 'blank',
    };
  }

  return {
    baseContent: '',
    baseState: 'missing',
  };
}

function buildStudentRecord({
  taskId,
  studentName,
  isExtra,
  sheets,
  summary,
  taskChoiceQuestionNos,
  taskSubjectiveQuestionNos,
}) {
  const recordWarnings = collectStudentWarnings(sheets);
  const warningBuffer = [];
  const choiceOverrideMap = new Map((summary?.choiceOverrides || []).map((item) => [item.questionNo, item.answer]));
  const subjectiveOverrideMap = new Map((summary?.subjectiveOverrides || []).map((item) => [item.questionNo, item.content]));

  const choiceQuestionNos = getUniqueQuestionNos([
    ...taskChoiceQuestionNos,
    ...sheets.flatMap((sheet) => (sheet.choiceAnswers || []).map((item) => item.questionNo)),
    ...choiceOverrideMap.keys(),
  ]);

  const subjectiveQuestionNos = getUniqueQuestionNos([
    ...taskSubjectiveQuestionNos,
    ...sheets.flatMap((sheet) => (sheet.subjectiveAnswers || []).map((item) => item.questionNo)),
    ...subjectiveOverrideMap.keys(),
  ]);

  const choiceAnswers = choiceQuestionNos.map((questionNo) => {
    const matches = sheets
      .flatMap((sheet) =>
        (sheet.choiceAnswers || [])
          .filter((item) => item.questionNo === questionNo)
          .map((item) => ({
            sheetId: sheet.id,
            label: buildStudentSourceMeta(sheet).label,
            updatedAt: sheet.updatedAt,
            answer: item.answer,
          })),
      )
      .sort((left, right) => String(left.updatedAt || '').localeCompare(String(right.updatedAt || '')));
    const hasOverride = choiceOverrideMap.has(questionNo);
    const warningCountBefore = warningBuffer.length;
    const base = getChoiceAnswerState(matches, questionNo, studentName, warningBuffer);
    if (hasOverride && base.baseState === 'conflict') {
      warningBuffer.splice(warningCountBefore);
    }

    return {
      questionNo,
      answer: hasOverride ? choiceOverrideMap.get(questionNo) || '' : base.baseAnswer,
      baseAnswer: base.baseAnswer,
      state: hasOverride ? 'manual' : base.baseState,
      baseState: base.baseState,
      hasOverride,
      sourceSheetIds: Array.from(new Set(matches.map((item) => item.sheetId))),
      sourceLabels: Array.from(new Set(matches.map((item) => item.label))),
    };
  });

  const subjectiveAnswers = subjectiveQuestionNos.map((questionNo) => {
    const matches = sheets
      .flatMap((sheet) =>
        (sheet.subjectiveAnswers || [])
          .filter((item) => item.questionNo === questionNo)
          .map((item) => ({
            sheetId: sheet.id,
            label: buildStudentSourceMeta(sheet).label,
            updatedAt: sheet.updatedAt,
            content: item.content,
          })),
      )
      .sort((left, right) => String(left.updatedAt || '').localeCompare(String(right.updatedAt || '')));
    const hasOverride = subjectiveOverrideMap.has(questionNo);
    const warningCountBefore = warningBuffer.length;
    const base = getSubjectiveAnswerState(matches, questionNo, studentName, warningBuffer);
    if (hasOverride && base.baseState === 'conflict') {
      warningBuffer.splice(warningCountBefore);
    }

    return {
      questionNo,
      content: hasOverride ? subjectiveOverrideMap.get(questionNo) || '' : base.baseContent,
      baseContent: base.baseContent,
      state: hasOverride ? 'manual' : base.baseState,
      baseState: base.baseState,
      hasOverride,
      sourceSheetIds: Array.from(new Set(matches.map((item) => item.sheetId))),
      sourceLabels: Array.from(new Set(matches.map((item) => item.label))),
    };
  });

  const warnings = [...new Set([...recordWarnings, ...warningBuffer])];
  const requiredChoiceNos = new Set(taskChoiceQuestionNos);
  const requiredSubjectiveNos = new Set(taskSubjectiveQuestionNos);
  const hasMissingRequiredChoice = choiceAnswers.some(
    (item) => requiredChoiceNos.has(item.questionNo) && item.baseState === 'missing' && !item.hasOverride,
  );
  const hasMissingRequiredSubjective = subjectiveAnswers.some(
    (item) => requiredSubjectiveNos.has(item.questionNo) && item.baseState === 'missing' && !item.hasOverride,
  );
  const hasData =
    sheets.length > 0 ||
    choiceAnswers.some((item) => item.hasOverride || item.baseState !== 'missing') ||
    subjectiveAnswers.some((item) => item.hasOverride || item.baseState !== 'missing');

  let status = 'unsubmitted';
  if (hasData) {
    status = hasMissingRequiredChoice || hasMissingRequiredSubjective ? 'partial' : 'ready';
  }
  if (warnings.length > 0) {
    status = 'needs_review';
  }

  return {
    id: summary?.id || `${taskId}:${studentName}`,
    studentName,
    isExtra,
    status,
    sheetCount: sheets.length,
    sources: sheets
      .slice()
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .map(buildStudentSourceMeta),
    choiceAnswers,
    subjectiveAnswers,
    warnings,
    updatedAt: getLatestTimestamp([summary?.updatedAt, ...sheets.map((sheet) => sheet.updatedAt)]),
  };
}

function buildStudentRecords(task, answerSheets, studentSummaries, classroomStudents) {
  const roster = Array.from(new Set(classroomStudents));
  const rosterSet = new Set(roster);
  const sheetsByStudent = new Map();
  const allowExtraStudents = roster.length === 0;

  answerSheets.forEach((sheet) => {
    const resolvedName = getStudentRecordNameFromSheet(sheet, rosterSet);
    if (!resolvedName) return;
    if (!sheetsByStudent.has(resolvedName)) {
      sheetsByStudent.set(resolvedName, []);
    }
    sheetsByStudent.get(resolvedName).push(sheet);
  });

  const summaryMap = new Map(
    studentSummaries
      .filter((item) => item.studentName && (allowExtraStudents || rosterSet.has(item.studentName)))
      .map((item) => [item.studentName, sanitizeStudentSummaryRecord(item)]),
  );
  const { choiceQuestionNos, subjectiveQuestionNos } = getTaskQuestionBuckets(task.questions || []);
  const extraStudentNames = allowExtraStudents
    ? getUniqueQuestionNos([...Array.from(sheetsByStudent.keys()), ...Array.from(summaryMap.keys())])
    : [];
  const orderedStudentNames = allowExtraStudents ? extraStudentNames : roster;

  return orderedStudentNames.map((studentName) =>
    buildStudentRecord({
      taskId: task.id,
      studentName,
      isExtra: allowExtraStudents && !rosterSet.has(studentName),
      sheets: (sheetsByStudent.get(studentName) || []).map(sanitizeAnswerSheetRecord),
      summary: summaryMap.get(studentName) || null,
      taskChoiceQuestionNos: choiceQuestionNos,
      taskSubjectiveQuestionNos: subjectiveQuestionNos,
    }),
  );
}

function sortNamesByLocale(names = []) {
  return [...names].sort((left, right) => String(left || '').localeCompare(String(right || ''), 'zh-CN', { numeric: true }));
}

function getChoiceQuestionsForGrading(task) {
  return (task.questions || [])
    .filter((question) => question.type === 'choice' && question.enabled !== false)
    .map((question) => ({
      questionNo: String(question.questionNo || '').trim(),
      standardAnswer: String(question.standardAnswer || '')
        .toUpperCase()
        .replace(/[^A-D]/g, '')
        .slice(0, 1),
      score: Number(question.score || 0),
    }))
    .filter((question) => question.questionNo)
    .sort((left, right) => compareQuestionNo(left.questionNo, right.questionNo));
}

function buildPreviousChoiceGradeMap(snapshot) {
  const studentMap = new Map();
  (snapshot?.studentSummaries || []).forEach((student) => {
    studentMap.set(
      student.studentName,
      new Map((student.questionGrades || []).map((grade) => [grade.questionNo, grade])),
    );
  });
  return studentMap;
}

function buildChoiceGradeStatus(question, answerRecord) {
  const normalizedAnswer = String(answerRecord?.answer || '')
    .toUpperCase()
    .replace(/[^A-D]/g, '')
    .slice(0, 1);
  const answerState = answerRecord?.state || 'missing';

  if (!question.standardAnswer) {
    return {
      answer: normalizedAnswer,
      earnedScore: 0,
      status: 'unavailable',
      answerState,
    };
  }

  if (answerState === 'missing') {
    return {
      answer: normalizedAnswer,
      earnedScore: 0,
      status: 'pending',
      answerState,
    };
  }

  if (answerState === 'conflict') {
    return {
      answer: normalizedAnswer,
      earnedScore: 0,
      status: 'review',
      answerState,
    };
  }

  if (answerState === 'blank' || !normalizedAnswer) {
    return {
      answer: '',
      earnedScore: 0,
      status: 'blank',
      answerState,
    };
  }

  return {
    answer: normalizedAnswer,
    earnedScore: normalizedAnswer === question.standardAnswer ? question.score : 0,
    status: normalizedAnswer === question.standardAnswer ? 'correct' : 'wrong',
    answerState,
  };
}

function getChoiceGradeSignature(question, grade) {
  return [question.questionNo, question.standardAnswer, question.score, grade.answer, grade.status, grade.answerState].join('::');
}

function getChoiceOptionBucket(grade) {
  if (grade.status === 'blank') return '绌虹櫧';
  if (grade.status === 'pending') return '待补录';
  if (grade.status === 'review') return '待复核';
  if (grade.status === 'unavailable') return '未配置';
  return grade.answer || '绌虹櫧';
}

function buildChoiceQuestionSummaries(choiceQuestions, studentSummaries) {
  const bucketOrder = ['A', 'B', 'C', 'D', '空白', '待补录', '待复核', '未配置'];

  return choiceQuestions.map((question) => {
    const grades = studentSummaries
      .map((student) => ({
        studentName: student.studentName,
        grade: (student.questionGrades || []).find((item) => item.questionNo === question.questionNo) || null,
      }))
      .filter((item) => item.grade);
    const correctCount = grades.filter((item) => item.grade.status === 'correct').length;
    const wrongCount = grades.filter((item) => item.grade.status === 'wrong').length;
    const blankCount = grades.filter((item) => item.grade.status === 'blank').length;
    const pendingCount = grades.filter((item) => item.grade.status === 'pending').length;
    const reviewCount = grades.filter((item) => item.grade.status === 'review').length;
    const unavailableCount = grades.filter((item) => item.grade.status === 'unavailable').length;
    const completedCount = correctCount + wrongCount + blankCount;
    const optionMap = new Map(bucketOrder.map((option) => [option, []]));

    grades.forEach(({ studentName, grade }) => {
      const bucket = getChoiceOptionBucket(grade);
      if (!optionMap.has(bucket)) {
        optionMap.set(bucket, []);
      }
      optionMap.get(bucket).push(studentName);
    });

    return {
      questionNo: question.questionNo,
      standardAnswer: question.standardAnswer,
      score: question.score,
      correctRate: completedCount > 0 ? correctCount / completedCount : 0,
      correctCount,
      wrongCount,
      blankCount,
      pendingCount,
      reviewCount,
      unavailableCount,
      optionStats: bucketOrder.map((option) => ({
        option,
        count: optionMap.get(option)?.length || 0,
        studentNames: sortNamesByLocale(optionMap.get(option) || []),
      })),
    };
  });
}

function buildChoiceGradingSnapshot(task, previousSnapshot, profile) {
  const choiceQuestions = getChoiceQuestionsForGrading(task);
  const previousStudentMap = buildPreviousChoiceGradeMap(previousSnapshot);
  const now = new Date().toISOString();
  let gradedQuestionCount = 0;
  let newlyGradedCount = 0;
  let updatedQuestionCount = 0;
  let pendingQuestionCount = 0;
  let reviewQuestionCount = 0;

  const studentSummaries = (task.studentRecords || []).map((student) => {
    const previousQuestionMap = previousStudentMap.get(student.studentName) || new Map();
    const answerMap = new Map((student.choiceAnswers || []).map((answer) => [answer.questionNo, answer]));
    const questionGrades = choiceQuestions.map((question) => {
      const current = buildChoiceGradeStatus(question, answerMap.get(question.questionNo) || null);
      const previous = previousQuestionMap.get(question.questionNo) || null;
      const signature = getChoiceGradeSignature(question, current);
      const isCompleted = current.status !== 'pending' && current.status !== 'unavailable';

      if (isCompleted) {
        gradedQuestionCount += 1;
      }
      if (current.status === 'pending') {
        pendingQuestionCount += 1;
      }
      if (current.status === 'review') {
        reviewQuestionCount += 1;
      }

      if (signature !== previous?.signature) {
        if (previous && (previous.status === 'correct' || previous.status === 'wrong' || previous.status === 'blank' || previous.status === 'review')) {
          if (isCompleted) {
            updatedQuestionCount += 1;
          }
        } else if (isCompleted) {
          newlyGradedCount += 1;
        }
      }

      return {
        questionNo: question.questionNo,
        answer: current.answer,
        standardAnswer: question.standardAnswer,
        questionScore: question.score,
        earnedScore: current.earnedScore,
        status: current.status,
        answerState: current.answerState,
        sourceLabels: answerMap.get(question.questionNo)?.sourceLabels || [],
        signature,
        gradedAt: signature === previous?.signature ? previous.gradedAt || now : now,
      };
    });

    return {
      studentId: student.id,
      studentName: student.studentName,
      isExtra: Boolean(student.isExtra),
      totalScore: questionGrades.reduce((sum, item) => sum + item.questionScore, 0),
      earnedScore: questionGrades.reduce((sum, item) => sum + item.earnedScore, 0),
      correctCount: questionGrades.filter((item) => item.status === 'correct').length,
      wrongCount: questionGrades.filter((item) => item.status === 'wrong').length,
      blankCount: questionGrades.filter((item) => item.status === 'blank').length,
      pendingCount: questionGrades.filter((item) => item.status === 'pending').length,
      reviewCount: questionGrades.filter((item) => item.status === 'review').length,
      unavailableCount: questionGrades.filter((item) => item.status === 'unavailable').length,
      questionGrades,
      updatedAt: student.updatedAt,
    };
  });

  return {
    profile,
    lastRunAt: now,
    studentCount: studentSummaries.length,
    questionCount: choiceQuestions.length,
    gradedQuestionCount,
    newlyGradedCount,
    updatedQuestionCount,
    pendingQuestionCount,
    reviewQuestionCount,
    studentSummaries,
    questionSummaries: buildChoiceQuestionSummaries(choiceQuestions, studentSummaries),
  };
}

function getEnabledSubjectiveQuestions(questions = []) {
  return questions
    .filter((question) => question.type !== 'choice' && question.enabled !== false)
    .sort((left, right) => compareQuestionNo(left.questionNo, right.questionNo));
}

function buildChoiceQuestionSnapshotSignatures(questions = []) {
  return questions
    .filter((question) => question.type === 'choice')
    .map((question) => ({
      questionNo: String(question.questionNo || '').trim(),
      type: 'choice',
      score: Number(question.score || 0),
      standardAnswer: String(question.standardAnswer || '')
        .toUpperCase()
        .replace(/[^A-D]/g, '')
        .slice(0, 1),
      enabled: question.enabled !== false,
    }))
    .sort((left, right) => compareQuestionNo(left.questionNo, right.questionNo))
    .map((question) => JSON.stringify(question));
}

function buildSubjectiveQuestionSnapshotSignatures(questions = []) {
  return questions
    .filter((question) => question.type !== 'choice')
    .map((question) => ({
      questionNo: String(question.questionNo || '').trim(),
      type: question.type === 'essay' ? 'essay' : 'subjective',
      score: Number(question.score || 0),
      content: String(question.content || '').trim(),
      standardAnswer: String(question.standardAnswer || '').trim(),
      gradingRule: String(question.gradingRule || '').trim(),
      gradingRuleTree: question.gradingRuleTree || null,
      essayRuleTree: question.essayRuleTree || null,
      enabled: question.enabled !== false,
    }))
    .sort((left, right) => compareQuestionNo(left.questionNo, right.questionNo))
    .map((question) => JSON.stringify(question));
}

function signaturesEqual(left = [], right = []) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function collectQuestionNos(records = []) {
  return getUniqueQuestionNos(records.map((item) => item?.questionNo));
}

function hasCurrentStudentSubmission(student) {
  if (!student) return false;

  return (
    (Array.isArray(student.sources) && student.sources.length > 0) ||
    (student.choiceAnswers || []).some((answer) => answer.hasOverride || answer.baseState !== 'missing') ||
    (student.subjectiveAnswers || []).some((answer) => answer.hasOverride || answer.baseState !== 'missing')
  );
}

function normalizeStudentExcerpt(excerpt, answer) {
  const text = String(excerpt ?? '').trim();
  if (!text) return '';
  return String(answer || '').includes(text) ? text : '';
}

function expandMatchedExcerptsForPointSplit(excerpts = []) {
  const normalized = Array.from(new Set((Array.isArray(excerpts) ? excerpts : []).map((item) => String(item || '').trim()).filter(Boolean)));
  const fragments = normalized.flatMap((excerpt) =>
    excerpt
      .split(/[，；。]/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 4),
  );
  return Array.from(new Set([...fragments, ...normalized]));
}

function splitLegacySubReviewForSnapshot(item, index, questionType) {
  const sectionLabel = String(item?.label || '').trim();
  const pointLabel = String(item?.pointLabel || item?.label || '').trim() || `Point ${index + 1}`;
  const scoreRaw = Number(item?.score ?? 0);
  const score = Number.isFinite(scoreRaw) ? Math.max(0, scoreRaw) : 0;
  const fullScoreRaw = Number(item?.fullScore ?? score);
  const fullScore = Number.isFinite(fullScoreRaw) ? Math.max(0, fullScoreRaw) : 0;
  const comment = String(item?.comment || '').trim();
  const matchedExcerpts = Array.isArray(item?.matchedExcerpts) ? item.matchedExcerpts : [];
  const splitExcerpts = expandMatchedExcerptsForPointSplit(matchedExcerpts);
  const requiredPartCount = Math.ceil(score / 2);
  const shouldSplit = score > 2 && splitExcerpts.length >= requiredPartCount;

  if (!shouldSplit) {
    return [{
      sectionLabel,
      pointLabel,
      score,
      fullScore,
      comment,
      matchedExcerpts,
    }];
  }

  const partCount = Math.max(2, Math.ceil(Math.max(score, fullScore) / 2));
  let remainingScore = score;
  let remainingFull = fullScore;
  const parts = [];

  for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
    const remainingSlots = partCount - partIndex - 1;
    const partFull = partIndex === partCount - 1
      ? remainingFull
      : Math.max(1, Math.min(2, remainingFull - remainingSlots));
    const partScore = partIndex === partCount - 1
      ? remainingScore
      : Math.min(partFull, remainingScore);
    const excerpt = splitExcerpts[partIndex] ? [splitExcerpts[partIndex]] : [];

    parts.push({
      sectionLabel,
      pointLabel: `${pointLabel} (Split ${partIndex + 1})`,
      score: Math.max(0, partScore),
      fullScore: Math.max(0, partFull),
      comment,
      matchedExcerpts: excerpt,
    });

    remainingScore = Math.max(0, remainingScore - partScore);
    remainingFull = Math.max(0, remainingFull - partFull);
  }

  return parts;
}

function normalizeOrdinaryAnchoredPointReviews(pointReviews = []) {
  const droppedPositivePoints = [];

  const normalizedPointReviews = (Array.isArray(pointReviews) ? pointReviews : []).map((item) => {
    const score = Math.max(0, Number(item?.score || 0));
    const matchedExcerpts = Array.isArray(item?.matchedExcerpts)
      ? item.matchedExcerpts.map((excerpt) => String(excerpt || '').trim()).filter(Boolean)
      : [];

    if (score > 0 && matchedExcerpts.length === 0) {
      droppedPositivePoints.push({
        key: String(item?.key || '').trim(),
        pointLabel: String(item?.pointLabel || '').trim(),
        score,
      });
      return {
        ...item,
        score: 0,
      };
    }

    return item;
  });

  return {
    pointReviews: normalizedPointReviews,
    droppedPositivePoints,
  };
}

function upgradeSubjectiveQuestionGradeSnapshot(question, student, grade, settings) {
  if (!question || !grade) return grade;

  const questionNo = String(question.questionNo || '').trim();
  const questionType = question.type === 'essay' ? 'essay' : 'subjective';
  const answerRecord = (student?.subjectiveAnswers || []).find((item) => String(item?.questionNo || '').trim() === questionNo);
  const studentAnswer = String(grade.studentAnswer || answerRecord?.content || '').trim();
  const sourceLabels = Array.isArray(grade.sourceLabels)
    ? grade.sourceLabels
    : (Array.isArray(answerRecord?.sourceLabels) ? answerRecord.sourceLabels : []);
  const rawPointReviews =
    Array.isArray(grade.pointReviews) && grade.pointReviews.length
      ? grade.pointReviews.flatMap((item, index) => splitLegacySubReviewForSnapshot(item, index, questionType))
      : (Array.isArray(grade.subReviews)
        ? grade.subReviews.flatMap((item, index) => splitLegacySubReviewForSnapshot(item, index, questionType))
        : []);
  const sectionContext = questionType === 'essay' ? null : buildOrdinarySectionContext({ question, answer: studentAnswer });

  const normalizedBasePointReviews = normalizePointReviews({
    questionType,
    question,
    answer: studentAnswer,
    sectionContext,
    pointReviews: rawPointReviews.map((item, index) => ({
      subquestionIndex: Number(item?.subquestionIndex ?? 0),
      sectionLabel: String(item?.sectionLabel || '').trim(),
      pointLabel: String(item?.pointLabel || item?.label || `瑕佺偣${index + 1}`).trim(),
      score: Number(item?.score ?? 0),
      fullScore: Number(item?.fullScore ?? 0),
      comment: String(item?.comment || '').trim(),
      matchedExcerpts: (Array.isArray(item?.matchedExcerpts) ? item.matchedExcerpts : [])
        .map((excerpt) => normalizeStudentExcerpt(excerpt, studentAnswer))
        .filter(Boolean),
    })),
  });
  const ordinaryAnchoredNormalization = questionType === 'essay'
    ? { pointReviews: normalizedBasePointReviews, droppedPositivePoints: [] }
    : normalizeOrdinaryAnchoredPointReviews(normalizedBasePointReviews);
  const normalizedPointReviews = ordinaryAnchoredNormalization.pointReviews;
  const droppedPositivePoints = ordinaryAnchoredNormalization.droppedPositivePoints;

  const sectionCommentsSource = Array.isArray(grade.sectionComments) && grade.sectionComments.length
    ? grade.sectionComments
    : (Array.isArray(grade.sectionReviews) && grade.sectionReviews.length
      ? grade.sectionReviews
      : (Array.isArray(grade.displaySubReviews) ? grade.displaySubReviews : []));
  const sectionComments = sectionCommentsSource
    .map((item) => ({
      subquestionIndex: Number(item?.subquestionIndex ?? 0),
      sectionLabel: String(item?.sectionLabel || item?.label || '').trim(),
      comment: String(item?.comment || '').trim(),
    }))
    .filter((item) => item.comment);

  const baseSectionReviews = buildSectionReviews({
    pointReviews: normalizedPointReviews,
    sectionComments,
    questionType,
    question,
    sectionContext,
    rolePreset: settings?.rolePreset,
    customRolePrompt: settings?.customRolePrompt,
  });
  const essayArtifacts = questionType === 'essay'
    ? buildEssayReviewArtifacts({
      question,
      answer: studentAnswer,
      essayReview: grade.essayReview,
      pointReviews: normalizedPointReviews,
      sectionReviews: baseSectionReviews,
    })
    : null;
  const pointReviews = essayArtifacts?.pointReviews || normalizedPointReviews;
  const sectionReviews = essayArtifacts?.sectionReviews || baseSectionReviews;
  const essayReview = essayArtifacts?.essayReview || null;

  const questionScore = Number(grade.questionScore ?? question.score ?? 0);
  const pointScoreSum = pointReviews.reduce((sum, item) => sum + Number(item.score || 0), 0);
  const hasPointReviews = pointReviews.length > 0;
  const earnedScoreRaw = Number(grade.earnedScore ?? 0);
  const normalizedReviewState = ['pending', 'confirmed', 'adjusted'].includes(String(grade.reviewState || ''))
    ? String(grade.reviewState)
    : '';
  const isReviewResolved = normalizedReviewState === 'confirmed' || normalizedReviewState === 'adjusted';
  const earnedScoreBase = normalizedReviewState === 'adjusted' ? earnedScoreRaw : (hasPointReviews ? pointScoreSum : earnedScoreRaw);
  const earnedScore = Math.max(0, Math.min(questionScore, Number.isFinite(earnedScoreBase) ? earnedScoreBase : 0));
  const savedQuestionComment = String(grade.questionComment || '').trim();
  const questionComment = normalizedReviewState === 'adjusted'
    ? savedQuestionComment
    : questionType === 'essay'
      ? (savedQuestionComment || buildQuestionComment({
        questionScore,
        earnedScore,
        questionType,
        pointReviews,
        sectionReviews,
        rolePreset: settings?.rolePreset,
        customRolePrompt: settings?.customRolePrompt,
      }))
      : (hasPointReviews
        ? buildQuestionComment({
          questionScore,
          earnedScore,
          questionType,
          pointReviews,
          sectionReviews,
          rolePreset: settings?.rolePreset,
          customRolePrompt: settings?.customRolePrompt,
        })
        : savedQuestionComment);
 
  const consistencyWarnings = [
    ...(droppedPositivePoints.length
      ? [`发现 ${droppedPositivePoints.length} 个旧版得分点未定位到学生原文，已改为待复核且暂不计分`]
      : []),
    ...buildSubjectiveConsistencyWarnings({
      questionScore,
      questionType,
      pointReviews,
      sectionReviews,
      annotationRanges: questionType === 'essay'
        ? []
        : buildAnnotationRanges({
          answer: studentAnswer,
          questionType,
          question,
          pointReviews,
          annotationErrors: (Array.isArray(grade?.annotations?.errors) ? grade.annotations.errors : [])
            .map((item) => ({
              excerpt: normalizeStudentExcerpt(item?.excerpt, studentAnswer),
              reason: String(item?.reason || '').trim(),
            }))
            .filter((item) => item.excerpt && item.reason),
          sectionContext,
        }),
      earnedScoreRaw,
      sectionContext,
      essayReview,
    }),
  ];

  const annotationErrors = (Array.isArray(grade?.annotations?.errors) ? grade.annotations.errors : [])
    .map((item) => ({
      excerpt: normalizeStudentExcerpt(item?.excerpt, studentAnswer),
      reason: String(item?.reason || '').trim(),
    }))
    .filter((item) => item.excerpt && item.reason);

  const annotationRanges = questionType === 'essay'
    ? []
    : buildAnnotationRanges({
      answer: studentAnswer,
      questionType,
      question,
      pointReviews,
      annotationErrors,
      sectionContext,
    });
  const requiresReview = isReviewResolved
    ? false
    : Boolean(grade.requiresReview) || Boolean(essayArtifacts?.requiresReview) || consistencyWarnings.length > 0;

  return {
    ...grade,
    questionNo,
    questionType,
    questionScore,
    earnedScore,
    originalEarnedScore: Number(grade.originalEarnedScore ?? grade.earnedScore ?? earnedScore),
    sourceLabels,
    studentAnswer,
    questionContent: String(grade.questionContent || question.content || '').trim(),
    standardAnswer: String(grade.standardAnswer || question.standardAnswer || '').trim(),
    gradingRule: String(grade.gradingRule || question.gradingRule || '').trim(),
    questionComment: consistencyWarnings.length
      ? `${questionComment || String(grade.questionComment || '').trim() || '本题已完成评分。'}\n系统提示：${consistencyWarnings.join('；')}。`
      : (questionComment || String(grade.questionComment || '').trim() || '本题已完成评分。'),
    essayReview,
    pointReviews,
    sectionReviews,
    annotationRanges,
    subReviews: pointReviews.map((item) => toLegacySubReview(item)),
    displaySubReviews: sectionReviews.map((item) => toLegacySubReview(item)),
    annotations: {
      matches: Array.from(new Set([
        ...pointReviews.flatMap((item) => item.matchedExcerpts || []),
        ...(Array.isArray(grade?.annotations?.matches) ? grade.annotations.matches : [])
          .map((excerpt) => normalizeStudentExcerpt(excerpt, studentAnswer))
          .filter(Boolean),
      ])),
      errors: annotationErrors,
    },
    requiresReview,
    reviewState: normalizedReviewState || (requiresReview ? 'pending' : undefined),
    reviewNote: String(grade.reviewNote || '').trim(),
    reviewedAt: String(grade.reviewedAt || '').trim(),
    reviewer: String(grade.reviewer || '').trim(),
  };
}

function sanitizeSubjectiveGradingSnapshot(task, snapshot, settings) {
  if (!snapshot) {
    return null;
  }

  const subjectiveQuestions = getEnabledSubjectiveQuestions(task.questions || []);
  if (!subjectiveQuestions.length) {
    return null;
  }

  const studentOrder = new Map((task.studentRecords || []).map((student, index) => [student.id, index]));
  const studentById = new Map((task.studentRecords || []).map((student) => [student.id, student]));
  const studentByName = new Map((task.studentRecords || []).map((student) => [student.studentName, student]));
  const questionOrder = new Map(subjectiveQuestions.map((question, index) => [String(question.questionNo || '').trim(), index]));
  const questionByNo = new Map(subjectiveQuestions.map((question) => [String(question.questionNo || '').trim(), question]));
  const totalScore = subjectiveQuestions.reduce((sum, question) => sum + Number(question.score || 0), 0);

  const studentSummaries = (snapshot.studentSummaries || [])
    .map((summary) => {
      const student = studentById.get(summary.studentId) || studentByName.get(summary.studentName);
      if (!student || !hasCurrentStudentSubmission(student)) {
        return null;
      }

      const questionGrades = (summary.questionGrades || [])
        .filter((grade) => questionOrder.has(String(grade.questionNo || '').trim()))
        .map((grade) => upgradeSubjectiveQuestionGradeSnapshot(
          questionByNo.get(String(grade.questionNo || '').trim()),
          student,
          grade,
          settings,
        ))
        .sort(
          (left, right) =>
            (questionOrder.get(String(left.questionNo || '').trim()) ?? Number.MAX_SAFE_INTEGER) -
            (questionOrder.get(String(right.questionNo || '').trim()) ?? Number.MAX_SAFE_INTEGER),
        );

      if (!questionGrades.length) {
        return null;
      }

      const earnedScore = questionGrades.reduce((sum, grade) => sum + Number(grade.earnedScore || 0), 0);

      return {
        ...summary,
        studentId: student.id,
        studentName: student.studentName,
        isExtra: Boolean(student.isExtra),
        totalScore,
        earnedScore,
        gradedQuestionCount: questionGrades.length,
        pendingQuestionCount: Math.max(0, subjectiveQuestions.length - questionGrades.length),
        reviewQuestionCount: questionGrades.filter((grade) => grade.requiresReview).length,
        overallComment: buildOverallComment({
          totalScore,
          earnedScore,
          questionGrades,
          rolePreset: settings?.rolePreset,
          customRolePrompt: settings?.customRolePrompt,
        }),
        questionGrades,
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        (studentOrder.get(left.studentId) ?? Number.MAX_SAFE_INTEGER) -
        (studentOrder.get(right.studentId) ?? Number.MAX_SAFE_INTEGER),
    );

  if (!studentSummaries.length) {
    return null;
  }

  return {
    ...snapshot,
    studentCount: task.studentRecords.length,
    questionCount: subjectiveQuestions.length,
    selectedQuestionCount: Math.max(1, Math.min(Number(snapshot.selectedQuestionCount || subjectiveQuestions.length), subjectiveQuestions.length)),
    gradedStudentCount: studentSummaries.filter((student) => student.gradedQuestionCount > 0).length,
    gradedQuestionCount: studentSummaries.reduce((sum, student) => sum + Number(student.gradedQuestionCount || 0), 0),
    pendingQuestionCount: studentSummaries.reduce((sum, student) => sum + Number(student.pendingQuestionCount || 0), 0),
    reviewQuestionCount: studentSummaries.reduce((sum, student) => sum + Number(student.reviewQuestionCount || 0), 0),
    studentSummaries,
  };
}

function mergeGradingInvalidationChanges(changes = []) {
  const merged = new Map();

  changes.forEach((change) => {
    const studentName = String(change?.studentName || '').trim();
    if (!studentName) {
      return;
    }

    if (!merged.has(studentName)) {
      merged.set(studentName, {
        choiceQuestionNos: new Set(),
        subjectiveQuestionNos: new Set(),
      });
    }

    const target = merged.get(studentName);
    collectQuestionNos(change?.choiceAnswers || []).forEach((questionNo) => target.choiceQuestionNos.add(questionNo));
    collectQuestionNos(change?.subjectiveAnswers || []).forEach((questionNo) => target.subjectiveQuestionNos.add(questionNo));
    (Array.isArray(change?.choiceQuestionNos) ? change.choiceQuestionNos : []).forEach((questionNo) => {
      const normalized = String(questionNo || '').trim();
      if (normalized) target.choiceQuestionNos.add(normalized);
    });
    (Array.isArray(change?.subjectiveQuestionNos) ? change.subjectiveQuestionNos : []).forEach((questionNo) => {
      const normalized = String(questionNo || '').trim();
      if (normalized) target.subjectiveQuestionNos.add(normalized);
    });
  });

  return merged;
}

function invalidateTaskGradings(state, taskId, changes = []) {
  const changesByStudent = mergeGradingInvalidationChanges(changes);
  if (!changesByStudent.size) {
    return;
  }

  const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
  if (taskIndex < 0) {
    return;
  }

  const task = state.tasks[taskIndex];

  if (task.choiceGrading) {
    const studentSummaries = (task.choiceGrading.studentSummaries || []).filter(
      (summary) => {
        const change = changesByStudent.get(String(summary.studentName || '').trim());
        return !change || change.choiceQuestionNos.size === 0;
      },
    );
    state.tasks[taskIndex].choiceGrading = studentSummaries.length ? { ...task.choiceGrading, studentSummaries } : null;
    state.tasks[taskIndex].choiceExplanation = null;
  }

  if (task.subjectiveGrading) {
    const studentSummaries = (task.subjectiveGrading.studentSummaries || [])
      .map((summary) => {
        const change = changesByStudent.get(String(summary.studentName || '').trim());
        if (!change || change.subjectiveQuestionNos.size === 0) {
          return summary;
        }

        const questionGrades = (summary.questionGrades || []).filter(
          (grade) => !change.subjectiveQuestionNos.has(String(grade.questionNo || '').trim()),
        );

        if (!questionGrades.length) {
          return null;
        }

        return {
          ...summary,
          questionGrades,
        };
      })
      .filter(Boolean);
    state.tasks[taskIndex].subjectiveGrading = studentSummaries.length ? { ...task.subjectiveGrading, studentSummaries } : null;
  }
}

function listAnswerSheets(taskId) {
  const state = loadState();
  return state.answerSheets
    .filter((item) => item.taskId === taskId)
    .sort((a, b) => {
      if (a.createdAt === b.createdAt) {
        return Number(a.sourcePage ?? 0) - Number(b.sourcePage ?? 0);
      }

      return a.createdAt.localeCompare(b.createdAt);
    })
    .map(sanitizeAnswerSheetRecord);
}

function listTasks() {
  const state = loadState();
  return state.tasks
    .map((task) => ({
      id: task.id,
      name: task.name,
      className: task.className,
      mode: task.mode,
      status: task.status,
      version: task.version,
      updatedAt: task.updatedAt,
      questionCount: state.questions.filter((question) => question.taskId === task.id).length,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function getTaskDetailFromState(state, taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return null;

  const questions = state.questions
    .filter((item) => item.taskId === taskId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(({ taskId: _taskId, sortOrder: _sortOrder, createdAt: _createdAt, updatedAt: _updatedAt, ...question }) => applyAutoSplitGradingRule(question));

  const uploads = state.uploads
    .filter((item) => item.taskId === taskId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ taskId: _taskId, storedName: _storedName, storedPath: _storedPath, ...upload }) => ({
      ...upload,
      originalName: repairUploadName(upload.originalName),
    }));

  const answerSheets = listAnswerSheets(taskId);
  const classroom = findMatchingClassroom(state.settings.classrooms, task.className);
  const classroomStudents = splitStudentNames(classroom?.studentsText ?? '');
  const studentRecords = buildStudentRecords(
    { ...task, questions },
    answerSheets,
    (state.studentSummaries || []).filter((item) => item.taskId === taskId),
    classroomStudents,
  );

  const detail = {
    ...task,
    questionCount: questions.length,
    questions,
    uploads,
    answerSheets,
    studentRecords,
  };

  return {
    ...detail,
    choiceGrading: task.choiceGrading ?? null,
    subjectiveGrading: sanitizeSubjectiveGradingSnapshot(detail, task.subjectiveGrading ?? null, state.settings ?? {}),
  };
}

function createTask(mode) {
  const state = loadState();
  const task = {
    id: crypto.randomUUID(),
    name: `鏂颁换鍔?${new Date().toLocaleString('zh-CN')}`,
    className: '',
    homeworkDate: '',
    mode,
    questionScope: '',
    description: '',
    status: 'draft',
    version: 1,
    choiceGrading: null,
    choiceExplanation: null,
    subjectiveGrading: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  state.tasks.unshift(task);
  saveState(state);
  return getTaskDetail(task.id);
}

function getTaskDetail(taskId) {
  const state = loadState();
  const detail = getTaskDetailFromState(state, taskId);
  if (!detail) {
    return null;
  }

  const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
  if (taskIndex >= 0) {
    const previousSnapshot = state.tasks[taskIndex].subjectiveGrading ?? null;
    const nextSnapshot = detail.subjectiveGrading ?? null;
    if (JSON.stringify(previousSnapshot) !== JSON.stringify(nextSnapshot)) {
      state.tasks[taskIndex] = {
        ...state.tasks[taskIndex],
        subjectiveGrading: nextSnapshot,
        updatedAt: new Date().toISOString(),
      };
      saveState(state);
    }
  }

  return detail;
}

function runChoiceGrading(taskId) {
  const detail = getTaskDetail(taskId);
  if (!detail) {
    throw new Error('任务不存在。');
  }

  const state = loadState();
  const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
  if (taskIndex < 0) {
    throw new Error('任务不存在。');
  }

  state.tasks[taskIndex] = {
    ...state.tasks[taskIndex],
    choiceGrading: buildChoiceGradingSnapshot(detail, state.tasks[taskIndex].choiceGrading || null, 'general'),
    choiceExplanation: null,
    updatedAt: new Date().toISOString(),
  };
  saveState(state);

  return getTaskDetail(taskId);
}

function saveTaskSubjectiveGrading(taskId, subjectiveGrading) {
  const state = loadState();
  const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
  if (taskIndex < 0) {
    throw new Error('任务不存在。');
  }

  state.tasks[taskIndex] = {
    ...state.tasks[taskIndex],
    subjectiveGrading,
    updatedAt: new Date().toISOString(),
  };
  saveState(state);

  return getTaskDetail(taskId);
}

function clearTaskSubjectiveGrading(taskId) {
  const state = loadState();
  const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
  if (taskIndex < 0) {
    throw new Error('任务不存在。');
  }

  state.tasks[taskIndex] = {
    ...state.tasks[taskIndex],
    subjectiveGrading: null,
    updatedAt: new Date().toISOString(),
  };
  saveState(state);

  return getTaskDetail(taskId);
}

function updateTaskBasic(taskId, payload) {
  const state = loadState();
  const index = state.tasks.findIndex((item) => item.id === taskId);
  if (index < 0) {
    throw new Error('任务不存在。');
  }

  state.tasks[index] = {
    ...state.tasks[index],
    name: payload.name ?? '',
    className: (findMatchingClassroom(state.settings.classrooms, payload.className ?? '')?.name ?? payload.className ?? ''),
    homeworkDate: payload.homeworkDate ?? '',
    mode: payload.mode ?? 'choice',
    questionScope: payload.questionScope ?? '',
    description: payload.description ?? '',
    updatedAt: new Date().toISOString(),
  };

  saveState(state);
  return getTaskDetail(taskId);
}

function replaceTaskQuestions(taskId, questions) {
  const state = loadState();
  const normalizedQuestions = (Array.isArray(questions) ? questions : []).map((question) => applyAutoSplitGradingRule(question));
  const existingTaskQuestions = state.questions.filter((item) => item.taskId === taskId);
  const previousChoiceQuestionSignatures = buildChoiceQuestionSnapshotSignatures(existingTaskQuestions);
  const previousSubjectiveQuestionSignatures = buildSubjectiveQuestionSnapshotSignatures(existingTaskQuestions);
  const nextChoiceQuestionSignatures = buildChoiceQuestionSnapshotSignatures(normalizedQuestions);
  const nextSubjectiveQuestionSignatures = buildSubjectiveQuestionSnapshotSignatures(normalizedQuestions);
  state.questions = state.questions.filter((item) => item.taskId !== taskId);

  const now = new Date().toISOString();
  normalizedQuestions.forEach((question, index) => {
    state.questions.push({
      id: question.id ?? crypto.randomUUID(),
      taskId,
      questionNo: question.questionNo ?? String(index + 1),
      type: question.type ?? 'choice',
      score: Number(question.score ?? 0),
      content: question.content ?? '',
      standardAnswer: question.standardAnswer ?? '',
      analysis: question.analysis ?? '',
      gradingRule: question.gradingRule ?? '',
      gradingRuleTree: question.gradingRuleTree ?? null,
      essayRuleTree: question.essayRuleTree ?? null,
      tags: question.tags ?? [],
      enabled: Boolean(question.enabled),
      source: question.source ?? 'manual',
      sortOrder: index,
      createdAt: now,
      updatedAt: now,
    });
  });

  const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
  if (taskIndex >= 0) {
    state.tasks[taskIndex].updatedAt = now;
    if (!signaturesEqual(previousChoiceQuestionSignatures, nextChoiceQuestionSignatures)) {
      state.tasks[taskIndex].choiceGrading = null;
      state.tasks[taskIndex].choiceExplanation = null;
    }
    if (!signaturesEqual(previousSubjectiveQuestionSignatures, nextSubjectiveQuestionSignatures)) {
      state.tasks[taskIndex].subjectiveGrading = null;
    }
  }

  saveState(state);
  return getTaskDetail(taskId);
}

function addUploads(taskId, kind, files) {
  const state = loadState();
  const now = new Date().toISOString();

  files.forEach((file) => {
    state.uploads.push({
      id: crypto.randomUUID(),
      taskId,
      kind,
      originalName: repairUploadName(file.originalname),
      storedName: file.filename,
      storedPath: file.path,
      mimeType: file.mimetype,
      size: file.size,
      createdAt: now,
    });
  });

  const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
  if (taskIndex >= 0) {
    state.tasks[taskIndex].updatedAt = now;
  }

  saveState(state);
}

function addAnswerSheets(taskId, sheets) {
  const state = loadState();
  const now = new Date().toISOString();

  sheets.forEach((sheet) => {
    state.answerSheets.push({
      id: crypto.randomUUID(),
      taskId,
      sourceOriginalName: repairUploadName(sheet.sourceOriginalName),
      sourcePage: Number(sheet.sourcePage ?? 1),
      displayName: repairUploadName(sheet.displayName || sheet.sourceOriginalName),
      storedName: sheet.storedName,
      storedPath: sheet.storedPath,
      mimeType: sheet.mimeType || 'image/jpeg',
      size: Number(sheet.size ?? 0),
      status: 'pending',
      engine: '',
      profile: '',
      provider: '',
      selectedModel: '',
      studentName: '',
      manualStudentName: '',
      observedNames: [],
      suggestedStudentName: '',
      suggestedStudentConfidence: 0,
      choiceAnswers: [],
      subjectiveAnswers: [],
      warnings: [],
      errorMessage: '',
      createdAt: now,
      updatedAt: now,
      recognizedAt: '',
    });
  });

  const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
  if (taskIndex >= 0) {
    state.tasks[taskIndex].updatedAt = now;
  }

  saveState(state);
  return listAnswerSheets(taskId);
}

function listUploadsByKind(taskId, kind) {
  const state = loadState();
  return state.uploads
    .filter((item) => item.taskId === taskId && item.kind === kind)
    .map((item) => ({
      ...item,
      storedPath: resolveStoredFilePath(item.storedPath, item.taskId, item.storedName),
    }));
}

function deleteUpload(taskId, uploadId) {
  const state = loadState();
  const index = state.uploads.findIndex((item) => item.taskId === taskId && item.id === uploadId);
  if (index < 0) {
    throw new Error('上传文件不存在。');
  }

  const [upload] = state.uploads.splice(index, 1);
  const now = new Date().toISOString();
  const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
  if (taskIndex >= 0) {
    state.tasks[taskIndex].updatedAt = now;
  }

  saveState(state);
  if (upload?.storedPath) {
    fs.rmSync(upload.storedPath, { force: true });
  }
}

function getAnswerSheetRecord(taskId, sheetId) {
  const state = loadState();
  return state.answerSheets.find((item) => item.taskId === taskId && item.id === sheetId) || null;
}

function updateAnswerSheet(taskId, sheetId, patch) {
  const state = loadState();
  const index = state.answerSheets.findIndex((item) => item.taskId === taskId && item.id === sheetId);
  if (index < 0) {
    throw new Error('答题卡记录不存在。');
  }

  const previousSheet = state.answerSheets[index];
  const now = new Date().toISOString();
  state.answerSheets[index] = {
    ...state.answerSheets[index],
    ...patch,
    sourceOriginalName: repairUploadName(patch.sourceOriginalName ?? state.answerSheets[index].sourceOriginalName),
    displayName: repairUploadName(patch.displayName ?? state.answerSheets[index].displayName),
    manualStudentName: String(patch.manualStudentName ?? state.answerSheets[index].manualStudentName ?? '').trim(),
    observedNames: sanitizeObservedNames(patch.observedNames ?? state.answerSheets[index].observedNames),
    suggestedStudentName: String(patch.suggestedStudentName ?? state.answerSheets[index].suggestedStudentName ?? '').trim(),
    suggestedStudentConfidence: Number.isFinite(Number(patch.suggestedStudentConfidence))
      ? Math.max(0, Math.min(1, Number(patch.suggestedStudentConfidence)))
      : Number.isFinite(Number(state.answerSheets[index].suggestedStudentConfidence))
        ? Math.max(0, Math.min(1, Number(state.answerSheets[index].suggestedStudentConfidence)))
        : 0,
    choiceAnswers: sanitizeChoiceAnswers(patch.choiceAnswers ?? state.answerSheets[index].choiceAnswers),
    subjectiveAnswers: sanitizeSubjectiveAnswers(patch.subjectiveAnswers ?? state.answerSheets[index].subjectiveAnswers),
    warnings: Array.isArray(patch.warnings) ? patch.warnings.filter(Boolean).map(String) : state.answerSheets[index].warnings,
    updatedAt: now,
    recognizedAt: patch.recognizedAt ?? state.answerSheets[index].recognizedAt,
  };

  invalidateTaskGradings(state, taskId, [
    {
      studentName: getResolvedSheetStudentName(previousSheet),
      choiceAnswers: previousSheet.choiceAnswers || [],
      subjectiveAnswers: previousSheet.subjectiveAnswers || [],
    },
    {
      studentName: getResolvedSheetStudentName(state.answerSheets[index]),
      choiceAnswers: state.answerSheets[index].choiceAnswers || [],
      subjectiveAnswers: state.answerSheets[index].subjectiveAnswers || [],
    },
  ]);

  const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
  if (taskIndex >= 0) {
    state.tasks[taskIndex].updatedAt = now;
  }

  saveState(state);
  return sanitizeAnswerSheetRecord(state.answerSheets[index]);
}

function recoverInterruptedAnswerSheetRecognitions() {
  const state = loadState();
  const now = new Date().toISOString();
  const recoveredSheets = [];
  const affectedTaskIds = new Set();

  state.answerSheets = state.answerSheets.map((sheet) => {
    if (sheet.status !== 'processing') {
      return sheet;
    }

    affectedTaskIds.add(sheet.taskId);
    recoveredSheets.push({
      taskId: sheet.taskId,
      sheetId: sheet.id,
      displayName: repairUploadName(sheet.displayName || sheet.sourceOriginalName || sheet.id),
    });

    return {
      ...sheet,
      status: 'error',
      errorMessage: INTERRUPTED_ANSWER_SHEET_ERROR_MESSAGE,
      updatedAt: now,
    };
  });

  if (!recoveredSheets.length) {
    return {
      recoveredCount: 0,
      taskCount: 0,
      recoveredSheets: [],
    };
  }

  state.tasks = state.tasks.map((task) =>
    affectedTaskIds.has(task.id)
      ? {
          ...task,
          updatedAt: now,
        }
      : task,
  );

  saveState(state);

  return {
    recoveredCount: recoveredSheets.length,
    taskCount: affectedTaskIds.size,
    recoveredSheets,
  };
}

function upsertStudentSummary(taskId, payload) {
  const state = loadState();
  const studentName = String(payload?.studentName ?? '').trim();
  if (!studentName) {
    throw new Error('学生姓名不能为空。');
  }

  const choiceOverrides = sanitizeChoiceAnswers(payload.choiceOverrides || []);
  const subjectiveOverrides = sanitizeSubjectiveAnswers(payload.subjectiveOverrides || []);
  const now = new Date().toISOString();
  const index = state.studentSummaries.findIndex((item) => item.taskId === taskId && item.studentName === studentName);
  const previousSummary = index >= 0 ? state.studentSummaries[index] : null;
  const isEmptySummary = choiceOverrides.length === 0 && subjectiveOverrides.length === 0;

  if (isEmptySummary && index < 0) {
    return getTaskDetail(taskId);
  }

  if (isEmptySummary) {
    state.studentSummaries.splice(index, 1);
  } else if (index < 0) {
    state.studentSummaries.push({
      id: crypto.randomUUID(),
      taskId,
      studentName,
      choiceOverrides,
      subjectiveOverrides,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    state.studentSummaries[index] = {
      ...state.studentSummaries[index],
      choiceOverrides,
      subjectiveOverrides,
      updatedAt: now,
    };
  }

  const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
  if (taskIndex >= 0) {
    state.tasks[taskIndex].updatedAt = now;
  }

  invalidateTaskGradings(state, taskId, [
    {
      studentName,
      choiceQuestionNos: collectQuestionNos(previousSummary?.choiceOverrides || []),
      subjectiveQuestionNos: collectQuestionNos(previousSummary?.subjectiveOverrides || []),
    },
    {
      studentName,
      choiceQuestionNos: collectQuestionNos(choiceOverrides),
      subjectiveQuestionNos: collectQuestionNos(subjectiveOverrides),
    },
  ]);

  saveState(state);
  return getTaskDetail(taskId);
}

function deleteAnswerSheet(taskId, sheetId) {
  const state = loadState();
  const index = state.answerSheets.findIndex((item) => item.taskId === taskId && item.id === sheetId);
  if (index < 0) {
    throw new Error('答题卡记录不存在。');
  }

  const [sheet] = state.answerSheets.splice(index, 1);
  invalidateTaskGradings(state, taskId, [
    {
      studentName: getResolvedSheetStudentName(sheet),
      choiceAnswers: sheet.choiceAnswers || [],
      subjectiveAnswers: sheet.subjectiveAnswers || [],
    },
  ]);
  const now = new Date().toISOString();
  const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
  if (taskIndex >= 0) {
    state.tasks[taskIndex].updatedAt = now;
  }

  saveState(state);
  if (sheet?.storedPath) {
    fs.rmSync(sheet.storedPath, { force: true });
  }
}

function deleteTask(taskId) {
  const state = loadState();
  const exists = state.tasks.some((item) => item.id === taskId);
  if (!exists) {
    throw new Error('任务不存在。');
  }

  state.tasks = state.tasks.filter((item) => item.id !== taskId);
  state.questions = state.questions.filter((item) => item.taskId !== taskId);
  state.uploads = state.uploads.filter((item) => item.taskId !== taskId);
  state.answerSheets = state.answerSheets.filter((item) => item.taskId !== taskId);
  state.studentSummaries = state.studentSummaries.filter((item) => item.taskId !== taskId);
  saveState(state);

  fs.rmSync(path.join(uploadDir, taskId), { recursive: true, force: true });
}

function saveTaskChoiceExplanation(taskId, choiceExplanation) {
  const state = loadState();
  const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
  if (taskIndex < 0) {
    throw new Error('任务不存在。');
  }

  state.tasks[taskIndex] = {
    ...state.tasks[taskIndex],
    choiceExplanation: sanitizeChoiceExplanationSnapshot(choiceExplanation),
    updatedAt: new Date().toISOString(),
  };
  saveState(state);
  return getTaskDetail(taskId);
}

function clearTaskChoiceExplanation(taskId) {
  const state = loadState();
  const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
  if (taskIndex < 0) {
    throw new Error('任务不存在。');
  }

  state.tasks[taskIndex] = {
    ...state.tasks[taskIndex],
    choiceExplanation: null,
    updatedAt: new Date().toISOString(),
  };
  saveState(state);
  return getTaskDetail(taskId);
}

module.exports = {
  uploadDir,
  getSettings,
  saveSettings,
  clearAppCacheStorage,
  clearAppDataStorage,
  listTasks,
  createTask,
  getTaskDetail,
  runChoiceGrading,
  saveTaskChoiceExplanation,
  clearTaskChoiceExplanation,
  saveTaskSubjectiveGrading,
  clearTaskSubjectiveGrading,
  updateTaskBasic,
  replaceTaskQuestions,
  addUploads,
  addAnswerSheets,
  listAnswerSheets,
  listUploadsByKind,
  deleteUpload,
  getAnswerSheetRecord,
  updateAnswerSheet,
  recoverInterruptedAnswerSheetRecognitions,
  upsertStudentSummary,
  deleteAnswerSheet,
  deleteTask,
};
