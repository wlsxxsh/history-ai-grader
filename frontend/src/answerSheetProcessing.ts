// @ts-nocheck
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type {
  AnswerSheetAnalysisProfile,
  AnswerSheetBoxDraft,
  AnswerSheetChoiceRegionDraft,
  AnswerSheetDraft,
  AnswerSheetRegionDraft,
  AnswerSheetTemplateAnalysisResponse,
  ChoiceRecognitionDraft,
  StudentRecognitionDraft,
  SubjectiveQuestionDraft,
  SubjectiveRecognitionDraft,
  UploadedFileRecord,
} from './types';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_RENDER_WIDTH = 1400;
const NAME_MATCH_THRESHOLD = 0.76;
const NAME_GUESS_THRESHOLD = 0.62;

interface RenderedPage {
  sourceUploadId: string;
  sourceName: string;
  sourcePageNumber: number;
  globalPageNumber: number;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
}

interface ProcessingResult {
  answerSheet: AnswerSheetDraft;
  warnings: string[];
}

interface ProcessAnswerSheetOptions {
  rosterNames: string[];
  taskMode: 'choice' | 'subjective' | 'mixed';
  questionHints: Array<{ questionNo: string; type: 'choice' | 'subjective' | 'essay' }>;
  answerSheetDraft: AnswerSheetDraft;
  templateUploads: UploadedFileRecord[];
  scanUploads: UploadedFileRecord[];
  profile: AnswerSheetAnalysisProfile;
  analyzeTemplate: (payload: {
    imageDataUrl: string;
    mode: 'choice' | 'subjective' | 'mixed';
    profile: AnswerSheetAnalysisProfile;
    questionHints: Array<{ questionNo: string; type: 'choice' | 'subjective' | 'essay' }>;
  }) => Promise<AnswerSheetTemplateAnalysisResponse>;
  analyzeStudent: (payload: {
    pageImageDataUrl: string;
    mode: 'choice' | 'subjective' | 'mixed';
    profile: AnswerSheetAnalysisProfile;
    rosterNames: string[];
    choiceQuestionNos: string[];
    subjectiveQuestions: SubjectiveQuestionDraft[];
  }) => Promise<{
    matchedStudentName: string;
    rawStudentName: string;
    matchConfidence: number;
    choiceAnswers: ChoiceRecognitionDraft[];
    subjectiveAnswers: SubjectiveRecognitionDraft[];
    warnings: string[];
  }>;
  onProgress?: (message: string) => void;
}

interface RecognizedPage {
  pageIndex: number;
  pageRef: string;
  matchedStudentName: string;
  rawStudentName: string;
  matchConfidence: number;
  choiceAnswers: ChoiceRecognitionDraft[];
  subjectiveAnswers: SubjectiveRecognitionDraft[];
  warnings: string[];
}

interface Assignment {
  studentName: string;
  matchedName: string;
  confidence: number;
  reason: string;
  extra: boolean;
}

interface TemplateLayoutResult {
  templateMode: AnswerSheetDraft['templateMode'];
  templateSummary: string;
  nameRegion: AnswerSheetBoxDraft | null;
  choiceRegion: AnswerSheetChoiceRegionDraft | null;
  choiceQuestionNos: string[];
  subjectiveQuestions: SubjectiveQuestionDraft[];
  subjectiveRegions: AnswerSheetRegionDraft[];
}

function emitProgress(onProgress: ProcessAnswerSheetOptions['onProgress'], message: string) {
  onProgress?.(message);
}

function shouldProcessChoice(mode: ProcessAnswerSheetOptions['taskMode']) {
  return mode === 'choice' || mode === 'mixed';
}

function shouldProcessSubjective(mode: ProcessAnswerSheetOptions['taskMode']) {
  return mode === 'subjective' || mode === 'mixed';
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function clamp01(value: number, fallback = 0) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function normalizeText(value: string) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[，。、“”‘’：:；,\.!?？！()（）[\]【】<>《》·\-_/\\]/g, '')
    .toLowerCase();
}

