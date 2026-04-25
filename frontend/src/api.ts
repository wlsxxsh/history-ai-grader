import type {
  AppSettings,
  AnswerSheetAnalysisProfile,
  AnswerSheetBatchJob,
  AnswerSheetEngine,
  AnswerSheetRecognizerProfile,
  ChoiceExplanationModelProfile,
  ExtractModelProfile,
  ExtractResponse,
  HealthResponse,
  QuestionDraft,
  SubjectiveGradingProfile,
  TaskDetail,
  TaskMode,
  TaskSummary,
  UploadKind,
} from './types';

async function readErrorMessage(response: Response) {
  const payload = await response.json().catch(() => ({ message: '请求失败' }));
  return payload.message ?? '请求失败';
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const response = await fetch(input, {
    ...init,
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return response.json() as Promise<T>;
}

function parseFileNameFromDisposition(contentDisposition: string | null) {
  if (!contentDisposition) return '';

  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const plainMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
  return plainMatch?.[1] || '';
}

export function fetchHealth() {
  return request<HealthResponse>('/api/health');
}

export function fetchSettings() {
  return request<AppSettings>('/api/settings');
}

export function saveSettings(payload: AppSettings) {
  return request<AppSettings>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function runSettingsMaintenance(scope: 'cache' | 'data') {
  return request<{
    ok: boolean;
    scope: 'cache' | 'data';
    message: string;
    details: Record<string, unknown>;
  }>('/api/settings/maintenance', {
    method: 'POST',
    body: JSON.stringify({ scope }),
  });
}

export function testModelConnection(target: 'general' | 'answerSheet' | 'subjectiveGrading') {
  return request<{ ok: boolean; message: string; preview: string }>('/api/settings/test-connection', {
    method: 'POST',
    body: JSON.stringify({ target }),
  });
}

export function fetchTasks() {
  return request<TaskSummary[]>('/api/tasks');
}

export function createTask(mode: TaskMode) {
  return request<TaskDetail>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  });
}

export function deleteTask(taskId: string) {
  return request<{ ok: boolean }>(`/api/tasks/${taskId}`, {
    method: 'DELETE',
  });
}

export function fetchTask(taskId: string) {
  return request<TaskDetail>(`/api/tasks/${taskId}`);
}

export function saveTaskBasic(taskId: string, payload: Partial<TaskDetail>) {
  return request<TaskDetail>(`/api/tasks/${taskId}/basic`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function saveTaskQuestions(taskId: string, questions: QuestionDraft[]) {
  return request<{ ok: boolean; questions: QuestionDraft[] }>(`/api/tasks/${taskId}/questions`, {
    method: 'PUT',
    body: JSON.stringify({ questions }),
  });
}

export function generatePointAliasSuggestions(payload: {
  questionNo: string;
  questionContent: string;
  standardAnswer: string;
  sectionLabel: string;
  subquestionLabel: string;
  pointLabel: string;
  existingAliases: string[];
  notes: string[];
}) {
  return request<{ aliases: string[] }>('/api/grading-rule/alias-suggestions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function generateEssayThesisSuggestions(payload: {
  questionNo: string;
  questionContent: string;
  standardAnswer: string;
  existingTemplates: string[];
  existingKeywordGroups?: Array<{
    label: string;
    type: 'judgment' | 'object' | 'scope';
    expressions: string[];
  }>;
  notes?: string;
}) {
  return request<{
    theses: string[];
    keywordGroups: Array<{
      label: string;
      type: 'judgment' | 'object' | 'scope';
      expressions: string[];
    }>;
  }>('/api/grading-rule/essay-thesis-suggestions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function uploadTaskFiles(taskId: string, kind: UploadKind, files: File[]) {
  const body = new FormData();
  files.forEach((file) => body.append('files', file));

  return request<{ uploads: TaskDetail['uploads'] }>(`/api/tasks/${taskId}/uploads?kind=${kind}`, {
    method: 'POST',
    body,
  });
}

export function deleteTaskUpload(taskId: string, uploadId: string) {
  return request<{ ok: boolean }>(`/api/tasks/${taskId}/uploads/${uploadId}`, {
    method: 'DELETE',
  });
}

export function extractMaterials(taskId: string, profile: ExtractModelProfile) {
  return request<ExtractResponse>(`/api/tasks/${taskId}/extract-materials`, {
    method: 'POST',
    body: JSON.stringify({ profile }),
  });
}

export function runChoiceGrading(taskId: string) {
  return request<{ choiceGrading: TaskDetail['choiceGrading']; task: TaskDetail }>(`/api/tasks/${taskId}/choice-grading`, {
    method: 'POST',
  });
}

export function generateChoiceExplanations(
  taskId: string,
  payload: {
    profile?: ChoiceExplanationModelProfile;
    threshold: number;
    selectedQuestionNos: string[];
  },
) {
  return request<{ choiceExplanation: TaskDetail['choiceExplanation']; task: TaskDetail }>(`/api/tasks/${taskId}/choice-explanations`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function clearChoiceExplanations(taskId: string) {
  return request<{ choiceExplanation: TaskDetail['choiceExplanation']; task: TaskDetail }>(`/api/tasks/${taskId}/choice-explanations`, {
    method: 'DELETE',
  });
}

export function runSubjectiveGrading(
  taskId: string,
  payload: {
    profile: SubjectiveGradingProfile;
    studentIds: string[];
    questionNos: string[];
    force?: boolean;
    studentConcurrency?: number;
  },
) {
  return request<{
    subjectiveGrading: TaskDetail['subjectiveGrading'];
    task: TaskDetail;
    gradedStudentIds: string[];
    failedStudents: Array<{ studentId: string; studentName: string; message: string }>;
  }>(
    `/api/tasks/${taskId}/subjective-grading`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
}

export function clearSubjectiveGrading(taskId: string) {
  return request<{
    subjectiveGrading: TaskDetail['subjectiveGrading'];
    task: TaskDetail;
  }>(`/api/tasks/${taskId}/subjective-grading`, {
    method: 'DELETE',
  });
}

export async function exportSubjectiveGradingDocx(taskId: string) {
  const response = await fetch(`/api/tasks/${taskId}/subjective-grading/export.docx`);

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return {
    blob: await response.blob(),
    fileName: parseFileNameFromDisposition(response.headers.get('Content-Disposition')) || 'subjective-grading-export.docx',
  };
}

export async function exportChoiceExplanationDocx(taskId: string) {
  const response = await fetch(`/api/tasks/${taskId}/choice-explanations/export.docx`);

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return {
    blob: await response.blob(),
    fileName: parseFileNameFromDisposition(response.headers.get('Content-Disposition')) || 'choice-explanation-export.docx',
  };
}

export function uploadAnswerSheets(taskId: string, files: File[]) {
  const body = new FormData();
  files.forEach((file) => body.append('files', file));

  return request<{ answerSheets: TaskDetail['answerSheets'] }>(`/api/tasks/${taskId}/answer-sheets/uploads`, {
    method: 'POST',
    body,
  });
}

export function recognizeAnswerSheet(
  taskId: string,
  sheetId: string,
  payload: { engine: AnswerSheetEngine; profile: AnswerSheetRecognizerProfile; retainQuestionNos?: string[] },
) {
  return request<{ answerSheet: TaskDetail['answerSheets'][number] }>(`/api/tasks/${taskId}/answer-sheets/${sheetId}/recognize`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function recognizeAnswerSheetsBatch(
  taskId: string,
  payload: { sheetIds: string[]; engine: AnswerSheetEngine; profile: AnswerSheetRecognizerProfile; retainQuestionNos?: string[] },
) {
  return request<{
    ok: boolean;
    job: AnswerSheetBatchJob;
  }>(`/api/tasks/${taskId}/answer-sheets/recognize-batch`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export type { AnswerSheetAnalysisProfile };

export function fetchAnswerSheetBatchJob(taskId: string, jobId: string) {
  return request<{
    ok: boolean;
    job: AnswerSheetBatchJob;
  }>(`/api/tasks/${taskId}/answer-sheets/recognize-batch/${jobId}`);
}

export function deleteAnswerSheet(taskId: string, sheetId: string) {
  return request<{ ok: boolean }>(`/api/tasks/${taskId}/answer-sheets/${sheetId}`, {
    method: 'DELETE',
  });
}

export function updateAnswerSheet(
  taskId: string,
  sheetId: string,
  payload: Partial<Pick<TaskDetail['answerSheets'][number], 'manualStudentName' | 'choiceAnswers' | 'subjectiveAnswers'>>,
) {
  return request<{ answerSheet: TaskDetail['answerSheets'][number] }>(`/api/tasks/${taskId}/answer-sheets/${sheetId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function updateStudentRecord(
  taskId: string,
  payload: {
    studentName: string;
    choiceOverrides: Array<{ questionNo: string; answer: string }>;
    subjectiveOverrides: Array<{ questionNo: string; content: string }>;
  },
) {
  return request<{ studentRecords: TaskDetail['studentRecords'] }>(`/api/tasks/${taskId}/student-records`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function reviewSubjectiveQuestion(
  taskId: string,
  payload: {
    questionNo: string;
    studentId: string;
    action: 'confirm' | 'adjust';
    score?: number;
    reason?: string;
    reviewer?: string;
  },
) {
  return request<{
    task: TaskDetail;
    subjectiveGrading: TaskDetail['subjectiveGrading'];
  }>(`/api/tasks/${taskId}/subjective-grading/review`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
