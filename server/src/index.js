const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const {
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
  listUploadsByKind,
  deleteUpload,
  getAnswerSheetRecord,
  updateAnswerSheet,
  recoverInterruptedAnswerSheetRecognitions,
  upsertStudentSummary,
  deleteAnswerSheet,
  deleteTask,
} = require('./db');
const {
  testConnection,
  extractMaterialDrafts,
  recognizeAnswerSheet,
  generateChoiceQuestionExplanations,
  gradeSubjectiveQuestions,
  generateEssayThesisSuggestions,
  generatePointAliasSuggestions,
  clearModelResolutionCache,
  clearAnswerSheetRecognitionCache,
} = require('./doubao');
const { splitUploadedAnswerSheets } = require('./answerSheets');
const { normalizeUpload } = require('./files');
const { buildSubjectiveGradingDocx } = require('./subjectiveExport');
const { buildChoiceExplanationDocx } = require('./choiceExplanationExport');
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

const app = express();
const rootDir = path.resolve(__dirname, '..', '..');
const frontendDistDir = path.join(rootDir, 'frontend', 'dist');
const frontendIndexPath = path.join(frontendDistDir, 'index.html');
const host = String(process.env.HISTORY_AI_HOST || process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
const configuredPort = Number(process.env.HISTORY_AI_PORT || process.env.PORT || 3857);
const port = Number.isFinite(configuredPort) ? configuredPort : 3857;
const ANSWER_SHEET_BATCH_CONCURRENCY = 2;
const ANSWER_SHEET_BATCH_POLL_INTERVAL_MS = 2000;
const MAX_STORED_ANSWER_SHEET_BATCH_JOBS = 30;
const answerSheetBatchJobs = new Map();
const activeAnswerSheetBatchJobs = new Map();

const storage = multer.diskStorage({
  destination: (req, file, callback) => {
    const targetDir = path.join(uploadDir, req.params.taskId);
    fs.mkdirSync(targetDir, { recursive: true });
    callback(null, targetDir);
  },
  filename: (req, file, callback) => {
    const normalizedOriginalName =
      /^[\x00-\xff]+$/.test(file.originalname) ? Buffer.from(file.originalname, 'latin1').toString('utf8') : file.originalname;
    file.originalname = normalizedOriginalName;
    callback(null, `${Date.now()}-${normalizedOriginalName.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_')}`);
  },
});

const upload = multer({ storage });

app.use(cors());
app.use(express.json({ limit: '12mb' }));

process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[process] Uncaught exception:', error);
});

function compareQuestionNo(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function getEnabledSubjectiveQuestions(task) {
  return (task?.questions || [])
    .filter((question) => question.type !== 'choice' && question.enabled !== false)
    .sort((left, right) => compareQuestionNo(left.questionNo, right.questionNo));
}

function uniqueQuestionNos(values = []) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean))).sort(compareQuestionNo);
}

function normalizeRequestedQuestionNos(values = []) {
  if (!Array.isArray(values)) {
    return [];
  }

  return uniqueQuestionNos(values);
}

function getChoiceQuestionSummaries(task) {
  return Array.isArray(task?.choiceGrading?.questionSummaries) ? task.choiceGrading.questionSummaries : [];
}

function getChoiceExplanationTopWrongOption(summary) {
  const standardAnswer = String(summary?.standardAnswer || '')
    .toUpperCase()
    .replace(/[^A-D]/g, '')
    .slice(0, 1);
  const optionStats = Array.isArray(summary?.optionStats) ? summary.optionStats : [];
  const topWrongOption = optionStats
    .filter((item) => {
      const option = String(item?.option || '')
        .toUpperCase()
        .replace(/[^A-D]/g, '')
        .slice(0, 1);
      return option && option !== standardAnswer && Number(item?.count || 0) > 0;
    })
    .sort((left, right) => Number(right?.count || 0) - Number(left?.count || 0))[0];

  return {
    topWrongOption: String(topWrongOption?.option || '')
      .toUpperCase()
      .replace(/[^A-D]/g, '')
      .slice(0, 1),
    topWrongOptionCount: Number.isFinite(Number(topWrongOption?.count))
      ? Math.max(0, Math.floor(Number(topWrongOption.count)))
      : 0,
  };
}

function mergeChoiceExplanationQuestionsWithStats(questions, questionSummaries, selectedQuestionNos = []) {
  const summaryMap = new Map(
    (Array.isArray(questionSummaries) ? questionSummaries : []).map((item) => [String(item?.questionNo || '').trim(), item]),
  );
  const generatedMap = new Map(
    (Array.isArray(questions) ? questions : [])
      .map((item) => [String(item?.questionNo || '').trim(), item])
      .filter(([questionNo]) => questionNo),
  );

  const orderedQuestionNos = [
    ...normalizeRequestedQuestionNos(selectedQuestionNos).filter((questionNo) => generatedMap.has(questionNo)),
    ...Array.from(generatedMap.keys()).filter((questionNo) => !selectedQuestionNos.includes(questionNo)).sort(compareQuestionNo),
  ];

  return orderedQuestionNos.map((questionNo) => {
    const question = generatedMap.get(questionNo);
    const summary = summaryMap.get(questionNo);
    const topWrong = getChoiceExplanationTopWrongOption(summary);

    return {
      ...question,
      correctAnswer: String(summary?.standardAnswer || question?.correctAnswer || '')
        .toUpperCase()
        .replace(/[^A-D]/g, '')
        .slice(0, 1),
      correctRate: Number.isFinite(Number(summary?.correctRate)) ? Math.max(0, Math.min(1, Number(summary.correctRate))) : null,
      wrongCount: Number.isFinite(Number(summary?.wrongCount)) ? Math.max(0, Math.floor(Number(summary.wrongCount))) : 0,
      topWrongOption: topWrong.topWrongOption,
      topWrongOptionCount: topWrong.topWrongOptionCount,
    };
  });
}

function filterRecognizedAnswersByQuestionNos(result, retainQuestionNos = []) {
  const normalizedRetainQuestionNos = normalizeRequestedQuestionNos(retainQuestionNos);
  if (!normalizedRetainQuestionNos.length) {
    return result;
  }

  const retainQuestionNoSet = new Set(normalizedRetainQuestionNos);
  const choiceAnswers = Array.isArray(result?.choiceAnswers) ? result.choiceAnswers : [];
  const subjectiveAnswers = Array.isArray(result?.subjectiveAnswers) ? result.subjectiveAnswers : [];
  const filteredChoiceAnswers = choiceAnswers.filter((item) => retainQuestionNoSet.has(String(item?.questionNo || '').trim()));
  const filteredSubjectiveAnswers = subjectiveAnswers.filter((item) => retainQuestionNoSet.has(String(item?.questionNo || '').trim()));
  const droppedQuestionNos = uniqueQuestionNos([
    ...choiceAnswers
      .map((item) => String(item?.questionNo || '').trim())
      .filter((questionNo) => questionNo && !retainQuestionNoSet.has(questionNo)),
    ...subjectiveAnswers
      .map((item) => String(item?.questionNo || '').trim())
      .filter((questionNo) => questionNo && !retainQuestionNoSet.has(questionNo)),
  ]);

  return {
    ...result,
    choiceAnswers: filteredChoiceAnswers,
    subjectiveAnswers: filteredSubjectiveAnswers,
    warnings: [
      ...(Array.isArray(result?.warnings) ? result.warnings.filter(Boolean).map(String) : []),
      ...(droppedQuestionNos.length
        ? [`已按保留题号过滤，忽略本页题号：${droppedQuestionNos.join('、')}。`]
        : []),
    ],
  };
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

  return classrooms.find((item) => normalizeClassroomName(item?.name) === normalizedTarget) || null;
}