function compareQuestionNo(left: string, right: string) {
  return left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function normalizeQuestionNoList(values: string[]) {
  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean))).sort(compareQuestionNo);
}

function normalizeSubjectiveQuestionType(value: string): SubjectiveQuestionDraft['questionType'] {
  return value === 'essay' ? 'essay' : 'subjective';
}

function getTemplateModeFromContent(choiceQuestionNos: string[], subjectiveQuestions: SubjectiveQuestionDraft[]): AnswerSheetDraft['templateMode'] {
  const hasChoice = choiceQuestionNos.length > 0;
  const hasSubjective = subjectiveQuestions.length > 0;
  if (hasChoice && hasSubjective) return 'choice_subjective';
  if (hasChoice) return 'choice_only';
  return 'subjective_only';
}

function normalizeBox(region: Partial<AnswerSheetBoxDraft> | null | undefined, fallback: AnswerSheetBoxDraft): AnswerSheetBoxDraft {
  return {
    left: clamp01(Number(region?.left), fallback.left),
    top: clamp01(Number(region?.top), fallback.top),
    width: clamp01(Number(region?.width), fallback.width),
    height: clamp01(Number(region?.height), fallback.height),
    label: String(region?.label ?? fallback.label).trim(),
    source: region?.source === 'manual' || region?.source === 'template' || region?.source === 'derived' ? region.source : fallback.source,
  };
}

function buildFallbackNameRegion(choiceRegion: AnswerSheetChoiceRegionDraft | null): AnswerSheetBoxDraft {
  return {
    left: 0.05,
    top: 0.02,
    width: choiceRegion ? 0.32 : 0.4,
    height: 0.08,
    label: '姓名区',
    source: 'derived',
  };
}

function buildFallbackChoiceRegion(subjectiveRegions: AnswerSheetRegionDraft[]): AnswerSheetChoiceRegionDraft {
  const firstSubjectiveTop = subjectiveRegions.length ? Math.max(0.28, subjectiveRegions[0].top - 0.04) : 0.42;
  return {
    left: 0.05,
    top: 0.1,
    width: 0.9,
    height: clamp01(firstSubjectiveTop - 0.1, 0.28),
    label: '选择题区',
    source: 'derived',
    questionNos: [],
  };
}

function buildFallbackSubjectiveRegions(
  subjectiveQuestions: SubjectiveQuestionDraft[],
  choiceRegion: AnswerSheetChoiceRegionDraft | null,
): AnswerSheetRegionDraft[] {
  if (!subjectiveQuestions.length) return [];

  const startTop = choiceRegion ? Math.min(0.92, choiceRegion.top + choiceRegion.height + 0.04) : 0.24;
  const availableHeight = Math.max(0.2, 0.92 - startTop);
  const slotHeight = Math.max(0.12, availableHeight / subjectiveQuestions.length - 0.02);

  return subjectiveQuestions.map((item, index) => ({
    id: `region-${item.questionNo}`,
    questionNo: item.questionNo,
    questionType: item.questionType,
    anchorText: '',
    startHint: '',
    endHint: '',
    note: '',
    left: 0.05,
    top: clamp01(startTop + index * (availableHeight / subjectiveQuestions.length), 0.24),
    width: 0.9,
    height: clamp01(slotHeight, 0.16),
    order: index + 1,
    source: 'derived',
  }));
}

