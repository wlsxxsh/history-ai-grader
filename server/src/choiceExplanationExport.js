const {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  ShadingType,
  TabStopType,
  TextRun,
} = require('docx');

const MAIN_FONT = '宋体';
const HEADING_FONT = '黑体';
const COLOR_TEXT = '2F2A25';
const COLOR_MUTED = '7A6D61';
const COLOR_ACCENT = 'A65A3A';
const COLOR_LINE = 'DDCFC2';
const COLOR_BOX = 'FAF6F1';
const COLOR_BOX_STRONG = 'F4ECE2';
const COLOR_SUMMARY = 'FFF7EA';
const SIZE_TITLE = 30;
const SIZE_SUBTITLE = 22;
const SIZE_BODY = 21;
const SIZE_META = 18;

function compareQuestionNo(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function normalizeText(value) {
  return String(value || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeInlineText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizeFileNamePart(value, fallback) {
  const text = String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ');
  return text || fallback;
}

function formatDateTime(value) {
  const date = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '暂无';
  return `${Math.round(Math.max(0, Math.min(1, numeric)) * 100)}%`;
}

function getExportFileName(task) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const taskName = sanitizeFileNamePart(task?.name, '选择题解析');
  const className = sanitizeFileNamePart(task?.className, '未分班级');
  return `${taskName}-${className}-选择题解析-${stamp}.docx`;
}

function createParagraph(text, options = {}) {
  const {
    bold = false,
    color = COLOR_TEXT,
    size = SIZE_BODY,
    font = MAIN_FONT,
    spacing = { before: 0, after: 90, line: 300 },
    alignment,
    indent,
    border,
    shading,
    heading,
    thematicBreak,
    tabStops,
    keepNext,
    keepLines,
  } = options;

  return new Paragraph({
    spacing,
    alignment,
    indent,
    border,
    shading,
    heading,
    thematicBreak,
    tabStops,
    keepNext,
    keepLines,
    children: [
      new TextRun({
        text,
        bold,
        color,
        size,
        font,
      }),
    ],
  });
}

function createRichParagraph(children, options = {}) {
  return new Paragraph({
    spacing: options.spacing || { before: 0, after: 90, line: 300 },
    alignment: options.alignment,
    indent: options.indent,
    border: options.border,
    shading: options.shading,
    tabStops: options.tabStops,
    keepNext: options.keepNext,
    keepLines: options.keepLines,
    children,
  });
}

function createLabelValueLine(label, value) {
  return createRichParagraph(
    [
      new TextRun({
        text: label,
        font: MAIN_FONT,
        size: SIZE_META,
        color: COLOR_ACCENT,
        bold: true,
      }),
      new TextRun({
        text: value,
        font: MAIN_FONT,
        size: SIZE_META,
        color: COLOR_MUTED,
      }),
    ],
    { spacing: { before: 0, after: 60, line: 280 } },
  );
}

function createBulletParagraph(prefix, value, options = {}) {
  return createRichParagraph(
    [
      new TextRun({
        text: prefix,
        font: MAIN_FONT,
        size: SIZE_BODY,
        color: COLOR_ACCENT,
        bold: true,
      }),
      new TextRun({
        text: value,
        font: MAIN_FONT,
        size: SIZE_BODY,
        color: COLOR_TEXT,
      }),
    ],
    {
      spacing: options.spacing || { before: 0, after: 50, line: 280 },
      indent: options.indent || { left: 220, hanging: 0 },
      keepLines: true,
    },
  );
}

function createSectionBox(title, bodyParagraphs, fill = COLOR_BOX) {
  return [
    createParagraph(title, {
      bold: true,
      color: COLOR_ACCENT,
      size: SIZE_META,
      spacing: { before: 60, after: 50, line: 260 },
      shading: { fill, type: ShadingType.CLEAR, color: 'auto' },
      border: {
        left: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 6, space: 8 },
        top: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 4, space: 4 },
        bottom: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 4, space: 4 },
      },
      indent: { left: 120, right: 120 },
      keepNext: true,
    }),
    ...bodyParagraphs.map((paragraph, index) => {
      if (index === bodyParagraphs.length - 1) {
        paragraph.options = paragraph.options || {};
      }
      return paragraph;
    }),
  ];
}