function getTaskClassroomStudents(settings, task) {
  const classroom = findMatchingClassroom(settings.classrooms, task.className);
  return String(classroom?.studentsText ?? '')
    .split(/[\s,\n\r\uFF0C\u3001\uFF1B;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getConfiguredAnswerSheetBatchConcurrency(settings) {
  const configured = Number(settings?.answerSheetBatchConcurrency ?? ANSWER_SHEET_BATCH_CONCURRENCY);
  if (!Number.isFinite(configured)) {
    return ANSWER_SHEET_BATCH_CONCURRENCY;
  }
  return Math.max(1, Math.min(6, Math.floor(configured)));
}

function createAnswerSheetBatchJobSnapshot(job) {
  return {
    id: job.id,
    taskId: job.taskId,
    profile: job.profile,
    engine: job.engine,
    status: job.status,
    requestedCount: job.requestedCount,
    processedCount: job.processedCount,
    successCount: job.successCount,
    errorCount: job.errorCount,
    workerCount: job.workerCount,
    failedSheets: job.failedSheets,
    message: job.message,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

function pruneStoredAnswerSheetBatchJobs() {
  if (answerSheetBatchJobs.size <= MAX_STORED_ANSWER_SHEET_BATCH_JOBS) {
    return;
  }

  const removableJobs = Array.from(answerSheetBatchJobs.values())
    .filter((job) => !['queued', 'running'].includes(job.status))
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));

  while (answerSheetBatchJobs.size > MAX_STORED_ANSWER_SHEET_BATCH_JOBS && removableJobs.length) {
    const job = removableJobs.shift();
    if (!job) break;
    answerSheetBatchJobs.delete(job.id);
  }
}

function normalizeAnswerSheetProfile(profile) {
  const normalized = String(profile || '').trim();
  return ['general', 'answerSheet', 'normal', 'strong'].includes(normalized) ? normalized : 'general';
}

function normalizeSubjectiveGradingProfile(profile) {
  const normalized = String(profile || '').trim();
  if (normalized === 'subjectiveGrading') return 'subjectiveGrading';
  if (normalized === 'general' || normalized === 'normal' || normalized === 'strong') return 'general';
  return 'general';
}

function encodeDownloadFileName(value) {
  return encodeURIComponent(String(value || 'subjective-grading-export.docx')).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function getQuestionNoKey(question) {
  return String(question?.questionNo || '').trim();
}

function mergeExtractedQuestionWithExisting(existingQuestion, extractedQuestion) {
  const keepManualValues = existingQuestion?.source === 'manual';
  const existingScore = Number(existingQuestion?.score || 0);
  const extractedScore = Number(extractedQuestion?.score || 0);
  const existingContent = String(existingQuestion?.content || '').trim();
  const existingStandardAnswer = String(existingQuestion?.standardAnswer || '').trim();
  const existingAnalysis = String(existingQuestion?.analysis || '').trim();
  const existingGradingRule = String(existingQuestion?.gradingRule || '').trim();
  const existingGradingRuleTree = existingQuestion?.gradingRuleTree ?? null;
  const existingEssayRuleTree = existingQuestion?.essayRuleTree ?? null;

  return {
    ...extractedQuestion,
    id: existingQuestion?.id || extractedQuestion?.id,
    questionNo: getQuestionNoKey(extractedQuestion) || getQuestionNoKey(existingQuestion),
    type: keepManualValues && existingQuestion?.type ? existingQuestion.type : extractedQuestion?.type || existingQuestion?.type,
    score: keepManualValues && existingScore > 0 ? existingScore : extractedScore || existingScore,
    content: keepManualValues && existingContent ? existingContent : String(extractedQuestion?.content || existingQuestion?.content || '').trim(),
    standardAnswer:
      keepManualValues && existingStandardAnswer
        ? existingStandardAnswer
        : String(extractedQuestion?.standardAnswer || existingQuestion?.standardAnswer || '').trim(),
    analysis: keepManualValues && existingAnalysis ? existingAnalysis : String(extractedQuestion?.analysis || existingQuestion?.analysis || '').trim(),
    gradingRule: existingGradingRule || String(extractedQuestion?.gradingRule || '').trim(),
    gradingRuleTree:
      keepManualValues && existingGradingRuleTree
        ? existingGradingRuleTree
        : (extractedQuestion?.gradingRuleTree ?? existingGradingRuleTree ?? null),
    essayRuleTree:
      keepManualValues && existingEssayRuleTree
        ? existingEssayRuleTree
        : (extractedQuestion?.essayRuleTree ?? existingEssayRuleTree ?? null),
    tags: Array.from(new Set([...(existingQuestion?.tags || []), ...(extractedQuestion?.tags || [])])),
    enabled: existingQuestion?.enabled !== false && extractedQuestion?.enabled !== false,
    source: keepManualValues ? 'manual' : extractedQuestion?.source || existingQuestion?.source || 'ai',
  };
}

function mergeExtractedQuestions(existingQuestions = [], extractedQuestions = []) {
  const existingMap = new Map(
    existingQuestions
      .map((question) => [getQuestionNoKey(question), question])
      .filter(([questionNo]) => questionNo),
  );
  const merged = [];
  const seenQuestionNos = new Set();

  existingQuestions.forEach((question) => {
    const questionNo = getQuestionNoKey(question);
    if (!questionNo) return;

    const extractedQuestion = extractedQuestions.find((item) => getQuestionNoKey(item) === questionNo);
    merged.push(extractedQuestion ? mergeExtractedQuestionWithExisting(question, extractedQuestion) : question);
    seenQuestionNos.add(questionNo);
  });

  extractedQuestions.forEach((question) => {
    const questionNo = getQuestionNoKey(question);
    if (!questionNo || seenQuestionNos.has(questionNo) || existingMap.has(questionNo)) {
      return;
    }

    merged.push(question);
    seenQuestionNos.add(questionNo);
  });

  return merged.sort((left, right) => compareQuestionNo(left.questionNo, right.questionNo));
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
      .split(/[，。；]/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 4),
  );
  return Array.from(new Set([...fragments, ...normalized]));
}

function splitLegacySubReviewForPointMode(item, index, questionType) {
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

function toRawPointReviews(modelGrade, questionType) {
  if (Array.isArray(modelGrade?.pointReviews) && modelGrade.pointReviews.length) {
    return modelGrade.pointReviews;
  }
  if (!Array.isArray(modelGrade?.subReviews) || !modelGrade.subReviews.length) {
    return [];
  }
  const coarseReviews = Array.isArray(modelGrade?.pointReviews) && modelGrade.pointReviews.length
    ? modelGrade.pointReviews
    : modelGrade.subReviews;
  return coarseReviews.flatMap((item, index) => splitLegacySubReviewForPointMode(item, index, questionType));
}

function buildSubjectiveSignature(question, answerRecord, settings) {
  return JSON.stringify({
    type: question.type,
    questionNo: String(question.questionNo || '').trim(),
    score: Number(question.score || 0),
    content: String(question.content || '').trim(),
    standardAnswer: String(question.standardAnswer || '').trim(),
    gradingRule: String(question.gradingRule || '').trim(),
    gradingRuleTree: question.gradingRuleTree || null,
    essayRuleTree: question.essayRuleTree || null,
    studentAnswer: String(answerRecord?.content || '').trim(),
    answerState: String(answerRecord?.state || 'missing'),
    ordinaryRule: String(settings?.subjectiveOrdinaryRulePrompt || '').trim(),
    essayRule: String(settings?.subjectiveEssayRulePrompt || '').trim(),
    rolePreset: String(settings?.rolePreset || '').trim(),
    customRolePrompt: String(settings?.customRolePrompt || '').trim(),
  });
}

function buildPreviousSubjectiveMap(snapshot) {
  const studentMap = new Map();
  (snapshot?.studentSummaries || []).forEach((student) => {
    studentMap.set(student.studentId, {
      student,
      questionMap: new Map((student.questionGrades || []).map((grade) => [grade.questionNo, grade])),
    });
  });
  return studentMap;
}

function buildSubjectiveQuestionGrade({
  settings,
  question,
  answerRecord,
  modelGrade,
  previousGrade,
  signature,
  now,
  fallbackComment,
  forceReview = false,
}) {
  const studentAnswer = String(answerRecord?.content || '').trim();
  const questionType = question.type === 'essay' ? 'essay' : 'subjective';
  const questionScore = Number(question.score || 0);
  const sectionContext = questionType === 'essay' ? null : buildOrdinarySectionContext({ question, answer: studentAnswer });
  const rawPointReviews = toRawPointReviews(modelGrade, questionType);
  const normalizedPointReviews = normalizePointReviews({
    questionType,
    question,
    answer: studentAnswer,
    sectionContext,
    pointReviews: rawPointReviews.map((item, index) => ({
      subquestionIndex: Number(item?.subquestionIndex ?? 0),
      sectionLabel: String(item?.sectionLabel || '').trim(),
      pointLabel: String(item?.pointLabel || `瑕佺偣${index + 1}`).trim(),
      score: Number(item?.score ?? 0),
      fullScore: Number(item?.fullScore ?? 0),
      comment: String(item?.comment || '').trim(),
      matchedExcerpts: (Array.isArray(item?.matchedExcerpts) ? item.matchedExcerpts : [])
        .map((excerpt) => normalizeStudentExcerpt(excerpt, studentAnswer))
        .filter(Boolean),
    })),
  });
  const sectionComments = (Array.isArray(modelGrade?.sectionComments) ? modelGrade.sectionComments : [])
    .map((item) => ({
      subquestionIndex: Number(item?.subquestionIndex ?? 0),
      sectionLabel: String(item?.sectionLabel || '').trim(),
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
      essayReview: modelGrade?.essayReview,
      pointReviews: normalizedPointReviews,
      sectionReviews: baseSectionReviews,
    })
    : null;
  const pointReviews = essayArtifacts?.pointReviews || normalizedPointReviews;
  const sectionReviews = essayArtifacts?.sectionReviews || baseSectionReviews;
  const essayReview = essayArtifacts?.essayReview || null;
  const annotationMatches = [
    ...pointReviews.flatMap((item) => item.matchedExcerpts || []),
    ...(Array.isArray(modelGrade?.annotations?.matches) ? modelGrade.annotations.matches : [])
      .map((excerpt) => normalizeStudentExcerpt(excerpt, studentAnswer))
      .filter(Boolean),
  ];
  const annotationErrors = (Array.isArray(modelGrade?.annotations?.errors) ? modelGrade.annotations.errors : [])
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
  const earnedScoreRaw = Number(modelGrade?.earnedScore ?? 0);
  const pointScoreSum = pointReviews.reduce((sum, item) => sum + Number(item.score || 0), 0);
  const hasPointReviews = pointReviews.length > 0;
  const earnedScoreBase = hasPointReviews ? pointScoreSum : earnedScoreRaw;
  const earnedScore = Math.max(0, Math.min(questionScore, Number.isFinite(earnedScoreBase) ? earnedScoreBase : 0));
  const consistencyWarnings = buildSubjectiveConsistencyWarnings({
    questionType,
    pointReviews,
    sectionReviews,
    annotationRanges,
    earnedScoreRaw,
    sectionContext,
    essayReview,
  });
  const generatedQuestionComment =
    questionType === 'essay'
      ? (
        String(modelGrade?.questionComment || '').trim()
        || buildQuestionComment({
          questionScore,
          earnedScore,
          questionType,
          pointReviews,
          sectionReviews,
          rolePreset: settings?.rolePreset,
          customRolePrompt: settings?.customRolePrompt,
        })
      )
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
        : '');
  const questionCommentBase =
    generatedQuestionComment ||
    String(modelGrade?.questionComment || fallbackComment || '').trim() ||
    '本题已完成评分。';
  const questionComment = consistencyWarnings.length
    ? `${questionCommentBase}\n系统提示：${consistencyWarnings.join('；')}。`
    : questionCommentBase;
  const requiresReview =
    forceReview
    || Boolean(modelGrade?.requiresReview)
    || Boolean(essayArtifacts?.requiresReview)
    || consistencyWarnings.length > 0;

  return {
    questionNo: String(question.questionNo || '').trim(),
    questionType,
    questionScore,
    earnedScore,
    originalEarnedScore: Number(previousGrade?.originalEarnedScore ?? earnedScore),
    answerState: String(answerRecord?.state || 'missing'),
    sourceLabels: Array.isArray(answerRecord?.sourceLabels) ? answerRecord.sourceLabels : [],
    studentAnswer,
    questionContent: String(question.content || '').trim(),
    standardAnswer: String(question.standardAnswer || '').trim(),
    gradingRule: String(question.gradingRule || '').trim(),
    questionComment,
    essayReview,
    pointReviews,
    sectionReviews,
    annotationRanges,
    subReviews: pointReviews.map((item) => toLegacySubReview(item)),
    displaySubReviews: sectionReviews.map((item) => toLegacySubReview(item)),
    annotations: {
      matches: Array.from(new Set(annotationMatches)),
      errors: annotationErrors,
    },
    requiresReview,
    reviewState: requiresReview ? 'pending' : (previousGrade?.reviewState || 'pending'),
    reviewNote: String(previousGrade?.reviewNote || '').trim(),
    reviewedAt: String(previousGrade?.reviewedAt || '').trim(),
    reviewer: String(previousGrade?.reviewer || '').trim(),
    signature,
    gradedAt: signature === previousGrade?.signature ? previousGrade.gradedAt || now : now,
  };
}

function buildFallbackSubjectiveGrade({ settings, question, answerRecord, previousGrade, signature, now, comment, requiresReview = false }) {
  return buildSubjectiveQuestionGrade({
    settings,
    question,
    answerRecord,
    previousGrade,
    signature,
    now,
    forceReview: requiresReview,
    fallbackComment: comment,
      modelGrade: {
        earnedScore: 0,
        questionComment: comment,
        requiresReview,
        pointReviews: [],
        annotations: {
          errors: [],
        },
      },
  });
}

function rebuildSubjectiveStudentSummary(student, allQuestions, questionGrades, overallComment, settings) {
  const questionMap = new Map(questionGrades.map((grade) => [grade.questionNo, grade]));
  const orderedQuestionGrades = allQuestions.map((question) => questionMap.get(question.questionNo)).filter(Boolean);
  const totalScore = allQuestions.reduce((sum, question) => sum + Number(question.score || 0), 0);
  const earnedScore = orderedQuestionGrades.reduce((sum, grade) => sum + Number(grade.earnedScore || 0), 0);
  const nextOverallComment = orderedQuestionGrades.length
    ? buildOverallComment({
        totalScore,
        earnedScore,
        questionGrades: orderedQuestionGrades,
        rolePreset: settings?.rolePreset,
        customRolePrompt: settings?.customRolePrompt,
      })
    : String(overallComment || '').trim();

  return {
    studentId: student.id,
    studentName: student.studentName,
    isExtra: Boolean(student.isExtra),
    totalScore,
    earnedScore,
    gradedQuestionCount: orderedQuestionGrades.length,
    pendingQuestionCount: Math.max(0, allQuestions.length - orderedQuestionGrades.length),
    reviewQuestionCount: orderedQuestionGrades.filter((grade) => grade.requiresReview).length,
    overallComment: nextOverallComment,
    questionGrades: orderedQuestionGrades,
    updatedAt: student.updatedAt,
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.get('/api/settings', (_req, res) => {
  res.json(getSettings());
});

app.put('/api/settings', (req, res) => {
  const savedSettings = saveSettings(req.body);
  clearModelResolutionCache();
  clearAnswerSheetRecognitionCache();
  res.json(savedSettings);
});

app.post('/api/settings/test-connection', async (req, res) => {
  try {
    const target = req.body?.target || req.body?.profile || 'general';
    res.json(await testConnection(getSettings(), target));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.post('/api/settings/maintenance', (req, res) => {
  try {
    const scope = String(req.body?.scope || '').trim();
    if (scope === 'cache') {
      const cacheResult = clearAppCacheStorage();
      const modelCacheCleared = clearModelResolutionCache();
      const answerSheetCacheCleared = clearAnswerSheetRecognitionCache();
      res.json({
        ok: true,
        scope: 'cache',
        message: '缓存已清理完成。',
        details: {
          ...cacheResult,
          modelCacheCleared,
          answerSheetCacheCleared,
        },
      });
      return;
    }

    if (scope === 'data') {
      const dataResult = clearAppDataStorage({ keepSettings: true });
      const modelCacheCleared = clearModelResolutionCache();
      const answerSheetCacheCleared = clearAnswerSheetRecognitionCache();
      res.json({
        ok: true,
        scope: 'data',
        message: '数据已清空，已保留后台设置。',
        details: {
          ...dataResult,
          modelCacheCleared,
          answerSheetCacheCleared,
        },
      });
      return;
    }

    res.status(400).json({ message: '维护类型不正确，仅支持 cache 或 data。' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.get('/api/tasks', (_req, res) => {
  res.json(listTasks());
});

app.post('/api/tasks', (req, res) => {
  res.json(createTask(req.body.mode || 'choice'));
});

app.get('/api/tasks/:taskId', (req, res) => {
  const task = getTaskDetail(req.params.taskId);
  if (!task) {
    res.status(404).json({ message: '任务不存在。' });
    return;
  }

  res.json(task);
});

app.delete('/api/tasks/:taskId', (req, res) => {
  try {
    deleteTask(req.params.taskId);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.put('/api/tasks/:taskId/basic', (req, res) => {
  try {
    res.json(updateTaskBasic(req.params.taskId, req.body));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.put('/api/tasks/:taskId/questions', (req, res) => {
  try {
    const detail = replaceTaskQuestions(req.params.taskId, req.body.questions || []);
    res.json({ ok: true, questions: detail.questions });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.post('/api/grading-rule/alias-suggestions', async (req, res) => {
  try {
    const result = await generatePointAliasSuggestions({
      settings: getSettings(),
      questionNo: req.body?.questionNo,
      questionContent: req.body?.questionContent,
      standardAnswer: req.body?.standardAnswer,
      sectionLabel: req.body?.sectionLabel,
      subquestionLabel: req.body?.subquestionLabel,
      pointLabel: req.body?.pointLabel,
      existingAliases: req.body?.existingAliases,
      notes: req.body?.notes,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.post('/api/grading-rule/essay-thesis-suggestions', async (req, res) => {
  try {
    const result = await generateEssayThesisSuggestions({
      settings: getSettings(),
      questionNo: req.body?.questionNo,
      questionContent: req.body?.questionContent,
      standardAnswer: req.body?.standardAnswer,
      existingTemplates: req.body?.existingTemplates,
      existingKeywordGroups: req.body?.existingKeywordGroups,
      notes: req.body?.notes,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.post('/api/tasks/:taskId/uploads', upload.array('files', 20), (req, res) => {
  try {
    const kind = String(req.query.kind || '');
    if (!['question', 'answer'].includes(kind)) {
      res.status(400).json({ message: '上传类型不正确。' });
      return;
    }

    addUploads(req.params.taskId, kind, req.files || []);
    const detail = getTaskDetail(req.params.taskId);
    res.json({ uploads: detail?.uploads ?? [] });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.delete('/api/tasks/:taskId/uploads/:uploadId', (req, res) => {
  try {
    deleteUpload(req.params.taskId, req.params.uploadId);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.post('/api/tasks/:taskId/answer-sheets/uploads', upload.array('files', 20), async (req, res) => {
  try {
    const task = getTaskDetail(req.params.taskId);
    if (!task) {
      /*
      res.status(404).json({ message: '任务不存在。' });
      */
      res.status(404).json({ message: 'Task not found.' });
      return;
    }

    const pages = await splitUploadedAnswerSheets(req.params.taskId, req.files || []);
    addAnswerSheets(req.params.taskId, pages);
    const detail = getTaskDetail(req.params.taskId);
    res.json({ answerSheets: detail?.answerSheets ?? [] });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.post('/api/tasks/:taskId/answer-sheets/:sheetId/recognize', async (req, res) => {
  const taskId = req.params.taskId;
  const sheetId = req.params.sheetId;

  try {
    const task = getTaskDetail(taskId);
    if (!task) {
      res.status(404).json({ message: '任务不存在。' });
      return;
    }

    const sheet = getAnswerSheetRecord(taskId, sheetId);
    if (!sheet) {
      res.status(404).json({ message: '答题卡记录不存在。' });
      return;
    }

    const settings = getSettings();
    const classroomStudents = getTaskClassroomStudents(settings, task);
    const engine = 'doubao';
    const profile = normalizeAnswerSheetProfile(req.body.profile);
    const retainQuestionNos = normalizeRequestedQuestionNos(req.body?.retainQuestionNos);
    const displayName = sheet.displayName || sheet.sourceOriginalName || sheetId;
    const startedAt = Date.now();

    console.log(`[answer-sheet] start task=${taskId} sheet=${sheetId} profile=${profile} displayName=${displayName}`);

    updateAnswerSheet(taskId, sheetId, {
      status: 'processing',
      engine,
      profile,
      errorMessage: '',
      warnings: [],
    });

    try {
      const recognized = await recognizeAnswerSheet({
        settings,
        profile,
        engine,
        task,
        sheet,
        classroomStudents,
      });
      const result = filterRecognizedAnswersByQuestionNos(recognized, retainQuestionNos);

      const updated = updateAnswerSheet(taskId, sheetId, {
        status: 'done',
        engine: result.engine || engine,
        profile,
        provider: result.provider,
        selectedModel: result.selectedModel,
        studentName: result.studentName,
        observedNames: result.observedNames,
        suggestedStudentName: result.suggestedStudentName,
        suggestedStudentConfidence: result.suggestedStudentConfidence,
        choiceAnswers: result.choiceAnswers,
        subjectiveAnswers: result.subjectiveAnswers,
        warnings: result.warnings,
        errorMessage: '',
        recognizedAt: new Date().toISOString(),
      });

      console.log(
        `[answer-sheet] done task=${taskId} sheet=${sheetId} profile=${profile} model=${result.selectedModel || 'unknown'} student=${result.studentName || ''} elapsedMs=${Date.now() - startedAt} warnings=${result.warnings.length}`,
      );

      res.json({ answerSheet: updated });
    } catch (error) {
      console.error(
        `[answer-sheet] failed task=${taskId} sheet=${sheetId} profile=${profile} displayName=${displayName} elapsedMs=${Date.now() - startedAt}:`,
        error,
      );
      const updated = updateAnswerSheet(taskId, sheetId, {
        status: 'error',
        engine,
        profile,
        errorMessage: error.message,
      });

      res.status(400).json({ message: error.message, answerSheet: updated });
    }
  } catch (error) {
    console.error(`[answer-sheet] request failed task=${taskId} sheet=${sheetId}:`, error);
    res.status(400).json({ message: error.message });
  }
});

app.get('/api/tasks/:taskId/answer-sheets/:sheetId/preview', (req, res) => {
  try {
    const sheet = getAnswerSheetRecord(req.params.taskId, req.params.sheetId);
    if (!sheet) {
      res.status(404).json({ message: 'Task not found.' });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.type(sheet.mimeType || 'image/jpeg');
    res.sendFile(path.resolve(sheet.storedPath));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

async function runAnswerSheetBatchJob(job) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();

  try {
    const task = getTaskDetail(job.taskId);
    if (!task) {
      throw new Error('Task not found.');
    }

    const requestedSheetIdSet = new Set(job.requestedSheetIds);
    const queue = task.answerSheets
      .filter((sheet) => requestedSheetIdSet.has(sheet.id))
      .map((sheet) => ({
        id: sheet.id,
        displayName: sheet.displayName || sheet.sourceOriginalName || sheet.id,
      }));

    job.requestedCount = queue.length;
    if (!queue.length) {
      job.status = 'completed';
      job.message = 'No answer sheets to recognize.';
      job.finishedAt = new Date().toISOString();
      return;
    }

    const settings = getSettings();
    job.workerCount = Math.min(getConfiguredAnswerSheetBatchConcurrency(settings), queue.length);

    console.log(`[answer-sheet-batch] start task=${job.taskId} profile=${job.profile} count=${queue.length}`);

    let stateWriteQueue = Promise.resolve();

    function enqueueStateWrite(action) {
      const scheduled = stateWriteQueue.then(() => action());
      stateWriteQueue = scheduled.catch((error) => {
        console.error(`[answer-sheet-batch] state-write failed task=${job.taskId}:`, error);
      });
      return scheduled;
    }

    async function runRecognitionWorker(workerNo) {
      while (queue.length) {
        const current = queue.shift();
        if (!current) {
          return;
        }

        const startedAt = Date.now();

        try {
          await enqueueStateWrite(() =>
            updateAnswerSheet(job.taskId, current.id, {
              status: 'processing',
              engine: job.engine,
              profile: job.profile,
              errorMessage: '',
              warnings: [],
            }),
          );

          const latestTask = getTaskDetail(job.taskId);
          if (!latestTask) {
            throw new Error('Task not found.');
          }

          const latestSheet = getAnswerSheetRecord(job.taskId, current.id);
          if (!latestSheet) {
            throw new Error('Answer sheet record not found.');
          }

          const latestSettings = getSettings();
          const classroomStudents = getTaskClassroomStudents(latestSettings, latestTask);

          console.log(
            `[answer-sheet-batch] worker=${workerNo} start task=${job.taskId} sheet=${current.id} profile=${job.profile} displayName=${current.displayName}`,
          );

          const recognized = await recognizeAnswerSheet({
            settings: latestSettings,
            profile: job.profile,
            engine: job.engine,
            task: latestTask,
            sheet: latestSheet,
            classroomStudents,
          });
          const result = filterRecognizedAnswersByQuestionNos(recognized, job.retainQuestionNos);

          const recognizedAt = new Date().toISOString();
          const elapsedMs = Date.now() - startedAt;

          await enqueueStateWrite(() =>
            updateAnswerSheet(job.taskId, current.id, {
              status: 'done',
              engine: result.engine || job.engine,
              profile: job.profile,
              provider: result.provider,
              selectedModel: result.selectedModel,
              studentName: result.studentName,
              observedNames: result.observedNames,
              suggestedStudentName: result.suggestedStudentName,
              suggestedStudentConfidence: result.suggestedStudentConfidence,
              choiceAnswers: result.choiceAnswers,
              subjectiveAnswers: result.subjectiveAnswers,
              warnings: result.warnings,
              errorMessage: '',
              recognizedAt,
            }),
          );

          job.processedCount += 1;
          job.successCount += 1;
          job.message = `Processed ${job.processedCount}/${job.requestedCount}`;

          console.log(
            `[answer-sheet-batch] worker=${workerNo} done task=${job.taskId} sheet=${current.id} elapsedMs=${elapsedMs} model=${result.selectedModel || 'unknown'} student=${result.studentName || '-'} warnings=${Array.isArray(result.warnings) ? result.warnings.length : 0}`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Recognition failed';
          const elapsedMs = Date.now() - startedAt;

          try {
            if (getAnswerSheetRecord(job.taskId, current.id)) {
              await enqueueStateWrite(() =>
                updateAnswerSheet(job.taskId, current.id, {
                  status: 'error',
                  engine: job.engine,
                  profile: job.profile,
                  errorMessage: message,
                }),
              );
            }
          } catch (updateError) {
            console.error(`[answer-sheet-batch] failed to mark ${current.id} as error:`, updateError);
          }

          job.processedCount += 1;
          job.errorCount += 1;
          job.failedSheets.push({
            sheetId: current.id,
            displayName: current.displayName,
            message,
          });
          job.message = `Processed ${job.processedCount}/${job.requestedCount}`;

          console.error(
            `[answer-sheet-batch] worker=${workerNo} failed task=${job.taskId} sheet=${current.id} elapsedMs=${elapsedMs} displayName=${current.displayName}:`,
            error,
          );
        }
      }
    }

    await Promise.all(Array.from({ length: job.workerCount }, (_, index) => runRecognitionWorker(index + 1)));
    await stateWriteQueue;

    job.status = 'completed';
    job.message = job.errorCount
      ? `Completed with ${job.successCount} success and ${job.errorCount} failure(s).`
      : `Completed ${job.successCount} answer sheet(s).`;
    console.log(
      `[answer-sheet-batch] done task=${job.taskId} profile=${job.profile} processed=${job.processedCount} success=${job.successCount} failed=${job.errorCount}`,
    );
  } catch (error) {
    job.status = 'failed';
    job.message = error instanceof Error ? error.message : 'Batch recognition failed.';
    console.error(`[answer-sheet-batch] job failed task=${job.taskId}:`, error);
  } finally {
    job.finishedAt = new Date().toISOString();
    activeAnswerSheetBatchJobs.delete(job.taskId);
    pruneStoredAnswerSheetBatchJobs();
  }
}

app.post('/api/tasks/:taskId/answer-sheets/recognize-batch', async (req, res) => {
  const taskId = req.params.taskId;

  try {
    const task = getTaskDetail(taskId);
    if (!task) {
      res.status(404).json({ message: 'Task not found.' });
      return;
    }

    const engine = 'doubao';
    const profile = normalizeAnswerSheetProfile(req.body.profile);
    const retainQuestionNos = normalizeRequestedQuestionNos(req.body?.retainQuestionNos);
    const requestedSheetIds =
      Array.isArray(req.body.sheetIds) && req.body.sheetIds.length
        ? req.body.sheetIds.map((item) => String(item || '').trim()).filter(Boolean)
        : task.answerSheets.filter((sheet) => sheet.status !== 'done').map((sheet) => sheet.id);
    const requestedSheetIdSet = new Set(requestedSheetIds);
    const selectedSheets = task.answerSheets.filter((sheet) => requestedSheetIdSet.has(sheet.id));

    if (!selectedSheets.length) {
      res.status(400).json({ message: 'No answer sheets to recognize.' });
      return;
    }

    const activeJobId = activeAnswerSheetBatchJobs.get(taskId);
    if (activeJobId) {
      const activeJob = answerSheetBatchJobs.get(activeJobId);
      if (activeJob && ['queued', 'running'].includes(activeJob.status)) {
        res.status(409).json({
          message: '当前已有答题卡批量识别任务在后台运行，请等待完成后再试。',
          job: createAnswerSheetBatchJobSnapshot(activeJob),
        });
        return;
      }
      activeAnswerSheetBatchJobs.delete(taskId);
    }

    const job = {
      id: crypto.randomUUID(),
      taskId,
      requestedSheetIds: selectedSheets.map((sheet) => sheet.id),
      retainQuestionNos,
      profile,
      engine,
      status: 'queued',
      requestedCount: selectedSheets.length,
      processedCount: 0,
      successCount: 0,
      errorCount: 0,
      workerCount: 0,
      failedSheets: [],
      message: `Queued ${selectedSheets.length} answer sheet(s).`,
      createdAt: new Date().toISOString(),
      startedAt: '',
      finishedAt: '',
    };

    answerSheetBatchJobs.set(job.id, job);
    activeAnswerSheetBatchJobs.set(taskId, job.id);
    pruneStoredAnswerSheetBatchJobs();

    Promise.resolve()
      .then(() => runAnswerSheetBatchJob(job))
      .catch((error) => {
        console.error(`[answer-sheet-batch] failed to start job task=${taskId} job=${job.id}:`, error);
      });

    res.json({
      ok: true,
      pollIntervalMs: ANSWER_SHEET_BATCH_POLL_INTERVAL_MS,
      job: createAnswerSheetBatchJobSnapshot(job),
    });
  } catch (error) {
    console.error(`[answer-sheet-batch] request failed task=${taskId}:`, error);
    res.status(400).json({ message: error.message });
  }
});

app.get('/api/tasks/:taskId/answer-sheets/recognize-batch/:jobId', (req, res) => {
  const job = answerSheetBatchJobs.get(req.params.jobId);
  if (!job || job.taskId !== req.params.taskId) {
    res.status(404).json({ message: 'Task not found.' });
    return;
  }

  res.json({
    ok: true,
    pollIntervalMs: ANSWER_SHEET_BATCH_POLL_INTERVAL_MS,
    job: createAnswerSheetBatchJobSnapshot(job),
  });
});

// Legacy batch route kept on a disabled path to avoid shadowing the active implementation.
app.post('/api/_disabled/tasks/:taskId/answer-sheets/recognize-batch-legacy', async (req, res) => {
  const taskId = req.params.taskId;

  try {
    const task = getTaskDetail(taskId);
    if (!task) {
      res.status(404).json({ message: '任务不存在。' });
      return;
    }

    const settings = getSettings();
    const engine = 'doubao';
    const profile = normalizeAnswerSheetProfile(req.body.profile);
    const requestedSheetIds =
      Array.isArray(req.body.sheetIds) && req.body.sheetIds.length
        ? req.body.sheetIds.map((item) => String(item || '').trim()).filter(Boolean)
        : task.answerSheets.filter((sheet) => sheet.status !== 'done').map((sheet) => sheet.id);
    const requestedSheetIdSet = new Set(requestedSheetIds);
    const selectedSheets = task.answerSheets.filter((sheet) => requestedSheetIdSet.has(sheet.id));

    if (!selectedSheets.length) {
      res.status(400).json({ message: '当前没有可识别的答题卡。' });
      return;
    }

    const results = [];
    for (const selectedSheet of selectedSheets) {
      try {
        updateAnswerSheet(taskId, selectedSheet.id, {
          status: 'processing',
          engine,
          profile,
          errorMessage: '',
          warnings: [],
        });

        const latestTask = getTaskDetail(taskId);
        if (!latestTask) {
          throw new Error('任务不存在。');
        }

        const latestSheet = getAnswerSheetRecord(taskId, selectedSheet.id);
        if (!latestSheet) {
          throw new Error('答题卡记录不存在。');
        }

        const latestSettings = getSettings();
        const classroomStudents = getTaskClassroomStudents(latestSettings, latestTask);
        const result = await recognizeAnswerSheet({
          settings: latestSettings,
          profile,
          engine,
          task: latestTask,
          sheet: latestSheet,
          classroomStudents,
        });

        updateAnswerSheet(taskId, selectedSheet.id, {
          status: 'done',
          engine: result.engine || engine,
          profile,
          provider: result.provider,
          selectedModel: result.selectedModel,
          studentName: result.studentName,
          observedNames: result.observedNames,
          suggestedStudentName: result.suggestedStudentName,
          suggestedStudentConfidence: result.suggestedStudentConfidence,
          choiceAnswers: result.choiceAnswers,
          subjectiveAnswers: result.subjectiveAnswers,
          warnings: result.warnings,
          errorMessage: '',
          recognizedAt: new Date().toISOString(),
        });

        results.push({
          sheetId: selectedSheet.id,
          displayName: latestSheet.displayName || selectedSheet.displayName,
          ok: true,
          message: '',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '识别失败';

        try {
          if (getAnswerSheetRecord(taskId, selectedSheet.id)) {
            updateAnswerSheet(taskId, selectedSheet.id, {
              status: 'error',
              engine,
              profile,
              errorMessage: message,
            });
          }
        } catch (updateError) {
          console.error(`[answer-sheet-batch] failed to mark ${selectedSheet.id} as error:`, updateError);
        }

        console.error(`[answer-sheet-batch] ${selectedSheet.displayName || selectedSheet.id} failed:`, error);
        results.push({
          sheetId: selectedSheet.id,
          displayName: selectedSheet.displayName,
          ok: false,
          message,
        });
      }
    }

    const failedSheets = results
      .filter((item) => !item.ok)
      .map((item) => ({
        sheetId: item.sheetId,
        displayName: item.displayName,
        message: item.message,
      }));

    res.json({
      ok: true,
      processedCount: results.length,
      successCount: results.length - failedSheets.length,
      errorCount: failedSheets.length,
      failedSheets,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.delete('/api/tasks/:taskId/answer-sheets/:sheetId', (req, res) => {
  try {
    deleteAnswerSheet(req.params.taskId, req.params.sheetId);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.put('/api/tasks/:taskId/answer-sheets/:sheetId', (req, res) => {
  try {
    const updated = updateAnswerSheet(req.params.taskId, req.params.sheetId, {
      manualStudentName: req.body.manualStudentName ?? '',
      choiceAnswers: req.body.choiceAnswers,
      subjectiveAnswers: req.body.subjectiveAnswers,
    });
    res.json({ answerSheet: updated });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.put('/api/tasks/:taskId/student-records', (req, res) => {
  try {
    const detail = upsertStudentSummary(req.params.taskId, {
      studentName: req.body.studentName,
      choiceOverrides: req.body.choiceOverrides,
      subjectiveOverrides: req.body.subjectiveOverrides,
    });
    res.json({ studentRecords: detail?.studentRecords ?? [] });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.post('/api/tasks/:taskId/choice-grading', (req, res) => {
  try {
    const detail = runChoiceGrading(req.params.taskId);
    res.json({
      task: detail,
      choiceGrading: detail?.choiceGrading ?? null,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.post('/api/tasks/:taskId/choice-explanations', async (req, res) => {
  try {
    const task = getTaskDetail(req.params.taskId);
    if (!task) {
      res.status(404).json({ message: '任务不存在。' });
      return;
    }
    if (task.mode === 'subjective') {
      res.status(400).json({ message: '当前任务不包含选择题，无法生成详细解析。' });
      return;
    }

    const threshold = Number.isFinite(Number(req.body?.threshold)) ? Math.max(0, Math.min(100, Number(req.body.threshold))) : 80;
    const selectedQuestionNos = normalizeRequestedQuestionNos(req.body?.selectedQuestionNos);
    if (!selectedQuestionNos.length) {
      res.status(400).json({ message: '请先选择需要解析的题号。' });
      return;
    }

    const questionUploads = listUploadsByKind(req.params.taskId, 'question');
    if (!questionUploads.length) {
      res.status(400).json({ message: '步骤二未找到题目 PDF，请先上传题目文件。' });
      return;
    }

    const questionSummaries = getChoiceQuestionSummaries(task);
    if (!questionSummaries.length) {
      res.status(400).json({ message: '请先完成步骤四选择题批阅，再生成详细解析。' });
      return;
    }

    const explanationProfile = req.body?.profile || 'general';

    const generation = await generateChoiceQuestionExplanations({
      settings: getSettings(),
      profile: explanationProfile,
      task,
      questionUploadRecords: questionUploads,
      selectedQuestionNos,
      questionSummaries,
    });
    const questionsWithStats = mergeChoiceExplanationQuestionsWithStats(
      generation.questions,
      questionSummaries,
      selectedQuestionNos,
    );

    const detail = saveTaskChoiceExplanation(req.params.taskId, {
      threshold,
      selectedQuestionNos,
      generatedAt: new Date().toISOString(),
      sourceUploadIds: questionUploads.map((item) => item.id),
      modelProfile: explanationProfile,
      questions: questionsWithStats,
      warnings: generation.warnings,
    });

    res.json({
      task: detail,
      choiceExplanation: detail?.choiceExplanation ?? null,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.delete('/api/tasks/:taskId/choice-explanations', (req, res) => {
  try {
    const detail = clearTaskChoiceExplanation(req.params.taskId);
    res.json({
      task: detail,
      choiceExplanation: detail?.choiceExplanation ?? null,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.get('/api/tasks/:taskId/choice-explanations/export.docx', async (req, res) => {
  try {
    const task = getTaskDetail(req.params.taskId);
    if (!task) {
      res.status(404).json({ message: 'Task not found.' });
      return;
    }

    const result = await buildChoiceExplanationDocx(task);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="choice-explanation-export.docx"; filename*=UTF-8''${encodeDownloadFileName(result.fileName)}`,
    );
    res.setHeader('Content-Length', Buffer.byteLength(result.buffer));
    res.setHeader('X-Exported-Question-Count', String(result.exportedQuestionCount));
    res.end(result.buffer);
  } catch (error) {
    console.error('[choice-explanation-export] request failed:', error);
    res.status(400).json({ message: error.message });
  }
});

app.post('/api/tasks/:taskId/subjective-grading', async (req, res) => {
  try {
    const task = getTaskDetail(req.params.taskId);
    if (!task) {
      res.status(404).json({ message: '任务不存在。' });
      return;
    }

    const settings = getSettings();
    const profile = normalizeSubjectiveGradingProfile(req.body.profile);
    const force = Boolean(req.body.force);
    const requestedConcurrency = Number(req.body.studentConcurrency ?? 2);
    const studentConcurrency = Number.isFinite(requestedConcurrency)
      ? Math.max(1, Math.min(4, Math.floor(requestedConcurrency)))
      : 2;

    const allSubjectiveQuestions = getEnabledSubjectiveQuestions(task);
    if (!allSubjectiveQuestions.length) {
      res.status(400).json({ message: '当前任务还没有可批改的主观题。' });
      return;
    }

    const selectedQuestionNos = uniqueQuestionNos(
      Array.isArray(req.body.questionNos) && req.body.questionNos.length
        ? req.body.questionNos
        : allSubjectiveQuestions.map((question) => question.questionNo),
    );
    const selectedQuestions = allSubjectiveQuestions.filter((question) => selectedQuestionNos.includes(question.questionNo));
    if (!selectedQuestions.length) {
      res.status(400).json({ message: '请先选择要批改的主观题。' });
      return;
    }

    const requestedStudentIds =
      Array.isArray(req.body.studentIds) && req.body.studentIds.length
        ? req.body.studentIds.map((item) => String(item || '').trim()).filter(Boolean)
        : task.studentRecords.map((student) => student.id);
    const requestedStudentSet = new Set(requestedStudentIds);
    const selectedStudents = task.studentRecords.filter((student) => requestedStudentSet.has(student.id));
    if (!selectedStudents.length) {
      res.status(400).json({ message: '未找到需要批改的学生。' });
      return;
    }

    const previousStudentMap = buildPreviousSubjectiveMap(task.subjectiveGrading || null);
    const now = new Date().toISOString();

    async function gradeSingleStudent(student) {
      const previousState = previousStudentMap.get(student.id) || null;
      const previousQuestionMap = previousState?.questionMap || new Map();
      const answerMap = new Map((student.subjectiveAnswers || []).map((answer) => [answer.questionNo, answer]));
      const localGradeMap = new Map();
      const questionsToModel = [];
      let failureMessage = '';

      for (const question of selectedQuestions) {
        const answerRecord = answerMap.get(question.questionNo) || null;
        const signature = buildSubjectiveSignature(question, answerRecord, settings);
        const previousGrade = previousQuestionMap.get(question.questionNo) || null;
        const answerState = String(answerRecord?.state || 'missing');
        const studentAnswer = String(answerRecord?.content || '').trim();

        if (!force && previousGrade?.signature === signature) {
          localGradeMap.set(question.questionNo, previousGrade);
          continue;
        }

        if (answerState === 'conflict') {
          localGradeMap.set(
            question.questionNo,
            buildFallbackSubjectiveGrade({
              settings,
              question,
              answerRecord,
              previousGrade,
              signature,
              now,
              comment: '该题存在多个版本的作答内容，需先人工复核后再评分。',
              requiresReview: true,
            }),
          );
          continue;
        }

        if (answerState === 'missing') {
          localGradeMap.set(
            question.questionNo,
            buildFallbackSubjectiveGrade({
              settings,
              question,
              answerRecord,
              previousGrade,
              signature,
              now,
              comment: '当前还没有识别到该题作答原文，本题暂记 0 分。',
            }),
          );
          continue;
        }

        if (answerState === 'blank' || !studentAnswer) {
          localGradeMap.set(
            question.questionNo,
            buildFallbackSubjectiveGrade({
              settings,
              question,
              answerRecord,
              previousGrade,
              signature,
              now,
              comment: '学生该题未作答，本题记 0 分。',
            }),
          );
          continue;
        }

        questionsToModel.push({
          ...question,
          studentAnswer,
          answerState,
          sourceLabels: Array.isArray(answerRecord?.sourceLabels) ? answerRecord.sourceLabels : [],
          signature,
          previousGrade,
          answerRecord,
        });
      }

      let overallComment = previousState?.student?.overallComment || '';
      if (questionsToModel.length) {
        try {
          const modelResult = await gradeSubjectiveQuestions({
            settings,
            profile,
            task,
            student,
            questions: questionsToModel,
          });

          if (modelResult?.overallComment) {
            overallComment = modelResult.overallComment;
          }

          const modelGradeMap = new Map(
            (modelResult?.questionGrades || [])
              .map((grade) => [String(grade?.questionNo || '').trim(), grade])
              .filter(([questionNo]) => questionNo),
          );

          questionsToModel.forEach((question) => {
            const modelGrade = modelGradeMap.get(question.questionNo);
            if (!modelGrade) {
              localGradeMap.set(
                question.questionNo,
                buildFallbackSubjectiveGrade({
                  settings,
                  question,
                  answerRecord: question.answerRecord,
                  previousGrade: question.previousGrade,
                  signature: question.signature,
                  now,
                  comment: '模型未返回该题评分，建议人工复核。',
                  requiresReview: true,
                }),
              );
              return;
            }

            localGradeMap.set(
              question.questionNo,
              buildSubjectiveQuestionGrade({
                settings,
                question,
                answerRecord: question.answerRecord,
                modelGrade,
                previousGrade: question.previousGrade,
                signature: question.signature,
                now,
              }),
            );
          });
        } catch (error) {
          failureMessage = error?.message || '模型调用失败';
          console.error(
            `[subjective-grading] ${student.studentName} failed:`,
            error,
            error?.debugArtifactPath ? `(artifact: ${error.debugArtifactPath})` : '',
          );

          questionsToModel.forEach((question) => {
            localGradeMap.set(
              question.questionNo,
              buildFallbackSubjectiveGrade({
                settings,
                question,
                answerRecord: question.answerRecord,
                previousGrade: question.previousGrade,
                signature: question.signature,
                now,
                comment: `模型调用失败：${failureMessage}，建议人工复核。`,
                requiresReview: true,
              }),
            );
          });

          if (!overallComment) {
            overallComment = `本轮批改出现异常：${failureMessage}`;
          }
        }
      }

      const mergedQuestionGrades = [];
      const selectedQuestionSet = new Set(selectedQuestions.map((question) => question.questionNo));
      allSubjectiveQuestions.forEach((question) => {
        if (localGradeMap.has(question.questionNo)) {
          mergedQuestionGrades.push(localGradeMap.get(question.questionNo));
          return;
        }

        const previousGrade = previousQuestionMap.get(question.questionNo);
        if (previousGrade && !selectedQuestionSet.has(question.questionNo)) {
          mergedQuestionGrades.push(previousGrade);
        }
      });

      return {
        studentId: student.id,
        studentName: student.studentName,
        failureMessage,
        summary: rebuildSubjectiveStudentSummary(
          student,
          allSubjectiveQuestions,
          mergedQuestionGrades,
          overallComment || (mergedQuestionGrades.length ? '已保存当前主观题评分结果。' : ''),
          settings,
        ),
      };
    }

    const queue = [...selectedStudents];
    const processedResults = [];
    const workerCount = Math.min(studentConcurrency, queue.length || 1);

    const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length) {
        const student = queue.shift();
        if (!student) return;
        processedResults.push(await gradeSingleStudent(student));
      }
    });

    await Promise.all(workers);

    const updatedStudentSummaries = new Map(processedResults.map((item) => [item.studentId, item.summary]));
    const gradedStudentIds = processedResults.map((item) => item.studentId);
    const failedStudents = processedResults
      .filter((item) => item.failureMessage)
      .map((item) => ({
        studentId: item.studentId,
        studentName: item.studentName,
        message: item.failureMessage,
      }));

    const previousSummaries = task.subjectiveGrading?.studentSummaries || [];
    task.studentRecords.forEach((student) => {
      if (updatedStudentSummaries.has(student.id)) {
        return;
      }

      const previousSummary = previousSummaries.find((item) => item.studentId === student.id);
      if (!previousSummary) {
        return;
      }

      updatedStudentSummaries.set(
        student.id,
        rebuildSubjectiveStudentSummary(
          student,
          allSubjectiveQuestions,
          (previousSummary.questionGrades || []).filter((grade) =>
            allSubjectiveQuestions.some((question) => question.questionNo === grade.questionNo),
          ),
          previousSummary.overallComment || '',
          settings,
        ),
      );
    });

    const finalStudentSummaries = task.studentRecords.map((student) => updatedStudentSummaries.get(student.id)).filter(Boolean);

    const snapshot = {
      profile,
      lastRunAt: now,
      studentCount: task.studentRecords.length,
      questionCount: allSubjectiveQuestions.length,
      selectedQuestionCount: selectedQuestions.length,
      gradedStudentCount: finalStudentSummaries.filter((student) => student.gradedQuestionCount > 0).length,
      gradedQuestionCount: finalStudentSummaries.reduce((sum, student) => sum + Number(student.gradedQuestionCount || 0), 0),
      pendingQuestionCount: finalStudentSummaries.reduce((sum, student) => sum + Number(student.pendingQuestionCount || 0), 0),
      reviewQuestionCount: finalStudentSummaries.reduce((sum, student) => sum + Number(student.reviewQuestionCount || 0), 0),
      studentSummaries: finalStudentSummaries,
    };

    const detail = saveTaskSubjectiveGrading(req.params.taskId, snapshot);
    res.json({
      task: detail,
      subjectiveGrading: detail?.subjectiveGrading ?? null,
      gradedStudentIds,
      failedStudents,
    });
  } catch (error) {
    console.error('[subjective-grading] request failed:', error);
    res.status(400).json({ message: error.message });
  }
});

app.delete('/api/tasks/:taskId/subjective-grading', (req, res) => {
  try {
    const detail = clearTaskSubjectiveGrading(req.params.taskId);
    res.json({
      task: detail,
      subjectiveGrading: detail?.subjectiveGrading ?? null,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.post('/api/tasks/:taskId/subjective-grading/review', (req, res) => {
  try {
    const task = getTaskDetail(req.params.taskId);
    if (!task || !task.subjectiveGrading) {
      res.status(404).json({ message: '当前任务还没有主观题批改结果。' });
      return;
    }

    const questionNo = String(req.body?.questionNo || '').trim();
    const studentId = String(req.body?.studentId || '').trim();
    const action = String(req.body?.action || '').trim();
    const reviewer = String(req.body?.reviewer || '教师').trim() || '教师';
    const reason = String(req.body?.reason || '').trim();
    const reviewedAt = new Date().toISOString();

    if (!questionNo || !studentId || !['confirm', 'adjust'].includes(action)) {
      res.status(400).json({ message: '复核参数不完整。' });
      return;
    }

    const student = task.studentRecords.find((item) => item.id === studentId);
    const question = getEnabledSubjectiveQuestions(task).find((item) => String(item.questionNo || '').trim() === questionNo);
    const previousSummary = (task.subjectiveGrading.studentSummaries || []).find((item) => item.studentId === studentId);
    const previousGrade = previousSummary?.questionGrades?.find((item) => String(item.questionNo || '').trim() === questionNo);
    if (!student || !question || !previousSummary || !previousGrade) {
      res.status(404).json({ message: '未找到对应的复核题目。' });
      return;
    }

    if (action === 'adjust' && !reason) {
      res.status(400).json({ message: '教师改分时必须填写修改原因。' });
      return;
    }

    const requestedScore = Number(req.body?.score);
    const nextScore = action === 'adjust'
      ? Math.max(0, Math.min(Number(question.score || 0), Number.isFinite(requestedScore) ? requestedScore : NaN))
      : Number(previousGrade.earnedScore || 0);
    if (action === 'adjust' && !Number.isFinite(nextScore)) {
      res.status(400).json({ message: '教师改分时请填写有效分数。' });
      return;
    }

    const nextStudentSummaries = (task.subjectiveGrading.studentSummaries || []).map((summary) => {
      if (summary.studentId !== studentId) return summary;

      const nextQuestionGrades = (summary.questionGrades || []).map((grade) => {
        if (String(grade.questionNo || '').trim() !== questionNo) return grade;
        const originalEarnedScore = Number(grade.originalEarnedScore ?? grade.earnedScore ?? 0);
        const nextEarnedScore = action === 'adjust' ? nextScore : Number(grade.earnedScore || 0);
        const baseComment = String(grade.questionComment || '').trim() || '本题已完成评分。';
        const teacherNote = action === 'adjust'
          ? `教师复核：AI 原得分 ${originalEarnedScore} 分，教师改为 ${nextEarnedScore} 分。原因：${reason}`
          : `教师复核：已确认 AI 得分 ${nextEarnedScore} 分。`;

        return {
          ...grade,
          earnedScore: nextEarnedScore,
          originalEarnedScore,
          requiresReview: false,
          reviewState: action === 'adjust' ? 'adjusted' : 'confirmed',
          reviewNote: action === 'adjust' ? reason : '',
          reviewedAt,
          reviewer,
          questionComment: `${baseComment}\n${teacherNote}`,
        };
      });

      return rebuildSubjectiveStudentSummary(
        student,
        getEnabledSubjectiveQuestions(task),
        nextQuestionGrades,
        summary.overallComment || '',
        getSettings(),
      );
    });

    const snapshot = {
      ...task.subjectiveGrading,
      reviewQuestionCount: nextStudentSummaries.reduce((sum, summary) => sum + Number(summary.reviewQuestionCount || 0), 0),
      studentSummaries: nextStudentSummaries,
    };

    const detail = saveTaskSubjectiveGrading(req.params.taskId, snapshot);
    res.json({
      task: detail,
      subjectiveGrading: detail?.subjectiveGrading ?? null,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.get('/api/tasks/:taskId/subjective-grading/export.docx', async (req, res) => {
  try {
    const task = getTaskDetail(req.params.taskId);
    if (!task) {
      res.status(404).json({ message: '任务不存在。' });
      return;
    }

    const result = await buildSubjectiveGradingDocx(task);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="subjective-grading-export.docx"; filename*=UTF-8''${encodeDownloadFileName(result.fileName)}`,
    );
    res.setHeader('Content-Length', Buffer.byteLength(result.buffer));
    res.setHeader('X-Exported-Student-Count', String(result.exportedStudentCount));
    res.end(result.buffer);
  } catch (error) {
    console.error('[subjective-grading-export] request failed:', error);
    res.status(400).json({ message: error.message });
  }
});

app.post('/api/tasks/:taskId/extract-materials', async (req, res) => {
  try {
    const task = getTaskDetail(req.params.taskId);
    if (!task) {
      res.status(404).json({ message: '任务不存在。' });
      return;
    }

    const questionUploads = listUploadsByKind(req.params.taskId, 'question');
    const answerUploads = listUploadsByKind(req.params.taskId, 'answer');

    const [questionSources, answerSources] = await Promise.all([
      Promise.all(questionUploads.map((record) => normalizeUpload(record))),
      Promise.all(answerUploads.map((record) => normalizeUpload(record))),
    ]);

    const profile = ['general', 'subjectiveGrading'].includes(String(req.body?.profile || '').trim())
      ? String(req.body.profile).trim()
      : 'general';

    const result = await extractMaterialDrafts({
      settings: getSettings(),
      profile,
      questionSources,
      answerSources,
      scope: task.questionScope,
      mode: task.mode,
    });

    const mergedQuestions = mergeExtractedQuestions(task.questions || [], result.questions || []);
    replaceTaskQuestions(req.params.taskId, mergedQuestions);
    res.json({
      ...result,
      questions: mergedQuestions,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

try {
  const recoverySummary = recoverInterruptedAnswerSheetRecognitions();
  if (recoverySummary.recoveredCount > 0) {
    console.warn(
      `[startup] recovered ${recoverySummary.recoveredCount} interrupted answer-sheet recognition(s) across ${recoverySummary.taskCount} task(s).`,
    );
  }
} catch (error) {
  console.error('[startup] Failed to recover interrupted answer-sheet recognitions:', error);
}

if (fs.existsSync(frontendIndexPath)) {
  app.use(express.static(frontendDistDir, { index: false }));
  app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(frontendIndexPath);
  });
}

app.listen(port, host, () => {
  const localHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  console.log(`History AI Grader backend listening on http://${localHost}:${port}`);
});