function normalizeTemplateSubjectiveRegion(
  region: Partial<AnswerSheetRegionDraft>,
  fallbackQuestion: SubjectiveQuestionDraft,
  index: number,
): AnswerSheetRegionDraft {
  return {
    id: region.id || `region-${fallbackQuestion.questionNo}`,
    questionNo: String(region.questionNo || fallbackQuestion.questionNo).trim(),
    questionType: normalizeSubjectiveQuestionType(region.questionType || fallbackQuestion.questionType),
    anchorText: String(region.anchorText || '').trim(),
    startHint: String(region.startHint || '').trim(),
    endHint: String(region.endHint || '').trim(),
    note: String(region.note || '').trim(),
    left: clamp01(Number(region.left), 0.05),
    top: clamp01(Number(region.top), 0.42 + index * 0.18),
    width: clamp01(Number(region.width), 0.9),
    height: clamp01(Number(region.height), 0.16),
    order: Number.isFinite(Number(region.order)) ? Number(region.order) : index + 1,
    source:
      region.source === 'template' || region.source === 'manual' || region.source === 'derived' || region.source === 'questionConfig'
        ? region.source
        : 'template',
  };
}

function levenshteinDistance(source: string, target: string) {
  if (source === target) return 0;
  if (!source) return target.length;
  if (!target) return source.length;

  const matrix = Array.from({ length: source.length + 1 }, () => Array<number>(target.length + 1).fill(0));
  for (let row = 0; row <= source.length; row += 1) matrix[row][0] = row;
  for (let col = 0; col <= target.length; col += 1) matrix[0][col] = col;

  for (let row = 1; row <= source.length; row += 1) {
    for (let col = 1; col <= target.length; col += 1) {
      const cost = source[row - 1] === target[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost,
      );
    }
  }

  return matrix[source.length][target.length];
}

function getStringSimilarity(source: string, target: string) {
  const left = normalizeText(source);
  const right = normalizeText(target);
  if (!left || !right) return 0;
  if (left.includes(right) || right.includes(left)) return 0.99;
  const distance = levenshteinDistance(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

function buildChoiceAnswers(
  answers: ChoiceRecognitionDraft[],
  expectedQuestionNos: string[],
  existing: ChoiceRecognitionDraft[] = [],
): ChoiceRecognitionDraft[] {
  const expected = normalizeQuestionNoList(expectedQuestionNos);
  const answerMap = new Map(answers.map((item) => [item.questionNo, item]));
  const existingMap = new Map(existing.map((item) => [item.questionNo, item]));
  const sourceQuestionNos = expected.length ? expected : normalizeQuestionNoList([...answerMap.keys(), ...existingMap.keys()]);

  return sourceQuestionNos.map((questionNo, index) => {
    const recognized = answerMap.get(questionNo);
    const current = existingMap.get(questionNo);

    return {
      id: current?.id || recognized?.id || `choice-${questionNo || index + 1}`,
      questionNo,
      answer: String(recognized?.answer ?? current?.answer ?? '')
        .trim()
        .toUpperCase()
        .replace(/[^A-D]/g, '')
        .slice(0, 1),
      confidence: Number.isFinite(Number(recognized?.confidence))
        ? Number(recognized?.confidence)
        : Number.isFinite(Number(current?.confidence))
          ? Number(current?.confidence)
          : 0,
    };
  });
}

function buildSubjectiveAnswers(
  answers: SubjectiveRecognitionDraft[],
  expectedQuestions: SubjectiveQuestionDraft[],
  existing: StudentRecognitionDraft['subjectiveAnswers'] = [],
): StudentRecognitionDraft['subjectiveAnswers'] {
  const answerMap = new Map(answers.map((item) => [item.questionNo, item]));
  const existingMap = new Map(existing.map((item) => [item.questionNo, item]));
  const sourceQuestions = expectedQuestions.length
    ? [...expectedQuestions].sort((left, right) => compareQuestionNo(left.questionNo, right.questionNo))
    : normalizeQuestionNoList([...answerMap.keys(), ...existingMap.keys()]).map((questionNo) => ({
        id: `subjective-question-${questionNo}`,
        questionNo,
        questionType: 'subjective' as const,
        source: 'template' as const,
      }));

  return sourceQuestions.map((question, index) => {
    const recognized = answerMap.get(question.questionNo);
    const current = existingMap.get(question.questionNo);
    const answerText = String(recognized?.answerText ?? current?.answerText ?? '').trim();
    const confidence = Number.isFinite(Number(recognized?.confidence))
      ? Number(recognized?.confidence)
      : Number.isFinite(Number(current?.confidence))
        ? Number(current?.confidence)
        : 0;

    return {
      id: current?.id || recognized?.id || `subjective-${question.questionNo || index + 1}`,
      questionNo: question.questionNo,
      questionType: normalizeSubjectiveQuestionType(recognized?.questionType || current?.questionType || question.questionType),
      answerText,
      revisedText: current?.revisedText || '',
      confidence,
      sliceLabel: current?.sliceLabel || '',
      ocrText: String(recognized?.ocrText ?? answerText),
      slicePreviewUrl: current?.slicePreviewUrl || '',
      slicePageRef: current?.slicePageRef || '',
      ocrConfidence: Number.isFinite(Number(recognized?.ocrConfidence))
        ? Number(recognized?.ocrConfidence)
        : Number.isFinite(Number(current?.ocrConfidence))
          ? Number(current?.ocrConfidence)
          : confidence,
      needsReview: current?.needsReview ?? (confidence > 0 && confidence < 0.72),
    };
  });
}

function buildMissingStudentRecord(studentName: string, existing?: StudentRecognitionDraft): StudentRecognitionDraft {
  return {
    id: existing?.id || `student-${studentName}`,
    studentName,
    status: 'missing',
    reason: '未检测到对应页。请确认学生是否未交，或扫描件是否缺页。',
    matchedName: '',
    confidence: 0,
    pageRef: '',
    choiceAnswers: existing?.choiceAnswers ?? [],
    subjectiveAnswers: existing?.subjectiveAnswers ?? [],
  };
}

async function loadBlob(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`无法读取文件：${url}`);
  }

  return response.blob();
}