function buildQuestionHeading(question) {
  const title = normalizeInlineText(question?.title);
  return createRichParagraph(
    [
      new TextRun({
        text: `第${question.questionNo}题`,
        font: HEADING_FONT,
        size: SIZE_SUBTITLE,
        color: COLOR_TEXT,
        bold: true,
      }),
      ...(title
        ? [
            new TextRun({
              text: `  ${title}`,
              font: MAIN_FONT,
              size: SIZE_META,
              color: COLOR_MUTED,
            }),
          ]
        : []),
    ],
    {
      spacing: { before: 180, after: 80, line: 300 },
      border: {
        bottom: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 6, space: 6 },
      },
      keepNext: true,
      keepLines: true,
    },
  );
}

function buildMetaParagraph(question) {
  const metaParts = [
    `◆ 正确答案：${normalizeInlineText(question?.correctAnswer) || '暂无'}`,
    `◆ 正确率：${question?.correctRate == null ? '暂无' : formatPercent(question.correctRate)}`,
  ];

  if (normalizeInlineText(question?.topWrongOption)) {
    metaParts.push(`◆ 高频误选：${question.topWrongOption}${question?.topWrongOptionCount ? `（${question.topWrongOptionCount}人）` : ''}`);
  } else if (Number(question?.wrongCount || 0) > 0) {
    metaParts.push(`◆ 错误人数：${Math.max(0, Number(question.wrongCount || 0))}人`);
  }

  return createParagraph(metaParts.join('    '), {
    color: COLOR_MUTED,
    size: SIZE_META,
    spacing: { before: 0, after: 80, line: 260 },
    keepNext: true,
  });
}

function buildPromptStemParagraph(question) {
  const promptStem = normalizeText(question?.promptStem);
  if (!promptStem) return [];

  return [
    createRichParagraph(
      [
        new TextRun({
          text: '【题干主旨】',
          font: MAIN_FONT,
          size: SIZE_META,
          color: COLOR_ACCENT,
          bold: true,
        }),
        new TextRun({
          text: promptStem,
          font: MAIN_FONT,
          size: SIZE_BODY,
          color: COLOR_TEXT,
        }),
      ],
      {
        spacing: { before: 0, after: 90, line: 290 },
        shading: { fill: COLOR_BOX_STRONG, type: ShadingType.CLEAR, color: 'auto' },
        border: {
          left: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 6, space: 8 },
          right: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 6, space: 8 },
          top: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 4, space: 4 },
          bottom: { style: BorderStyle.SINGLE, color: COLOR_LINE, size: 4, space: 4 },
        },
        indent: { left: 120, right: 120 },
        keepLines: true,
      },
    ),
  ];
}

function buildThinkingStepParagraphs(question) {
  const steps = Array.isArray(question?.thinkingSteps) ? question.thinkingSteps : [];
  const circled = ['① ', '② ', '③ ', '④ ', '⑤ ', '⑥ '];

  if (!steps.length) {
    return [createBulletParagraph('• ', '当前题目暂未生成老师思路。')];
  }

  return steps.map((step, index) => {
    const label = normalizeInlineText(step?.label);
    const content = normalizeText(step?.content);
    const prefix = circled[index] || `${index + 1}. `;
    const fullText = label ? `${label}：${content || '暂无内容'}` : (content || '暂无内容');
    return createBulletParagraph(prefix, fullText);
  });
}

function buildWrongOptionParagraphs(question) {
  const analyses = (Array.isArray(question?.wrongOptionAnalyses) ? question.wrongOptionAnalyses : [])
    .map((item) => ({
      option: normalizeInlineText(item?.option),
      reasonType: normalizeInlineText(item?.reasonType),
      analysis: normalizeText(item?.analysis),
    }))
    .filter((item) => item.option || item.reasonType || item.analysis);

  if (!analyses.length) {
    return [createBulletParagraph('• ', '当前题目暂无错误选项分析。')];
  }

  return analyses.map((item) => {
    const head = `${item.option || '?'}项${item.reasonType ? `（${item.reasonType}）` : ''}：`;
    return createBulletParagraph('• ', `${head}${item.analysis || '暂无分析内容'}`);
  });
}

