export type TaskMode = 'choice' | 'subjective' | 'mixed';
export type ChoiceExplanationModelProfile = 'general' | 'normal' | 'strong';
export type AnswerSheetAnalysisProfile = 'general' | 'answerSheet';
export type SubjectiveGradingProfile = 'general' | 'subjectiveGrading';
export type SubjectiveGradingSnapshotProfile = SubjectiveGradingProfile | 'normal' | 'strong';
export type AnswerSheetProfile = 'general' | 'answerSheet' | 'normal' | 'strong';
export type AnswerSheetRecognizerProfile = 'general' | 'answerSheet';
export type ExtractModelProfile = 'general' | 'subjectiveGrading';
export type UploadKind = 'question' | 'answer';
export type AnswerSheetStatus = 'pending' | 'processing' | 'done' | 'error';
export type AnswerSheetEngine = 'doubao';
export type StudentRecordStatus = 'unsubmitted' | 'partial' | 'ready' | 'needs_review';
export type AggregatedAnswerState = 'missing' | 'blank' | 'answered' | 'manual' | 'conflict';
export type ChoiceGradeStatus = 'correct' | 'wrong' | 'blank' | 'pending' | 'review' | 'unavailable';

export interface Classroom {
  id: string;
  name: string;
  studentsText: string;
}

export interface AppSettings {
  generalProvider: 'doubao';
  generalApiKey: string;
  generalModel: string;
  answerSheetProvider: 'siliconflow';
  answerSheetApiKey: string;
  answerSheetModel: string;
  subjectiveGradingProvider: 'siliconflow';
  subjectiveGradingApiKey: string;
  subjectiveGradingModel: string;
  apiBaseUrl: string;
  answerSheetBatchConcurrency: number;
  rolePreset: 'strict' | 'gentle' | 'objective' | 'custom';
  customRolePrompt: string;
  subjectiveOrdinaryRulePrompt: string;
  subjectiveEssayRulePrompt: string;
  classrooms: Classroom[];
}

export interface TaskSummary {
  id: string;
  name: string;
  className: string;
  mode: TaskMode;
  status: string;
  version: number;
  questionCount: number;
  updatedAt: string;
}