async function renderImageBlob(upload: UploadedFileRecord, blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = bitmap.width > MAX_RENDER_WIDTH ? MAX_RENDER_WIDTH / bitmap.width : 1;
  const canvas = createCanvas(bitmap.width * scale, bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('浏览器画布不可用，无法处理图片。');
  }

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return [
    {
      sourceUploadId: upload.id,
      sourceName: upload.originalName,
      sourcePageNumber: 1,
      globalPageNumber: 0,
      width: canvas.width,
      height: canvas.height,
      canvas,
    },
  ] satisfies RenderedPage[];
}

async function renderPdfBlob(upload: UploadedFileRecord, blob: Blob) {
  const pdf = await getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const pages: RenderedPage[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = baseViewport.width > MAX_RENDER_WIDTH ? MAX_RENDER_WIDTH / baseViewport.width : 1.5;
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('浏览器画布不可用，无法渲染 PDF。');
    }

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, canvas }).promise;

    pages.push({
      sourceUploadId: upload.id,
      sourceName: upload.originalName,
      sourcePageNumber: pageNumber,
      globalPageNumber: 0,
      width: canvas.width,
      height: canvas.height,
      canvas,
    });
  }

  return pages;
}

async function renderUploads(uploads: UploadedFileRecord[], onProgress?: ProcessAnswerSheetOptions['onProgress']) {
  const renderedPages: RenderedPage[] = [];
  let globalPageNumber = 1;

  for (const upload of uploads) {
    const downloadUrl = upload.downloadUrl || upload.previewUrl;
    if (!downloadUrl) {
      throw new Error(`文件 ${upload.originalName} 缺少下载地址，无法继续处理。`);
    }

    emitProgress(onProgress, `正在读取 ${upload.originalName}...`);
    const blob = await loadBlob(downloadUrl);
    const pages =
      upload.mimeType === 'application/pdf' || upload.originalName.toLowerCase().endsWith('.pdf')
        ? await renderPdfBlob(upload, blob)
        : await renderImageBlob(upload, blob);

    for (const page of pages) {
      page.globalPageNumber = globalPageNumber;
      globalPageNumber += 1;
      renderedPages.push(page);
    }
  }

  return renderedPages;
}