function buildSummaryParagraph(question) {
  const summary = normalizeText(question?.summary);
  if (!summary) {
    return [
      createBulletParagraph('◎ ', '当前题目暂未生成讲题总结。', {
        spacing: { before: 0, after: 80, line: 280 },
      }),
    ];
  }

  return [
    createBulletParagraph('◎ ', summary, {
      spacing: { before: 0, after: 80, line: 280 },
    }),
  ];
}

function buildQuestionContent(question, isLast) {
  const paragraphs = [
    buildQuestionHeading(question),
    buildMetaParagraph(question),
    ...buildPromptStemParagraph(question),
    ...createSectionBox('【老师的思考过程】', buildThinkingStepParagraphs(question)),
    ...createSectionBox('【错误选项错在哪里】', buildWrongOptionParagraphs(question)),
    ...createSectionBox('【讲题总结】', buildSummaryParagraph(question), COLOR_SUMMARY),
  ];

  if (!isLast) {
    paragraphs.push(
      createParagraph('', {
        thematicBreak: true,
        spacing: { before: 30, after: 30, line: 60 },
      }),
    );
  }

  return paragraphs;
}

async function buildChoiceExplanationDocx(task) {
  const explanation = task?.choiceExplanation || null;
  const questions = (Array.isArray(explanation?.questions) ? explanation.questions : [])
    .filter((question) => String(question?.questionNo || '').trim())
    .slice()
    .sort((left, right) => compareQuestionNo(left.questionNo, right.questionNo));

  if (!questions.length) {
    throw new Error('当前任务还没有可导出的选择题解析。');
  }

  const metaQuestionNos = questions.map((question) => question.questionNo).join('、');
  const children = [
    createParagraph(task?.name || '选择题详细解析', {
      font: HEADING_FONT,
      bold: true,
      size: SIZE_TITLE,
      color: COLOR_TEXT,
      spacing: { before: 0, after: 120, line: 320 },
      alignment: AlignmentType.CENTER,
    }),
    createRichParagraph(
      [
        new TextRun({
          text: `班级：${normalizeInlineText(task?.className) || '未分班级'}`,
          font: MAIN_FONT,
          size: SIZE_META,
          color: COLOR_MUTED,
        }),
        new TextRun({
          text: '\t',
          font: MAIN_FONT,
          size: SIZE_META,
        }),
        new TextRun({
          text: `导出时间：${formatDateTime(new Date())}`,
          font: MAIN_FONT,
          size: SIZE_META,
          color: COLOR_MUTED,
        }),
      ],
      {
        spacing: { before: 0, after: 50, line: 260 },
        tabStops: [{ type: TabStopType.RIGHT, position: 9000 }],
      },
    ),
    createLabelValueLine('◆ 解析阈值：', `${Number.isFinite(Number(explanation?.threshold)) ? Number(explanation.threshold) : 80}%`),
    createLabelValueLine('◆ 解析题号：', metaQuestionNos),
  ];

  if (Array.isArray(explanation?.warnings) && explanation.warnings.length) {
    children.push(
      createParagraph('导出提示', {
        bold: true,
        color: COLOR_ACCENT,
        size: SIZE_META,
        spacing: { before: 60, after: 40, line: 260 },
        keepNext: true,
      }),
    );

    explanation.warnings
      .map((item) => normalizeText(item))
      .filter(Boolean)
      .forEach((warning) => {
        children.push(
          createBulletParagraph('• ', warning, {
            spacing: { before: 0, after: 40, line: 270 },
          }),
        );
      });
  }

  children.push(
    createParagraph('', {
      thematicBreak: true,
      spacing: { before: 60, after: 80, line: 60 },
    }),
  );

  questions.forEach((question, index) => {
    children.push(...buildQuestionContent(question, index === questions.length - 1));
  });

  const document = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 900,
              right: 920,
              bottom: 900,
              left: 920,
              header: 360,
              footer: 360,
              gutter: 0,
            },
          },
        },
        children,
      },
    ],
  });

  return {
    buffer: await Packer.toBuffer(document),
    fileName: getExportFileName(task),
    exportedQuestionCount: questions.length,
  };
}

module.exports = {
  buildChoiceExplanationDocx,
};
