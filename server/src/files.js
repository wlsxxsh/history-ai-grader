const fs = require('node:fs');
const path = require('node:path');
const pdfParse = require('pdf-parse');

function fileToDataUrl(filePath, mimeType) {
  const buffer = fs.readFileSync(filePath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function normalizeUpload(record) {
  const filePath = record.stored_path || record.storedPath;
  const originalName = record.original_name || record.originalName;
  const mimeType = record.mime_type || record.mimeType || '';
  const ext = path.extname(originalName).toLowerCase();

  if (mimeType.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.bmp', '.webp'].includes(ext)) {
    return {
      kind: 'image',
      name: originalName,
      content: fileToDataUrl(filePath, mimeType || 'image/png'),
    };
  }

  if (ext === '.pdf' || mimeType === 'application/pdf') {
    const parsed = await pdfParse(fs.readFileSync(filePath));
    if (!parsed.text?.trim()) {
      throw new Error(`文件 ${originalName} 无法提取到可读文本，请换成图片格式或等下一步 OCR 模块。`);
    }

    return {
      kind: 'text',
      name: originalName,
      content: parsed.text.trim(),
    };
  }

  return {
    kind: 'text',
    name: originalName,
    content: fs.readFileSync(filePath, 'utf8'),
  };
}

module.exports = {
  fileToDataUrl,
  normalizeUpload,
};