function canvasToDataUrl(canvas: HTMLCanvasElement) {
  return canvas.toDataURL('image/jpeg', 0.92);
}

function buildPageRef(page: RenderedPage) {
  return `第 ${page.globalPageNumber} 页`;
}

function cropCanvas(source: HTMLCanvasElement, region: AnswerSheetBoxDraft | AnswerSheetRegionDraft) {
  const left = Math.round(clamp01(region.left) * source.width);
  const top = Math.round(clamp01(region.top) * source.height);
  const width = Math.max(1, Math.round(clamp01(region.width, 1) * source.width));
  const height = Math.max(1, Math.round(clamp01(region.height, 1) * source.height));
  const boundedWidth = Math.min(width, source.width - left);
  const boundedHeight = Math.min(height, source.height - top);
  const canvas = createCanvas(Math.max(1, boundedWidth), Math.max(1, boundedHeight));
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('浏览器画布不可用，无法裁切版式区域。');
  }

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, left, top, Math.max(1, boundedWidth), Math.max(1, boundedHeight), 0, 0, canvas.width, canvas.height);
  return canvas;
}

void cropCanvas;

function mergeSubjectiveQuestions(
  fromTemplate: SubjectiveQuestionDraft[],
  questionHints: ProcessAnswerSheetOptions['questionHints'],
  existingQuestions: SubjectiveQuestionDraft[] = [],
) {
  const questionMap = new Map<string, SubjectiveQuestionDraft>();

  existingQuestions.forEach((item) => {
    if (item.questionNo) {
      questionMap.set(item.questionNo, {
        id: item.id || `subjective-question-${item.questionNo}`,
        questionNo: item.questionNo,
        questionType: normalizeSubjectiveQuestionType(item.questionType),
        source: item.source === 'template' ? 'template' : 'questionConfig',
      });
    }
  });

  questionHints
    .filter((item) => item.type !== 'choice')
    .forEach((item) => {
      if (!item.questionNo) return;
      questionMap.set(item.questionNo, {
        id: questionMap.get(item.questionNo)?.id || `subjective-question-${item.questionNo}`,
        questionNo: item.questionNo,
        questionType: item.type === 'essay' ? 'essay' : 'subjective',
        source: 'questionConfig',
      });
    });

  fromTemplate.forEach((item) => {
    if (!item.questionNo) return;
    const existing = questionMap.get(item.questionNo);
    questionMap.set(item.questionNo, {
      id: existing?.id || item.id || `subjective-question-${item.questionNo}`,
      questionNo: item.questionNo,
      questionType: existing?.questionType || normalizeSubjectiveQuestionType(item.questionType),
      source: 'template',
    });
  });

  return [...questionMap.values()].sort((left, right) => compareQuestionNo(left.questionNo, right.questionNo));
}

function mergeChoiceQuestionNos(
  fromTemplate: string[],
  questionHints: ProcessAnswerSheetOptions['questionHints'],
  existingQuestionNos: string[] = [],
) {
  return normalizeQuestionNoList([
    ...existingQuestionNos,
    ...fromTemplate,
    ...questionHints.filter((item) => item.type === 'choice').map((item) => item.questionNo),
  ]);
}