export interface UploadedFileRecord {
  id: string;
  kind: UploadKind;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface ChoiceAnswerRecognition {
  questionNo: string;
  answer: string;
}

export interface SubjectiveAnswerRecognition {
  questionNo: string;
  content: string;
}

export interface AggregatedChoiceAnswer {
  questionNo: string;
  answer: string;
  baseAnswer: string;
  state: AggregatedAnswerState;
  baseState: Exclude<AggregatedAnswerState, 'manual'>;
  hasOverride: boolean;
  sourceSheetIds: string[];
  sourceLabels: string[];
}

export interface AggregatedSubjectiveAnswer {
  questionNo: string;
  content: string;
  baseContent: string;
  state: AggregatedAnswerState;
  baseState: Exclude<AggregatedAnswerState, 'manual'>;
  hasOverride: boolean;
  sourceSheetIds: string[];
  sourceLabels: string[];
}

export interface StudentAnswerSheetRecord {
  id: string;
  sourceOriginalName: string;
  sourcePage: number;
  displayName: string;
  mimeType: string;
  size: number;
  status: AnswerSheetStatus;
  engine: AnswerSheetEngine | '';
  profile: AnswerSheetProfile | '';
  provider: string;
  selectedModel: string;
  studentName: string;
  manualStudentName: string;
  observedNames: string[];
  suggestedStudentName: string;
  suggestedStudentConfidence: number;
  previewUrl: string;
  choiceAnswers: ChoiceAnswerRecognition[];
  subjectiveAnswers: SubjectiveAnswerRecognition[];
  warnings: string[];
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
  recognizedAt: string;
}

export interface StudentRecordSource {
  sheetId: string;
  label: string;
  updatedAt: string;
  status: AnswerSheetStatus;
}

export type AnswerSheetBatchJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface AnswerSheetBatchJob {
  id: string;
  taskId: string;
  profile: AnswerSheetProfile;
  engine: AnswerSheetEngine;
  status: AnswerSheetBatchJobStatus;
  requestedCount: number;
  processedCount: number;
  successCount: number;
  errorCount: number;
  workerCount: number;
  failedSheets: Array<{ sheetId: string; displayName: string; message: string }>;
  message: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
}

export interface StudentProgressRecord {
  id: string;
  studentName: string;
  isExtra: boolean;
  status: StudentRecordStatus;
  sheetCount: number;
  sources: StudentRecordSource[];
  choiceAnswers: AggregatedChoiceAnswer[];
  subjectiveAnswers: AggregatedSubjectiveAnswer[];
  warnings: string[];
  updatedAt: string;
}

export interface ChoiceQuestionGradeRecord {
  questionNo: string;
  answer: string;
  standardAnswer: string;
  questionScore: number;
  earnedScore: number;
  status: ChoiceGradeStatus;
  answerState: AggregatedAnswerState;
  sourceLabels: string[];
  signature: string;
  gradedAt: string;
}

export interface ChoiceStudentGradingRecord {
  studentId: string;
  studentName: string;
  isExtra: boolean;
  totalScore: number;
  earnedScore: number;
  correctCount: number;
  wrongCount: number;
  blankCount: number;
  pendingCount: number;
  reviewCount: number;
  unavailableCount: number;
  questionGrades: ChoiceQuestionGradeRecord[];
  updatedAt: string;
}

export interface ChoiceQuestionOptionStat {
  option: string;
  count: number;
  studentNames: string[];
}

export interface ChoiceQuestionSummaryRecord {
  questionNo: string;
  standardAnswer: string;
  score: number;
  correctRate: number;
  correctCount: number;
  wrongCount: number;
  blankCount: number;
  pendingCount: number;
  reviewCount: number;
  unavailableCount: number;
  optionStats: ChoiceQuestionOptionStat[];
}

export interface ChoiceGradingSnapshot {
  profile: 'general';
  lastRunAt: string;
  studentCount: number;
  questionCount: number;
  gradedQuestionCount: number;
  newlyGradedCount: number;
  updatedQuestionCount: number;
  pendingQuestionCount: number;
  reviewQuestionCount: number;
  studentSummaries: ChoiceStudentGradingRecord[];
  questionSummaries: ChoiceQuestionSummaryRecord[];
}

export interface ChoiceExplanationThinkingStep {
  label: string;
  content: string;
}

export interface ChoiceExplanationWrongOptionAnalysis {
  option: string;
  reasonType: string;
  analysis: string;
}

export interface ChoiceExplanationQuestion {
  questionNo: string;
  title: string;
  correctAnswer: string;
  promptStem: string;
  correctRate: number | null;
  wrongCount: number;
  topWrongOption: string;
  topWrongOptionCount: number;
  thinkingSteps: ChoiceExplanationThinkingStep[];
  wrongOptionAnalyses: ChoiceExplanationWrongOptionAnalysis[];
  summary: string;
}

export interface ChoiceExplanationSnapshot {
  threshold: number;
  selectedQuestionNos: string[];
  generatedAt: string;
  sourceUploadIds: string[];
  modelProfile: ChoiceExplanationModelProfile;
  questions: ChoiceExplanationQuestion[];
  warnings: string[];
}

export interface SubjectiveAnnotationError {
  excerpt: string;
  reason: string;
}

export interface SubjectiveAnnotationSet {
  matches: string[];
  errors: SubjectiveAnnotationError[];
}

export interface SubjectiveSubReview {
  label: string;
  score: number;
  fullScore: number;
  comment: string;
  matchedExcerpts: string[];
}

export interface SubjectivePointReview {
  key: string;
  sectionKey: string;
  sectionLabel: string;
  sectionOrder: number;
  pointOrder: number;
  pointLabel: string;
  score: number;
  fullScore: number;
  comment: string;
  matchedExcerpts: string[];
}

export interface SubjectiveSectionReview {
  key: string;
  label: string;
  order: number;
  score: number;
  fullScore: number;
  comment: string;
  pointKeys: string[];
  matchedExcerpts: string[];
}

export interface SubjectiveAnnotationRange {
  key: string;
  start: number;
  end: number;
  tone: 'match' | 'error';
  score?: number;
  reason?: string;
  pointKey?: string;
  sectionKey?: string;
}

export interface SubjectiveEssayReviewChecks {
  hasThesis?: boolean | null;
  isObjectCorrect?: boolean | null;
  isJudgmentCorrect?: boolean | null;
  isWithinScope?: boolean | null;
  focusedOnThesis?: boolean | null;
  hasHeading?: boolean | null;
  hasHistoricalEvidence?: boolean | null;
  explainsEvidence?: boolean | null;
  linksBackToThesis?: boolean | null;
  hasReasonableExplanation?: boolean | null;
  hasAnalysis?: boolean | null;
  isFactuallyAccurate?: boolean | null;
  hasConclusion?: boolean | null;
  hasSummary?: boolean | null;
  hasElevation?: boolean | null;
  factualErrorCount?: number | null;
  matchedObjectGroupCount?: number | null;
  matchedJudgmentGroupCount?: number | null;
  matchedScopeGroupCount?: number | null;
}

export interface SubjectiveEssayCriterionResult {
  code: string;
  label: string;
  passed?: boolean | null;
  positiveTag: string;
  negativeTag: string;
  suggestion?: string;
  deductionText?: string;
  count?: number | null;
}

export interface SubjectiveEssayKeywordGroupMatch {
  id?: string;
  label: string;
  type?: EssayKeywordGroupType | string;
  required?: boolean;
  matched: boolean;
  matchedExpressions?: string[];
  missingExpressions?: string[];
}

export interface SubjectiveEssayReviewSection {
  key?: string;
  label: string;
  order?: number;
  score: number;
  fullScore: number;
  excerpt: string;
  comment: string;
  tags?: string[];
  issues?: string[];
  factualErrors?: string[];
  checks?: SubjectiveEssayReviewChecks;
  criteriaResults?: SubjectiveEssayCriterionResult[];
  suggestedText?: string;
  keywordGroupMatches?: SubjectiveEssayKeywordGroupMatch[];
  replacementThesis?: string;
}

export interface SubjectiveEssayReview {
  thesis?: SubjectiveEssayReviewSection | null;
  bodySections: SubjectiveEssayReviewSection[];
  conclusion?: SubjectiveEssayReviewSection | null;
}

export interface SubjectiveQuestionGradeRecord {
  questionNo: string;
  questionType: 'subjective' | 'essay';
  questionScore: number;
  earnedScore: number;
  originalEarnedScore?: number;
  answerState: AggregatedAnswerState;
  sourceLabels: string[];
  studentAnswer: string;
  questionContent: string;
  standardAnswer: string;
  gradingRule: string;
  questionComment: string;
  essayReview?: SubjectiveEssayReview | null;
  pointReviews?: SubjectivePointReview[];
  sectionReviews?: SubjectiveSectionReview[];
  annotationRanges?: SubjectiveAnnotationRange[];
  subReviews: SubjectiveSubReview[];
  displaySubReviews: SubjectiveSubReview[];
  annotations: SubjectiveAnnotationSet;
  requiresReview: boolean;
  reviewState?: 'pending' | 'confirmed' | 'adjusted';
  reviewNote?: string;
  reviewedAt?: string;
  reviewer?: string;
  signature: string;
  gradedAt: string;
}

export interface SubjectiveStudentGradingRecord {
  studentId: string;
  studentName: string;
  isExtra: boolean;
  totalScore: number;
  earnedScore: number;
  gradedQuestionCount: number;
  pendingQuestionCount: number;
  reviewQuestionCount: number;
  overallComment: string;
  questionGrades: SubjectiveQuestionGradeRecord[];
  updatedAt: string;
}

export interface SubjectiveGradingSnapshot {
  profile: SubjectiveGradingSnapshotProfile;
  lastRunAt: string;
  studentCount: number;
  questionCount: number;
  selectedQuestionCount: number;
  gradedStudentCount: number;
  gradedQuestionCount: number;
  pendingQuestionCount: number;
  reviewQuestionCount: number;
  studentSummaries: SubjectiveStudentGradingRecord[];
}

export interface OrdinaryGradingPoint {
  id: string;
  label: string;
  score: number;
  aliases: string[];
  notes: string[];
  allowSimilar: boolean;
}

export interface OrdinaryGradingSubquestion {
  id: string;
  label: string;
  score: number;
  pickEnabled: boolean;
  pickCount: number | null;
  points: OrdinaryGradingPoint[];
}

export interface OrdinaryGradingSection {
  id: string;
  label: string;
  score: number;
  pickEnabled: boolean;
  pickCount: number | null;
  subquestions: OrdinaryGradingSubquestion[];
}

export interface OrdinaryGradingRuleTree {
  version: number;
  sections: OrdinaryGradingSection[];
}

export type EssayCriterionPenaltyMode = 'deduct' | 'zero' | 'cap_total';
export type EssayCriterionPenaltyMeasure = 'once' | 'per_item';
export type EssayKeywordGroupType = 'judgment' | 'object' | 'scope';

export interface EssayCriterion {
  id: string;
  code: string;
  label: string;
  penaltyMode: EssayCriterionPenaltyMode;
  penaltyValue: number;
  penaltyMeasure: EssayCriterionPenaltyMeasure;
}

export interface EssayKeywordExpression {
  id: string;
  text: string;
}

export interface EssayKeywordGroup {
  id: string;
  label: string;
  type: EssayKeywordGroupType;
  required: boolean;
  enabled: boolean;
  expressions: EssayKeywordExpression[];
}

export interface EssayThesisRule {
  score: number;
  templates: string[];
  keywordGroups: EssayKeywordGroup[];
  criteria: EssayCriterion[];
}

export interface EssayBodyParagraphRule {
  id: string;
  label: string;
  score: number;
  scopeKeywordGroups: EssayKeywordGroup[];
  criteria: EssayCriterion[];
}

export interface EssayBodyRule {
  paragraphCount: number;
  paragraphs: EssayBodyParagraphRule[];
}

export interface EssayConclusionRule {
  score: number;
  criteria: EssayCriterion[];
}

export interface EssayRuleTree {
  version: number;
  notes: string;
  globalOffTopicCap: number;
  thesis: EssayThesisRule;
  body: EssayBodyRule;
  conclusion: EssayConclusionRule;
}

export interface QuestionDraft {
  id: string;
  questionNo: string;
  type: 'choice' | 'subjective' | 'essay';
  score: number;
  content: string;
  standardAnswer: string;
  analysis: string;
  gradingRule: string;
  gradingRuleTree?: OrdinaryGradingRuleTree | null;
  essayRuleTree?: EssayRuleTree | null;
  tags: string[];
  enabled: boolean;
  source: 'manual' | 'ai';
}

export interface TaskDetail extends TaskSummary {
  homeworkDate: string;
  questionScope: string;
  description: string;
  questions: QuestionDraft[];
  uploads: UploadedFileRecord[];
  answerSheets: StudentAnswerSheetRecord[];
  studentRecords: StudentProgressRecord[];
  choiceGrading: ChoiceGradingSnapshot | null;
  choiceExplanation: ChoiceExplanationSnapshot | null;
  subjectiveGrading: SubjectiveGradingSnapshot | null;
}

export interface ExtractResponse {
  questions: QuestionDraft[];
  warnings: string[];
  provider: string;
}

export interface HealthResponse {
  ok: boolean;
  now: string;
}