function mergeTemplateLayout(
  templateAnalysis: AnswerSheetTemplateAnalysisResponse,
  questionHints: ProcessAnswerSheetOptions['questionHints'],
  existingDraft: AnswerSheetDraft,
): TemplateLayoutResult {
  const subjectiveQuestions = mergeSubjectiveQuestions(
    templateAnalysis.subjectiveQuestions,
    questionHints,
    existingDraft.subjectiveQuestions,
  );

  const choiceQuestionNos = mergeChoiceQuestionNos(
    templateAnalysis.choiceQuestionNos,
    questionHints,
    existingDraft.choiceQuestionNos,
  );

  const rawTemplateMode =
    templateAnalysis.templateMode === 'choice_only' ||
    templateAnalysis.templateMode === 'subjective_only' ||
    templateAnalysis.templateMode === 'choice_subjective'
      ? templateAnalysis.templateMode
      : getTemplateModeFromContent(choiceQuestionNos, subjectiveQuestions);

  const choiceRegion =
    templateAnalysis.choiceRegion || existingDraft.choiceRegion
      ? {
          ...normalizeBox(templateAnalysis.choiceRegion || existingDraft.choiceRegion, buildFallbackChoiceRegion([])),
          questionNos: choiceQuestionNos,
        }
      : choiceQuestionNos.length
        ? { ...buildFallbackChoiceRegion([]), questionNos: choiceQuestionNos }
        : null;

  const nameRegion = normalizeBox(
    templateAnalysis.nameRegion || existingDraft.nameRegion,
    buildFallbackNameRegion(choiceRegion),
  );

  const regionSource = templateAnalysis.subjectiveRegions?.length
    ? templateAnalysis.subjectiveRegions
    : existingDraft.subjectiveRegions;
  const subjectiveRegions = regionSource.length
    ? subjectiveQuestions
        .map((question, index) => {
          const matched = regionSource.find((region) => region.questionNo === question.questionNo);
          return normalizeTemplateSubjectiveRegion(matched || {}, question, index);
        })
        .sort((left, right) => left.order - right.order || compareQuestionNo(left.questionNo, right.questionNo))
    : buildFallbackSubjectiveRegions(subjectiveQuestions, choiceRegion);

  return {
    templateMode: rawTemplateMode,
    templateSummary:
      templateAnalysis.summary ||
      [
        choiceQuestionNos.length ? `选择题 ${choiceQuestionNos.length} 题` : '',
        subjectiveQuestions.length ? `主观题 ${subjectiveQuestions.length} 题` : '',
      ]
        .filter(Boolean)
        .join('，'),
    nameRegion,
    choiceRegion,
    choiceQuestionNos,
    subjectiveQuestions,
    subjectiveRegions,
  };
}

function getExistingRecordMap(answerSheetDraft: AnswerSheetDraft) {
  return new Map(answerSheetDraft.studentRecords.map((record) => [record.studentName, record]));
}

function getBestRosterCandidate(result: RecognizedPage, rosterNames: string[]) {
  if (rosterNames.includes(result.matchedStudentName)) {
    return {
      name: result.matchedStudentName,
      score: Math.max(result.matchConfidence, NAME_MATCH_THRESHOLD),
      rawText: result.rawStudentName || result.matchedStudentName,
    };
  }

  const sourceTexts = [result.rawStudentName, result.matchedStudentName].filter(Boolean);
  let best: { name: string; score: number; rawText: string } | null = null;

  for (const name of rosterNames) {
    for (const sourceText of sourceTexts) {
      const score = getStringSimilarity(sourceText, name);
      if (!best || score > best.score) {
        best = {
          name,
          score,
          rawText: sourceText,
        };
      }
    }
  }

  return best;
}

function assignRecognizedPages(results: RecognizedPage[], rosterNames: string[]) {
  const assignments = new Map<number, Assignment>();
  const remainingNames = new Set(rosterNames);

  const highConfidenceResults = results
    .map((result) => ({
      result,
      bestMatch: getBestRosterCandidate(result, rosterNames),
    }))
    .filter((item) => item.bestMatch && item.bestMatch.score >= NAME_MATCH_THRESHOLD)
    .sort((left, right) => (right.bestMatch?.score || 0) - (left.bestMatch?.score || 0));

  for (const item of highConfidenceResults) {
    const bestMatch = item.bestMatch;
    if (!bestMatch || !remainingNames.has(bestMatch.name) || assignments.has(item.result.pageIndex)) continue;

    assignments.set(item.result.pageIndex, {
      studentName: bestMatch.name,
      matchedName: bestMatch.rawText,
      confidence: bestMatch.score,
      reason: '',
      extra: false,
    });
    remainingNames.delete(bestMatch.name);
  }

  const remainingRosterNames = rosterNames.filter((name) => remainingNames.has(name));
  let extraIndex = 1;

  for (const result of results) {
    if (assignments.has(result.pageIndex)) continue;

    const bestMatch = getBestRosterCandidate(result, rosterNames);
    if (bestMatch && remainingNames.has(bestMatch.name) && bestMatch.score >= NAME_GUESS_THRESHOLD) {
      assignments.set(result.pageIndex, {
        studentName: bestMatch.name,
        matchedName: bestMatch.rawText,
        confidence: bestMatch.score,
        reason: `姓名识别不够稳定，系统暂按 ${bestMatch.name} 归档，请人工抽查。`,
        extra: false,
      });
      remainingNames.delete(bestMatch.name);
      const index = remainingRosterNames.indexOf(bestMatch.name);
      if (index >= 0) remainingRosterNames.splice(index, 1);
      continue;
    }

    const fallbackName = remainingRosterNames.shift();
    if (fallbackName) {
      assignments.set(result.pageIndex, {
        studentName: fallbackName,
        matchedName: result.rawStudentName || result.matchedStudentName,
        confidence: 0,
        reason: `姓名识别不稳定，先按页面顺序挂到 ${fallbackName}，请人工处理。`,
        extra: false,
      });
      remainingNames.delete(fallbackName);
      continue;
    }

    assignments.set(result.pageIndex, {
      studentName: `未识别-${extraIndex}`,
      matchedName: result.rawStudentName || result.matchedStudentName,
      confidence: 0,
      reason: '答题页数量超过班级名单数量，已暂存为额外记录。',
      extra: true,
    });
    extraIndex += 1;
  }

  return assignments;
}

function mergeRecordReason(assignment: Assignment, result: RecognizedPage) {
  const notes = [assignment.reason, ...result.warnings].filter(Boolean);
  return notes.join('；');
}

function hasReviewRisk(record: {
  confidence: number;
  reason: string;
  choiceAnswers: ChoiceRecognitionDraft[];
  subjectiveAnswers: StudentRecognitionDraft['subjectiveAnswers'];
}) {
  if (record.reason) return true;
  if (record.confidence > 0 && record.confidence < NAME_MATCH_THRESHOLD) return true;
  if (record.choiceAnswers.some((item) => !item.answer && item.confidence > 0)) return true;
  if (record.subjectiveAnswers.some((item) => item.needsReview)) return true;
  return false;
}

export async function processAnswerSheetRecognition(options: ProcessAnswerSheetOptions): Promise<ProcessingResult> {
  const warnings: string[] = [];

  if (!options.templateUploads.length) {
    throw new Error('请先上传空白答题卡。');
  }

  if (!options.scanUploads.length) {
    throw new Error('请先上传学生答题卡扫描件。');
  }

  const templatePages = await renderUploads(options.templateUploads, options.onProgress);
  const scanPages = await renderUploads(options.scanUploads, options.onProgress);

  if (!templatePages.length) {
    throw new Error('空白答题卡模板没有可用页面。');
  }

  if (templatePages.length > 1) {
    warnings.push(`检测到 ${templatePages.length} 张模板页，当前仅使用第 1 页作为版式模板。`);
  }

  const templatePage = templatePages[0];
  emitProgress(options.onProgress, '正在分析空白答题卡版式...');
  const templateAnalysis = await options.analyzeTemplate({
    imageDataUrl: canvasToDataUrl(templatePage.canvas),
    mode: options.taskMode,
    profile: options.profile,
    questionHints: options.questionHints,
  });

  warnings.push(...templateAnalysis.warnings);

  const templateLayout = mergeTemplateLayout(templateAnalysis, options.questionHints, options.answerSheetDraft);

  if (shouldProcessChoice(options.taskMode) && !templateLayout.choiceQuestionNos.length) {
    warnings.push('当前批改模式需要识别选择题，但模板中未识别出稳定的选择题区域或题号。');
  }

  if (shouldProcessSubjective(options.taskMode) && !templateLayout.subjectiveQuestions.length) {
    warnings.push('当前批改模式需要识别主观题，但模板中未识别出稳定的主观题区域。');
  }

  const recognizedPages: RecognizedPage[] = [];

  for (const [pageIndex, page] of scanPages.entries()) {
    emitProgress(options.onProgress, `正在识别第 ${pageIndex + 1} 份学生答题卡...`);

    const pageImageDataUrl = canvasToDataUrl(page.canvas);

    const result = await options.analyzeStudent({
      pageImageDataUrl,
      mode: options.taskMode,
      profile: options.profile,
      rosterNames: options.rosterNames,
      choiceQuestionNos: templateLayout.choiceQuestionNos,
      subjectiveQuestions: templateLayout.subjectiveQuestions,
    });

    const pageWarnings = [...result.warnings];
    if (!result.rawStudentName && !result.matchedStudentName) {
      pageWarnings.push('姓名区域未识别出稳定结果。');
    }

    recognizedPages.push({
      pageIndex,
      pageRef: buildPageRef(page),
      matchedStudentName: result.matchedStudentName,
      rawStudentName: result.rawStudentName,
      matchConfidence: result.matchConfidence,
      choiceAnswers: buildChoiceAnswers(result.choiceAnswers, templateLayout.choiceQuestionNos),
      subjectiveAnswers: buildSubjectiveAnswers(result.subjectiveAnswers, templateLayout.subjectiveQuestions),
      warnings: pageWarnings,
    });
  }

  const assignments = assignRecognizedPages(recognizedPages, options.rosterNames);
  const existingRecordMap = getExistingRecordMap(options.answerSheetDraft);

  const rosterRecords: StudentRecognitionDraft[] = options.rosterNames.map((studentName) =>
    buildMissingStudentRecord(studentName, existingRecordMap.get(studentName)),
  );
  const rosterRecordMap = new Map(rosterRecords.map((item) => [item.studentName, item]));
  const extraRecords: StudentRecognitionDraft[] = [];

  for (const result of recognizedPages) {
    const assignment = assignments.get(result.pageIndex);
    if (!assignment) continue;

    const existing = existingRecordMap.get(assignment.studentName);
    const draftRecord: StudentRecognitionDraft = {
      id: existing?.id || `student-${assignment.studentName}`,
      studentName: assignment.studentName,
      status: 'submitted',
      reason: mergeRecordReason(assignment, result),
      matchedName: assignment.matchedName,
      confidence: assignment.confidence,
      pageRef: result.pageRef,
      choiceAnswers: buildChoiceAnswers(result.choiceAnswers, templateLayout.choiceQuestionNos, existing?.choiceAnswers),
      subjectiveAnswers: buildSubjectiveAnswers(result.subjectiveAnswers, templateLayout.subjectiveQuestions, existing?.subjectiveAnswers),
    };

    draftRecord.status = hasReviewRisk(draftRecord) ? 'pending' : 'submitted';

    if (assignment.extra) {
      extraRecords.push(draftRecord);
    } else {
      rosterRecordMap.set(draftRecord.studentName, draftRecord);
    }
  }

  return {
    answerSheet: {
      ...options.answerSheetDraft,
      engine: 'doubao',
      templateMode: templateLayout.templateMode,
      pageBasedRecognition: true,
      templateSummary: templateLayout.templateSummary,
      choiceQuestionNos: templateLayout.choiceQuestionNos,
      subjectiveQuestions: templateLayout.subjectiveQuestions,
      nameRegion: templateLayout.nameRegion,
      choiceRegion: templateLayout.choiceRegion,
      subjectiveRegions: templateLayout.subjectiveRegions,
      studentRecords: [...options.rosterNames.map((name) => rosterRecordMap.get(name) || buildMissingStudentRecord(name)), ...extraRecords],
    },
    warnings,
  };
}
