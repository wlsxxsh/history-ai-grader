const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createCanvas, DOMMatrix, ImageData, Path2D, loadImage } = require('@napi-rs/canvas');
const { uploadDir } = require('./db');

global.DOMMatrix = global.DOMMatrix || DOMMatrix;
global.ImageData = global.ImageData || ImageData;
global.Path2D = global.Path2D || Path2D;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp']);
const MAX_RENDER_WIDTH = 2200;
const MAX_RENDER_HEIGHT = 3200;
const MAX_JPEG_BYTES = 4 * 1024 * 1024;

let pdfjsPromise = null;
let pdfjsModulePath = '';

function resolvePdfjsModulePath() {
  if (pdfjsModulePath) {
    return pdfjsModulePath;
  }

  let packageDir = '';
  try {
    packageDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  } catch (error) {
    throw new Error('未找到 pdfjs-dist 依赖，请先在 server 目录重新安装依赖。');
  }

  const candidates = [
    path.join(packageDir, 'legacy', 'build', 'pdf.mjs'),
    path.join(packageDir, 'build', 'pdf.mjs'),
  ];
  const matchedPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!matchedPath) {
    throw new Error('当前 pdfjs-dist 安装不完整，缺少可用的 PDF 渲染入口，请重新安装 server 依赖。');
  }

  pdfjsModulePath = matchedPath;
  return pdfjsModulePath;
}

function getPdfjsLib() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(pathToFileURL(resolvePdfjsModulePath()).href);
  }

  return pdfjsPromise;
}

function fitIntoBox(width, height) {
  const scale = Math.min(MAX_RENDER_WIDTH / width, MAX_RENDER_HEIGHT / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function createWhiteCanvas(width, height) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  return { canvas, context };
}

async function encodeCanvasAsJpeg(canvas) {
  const qualities = [92, 86, 80, 72];
  let buffer = await canvas.encode('jpeg', qualities[0]);

  for (const quality of qualities.slice(1)) {
    if (buffer.length <= MAX_JPEG_BYTES) {
      return buffer;
    }

    buffer = await canvas.encode('jpeg', quality);
  }

  return buffer;
}

async function normalizeImageFile(filePath) {
  const image = await loadImage(filePath);
  const { width, height } = fitIntoBox(image.width, image.height);
  const { canvas, context } = createWhiteCanvas(width, height);
  context.drawImage(image, 0, 0, width, height);
  return encodeCanvasAsJpeg(canvas);
}

async function renderPdfPages(filePath) {
  const pdfjsLib = await getPdfjsLib();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const document = await pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
  }).promise;
  const pageBuffers = [];

  for (let pageIndex = 1; pageIndex <= document.numPages; pageIndex += 1) {
    const page = await document.getPage(pageIndex);
    const initialViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(MAX_RENDER_WIDTH / initialViewport.width, MAX_RENDER_HEIGHT / initialViewport.height);
    const viewport = page.getViewport({ scale: Math.max(scale, 1) });
    const { canvas, context } = createWhiteCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));

    await page.render({ canvasContext: context, viewport }).promise;
    pageBuffers.push(await encodeCanvasAsJpeg(canvas));
    page.cleanup();
  }

  return pageBuffers;
}

async function renderPdfPagesAsDataUrls(filePath) {
  const buffers = await renderPdfPages(filePath);
  return buffers.map((buffer) => `data:image/jpeg;base64,${buffer.toString('base64')}`);
}

function createPageFilePath(taskId, pageNo) {
  const targetDir = path.join(uploadDir, taskId, 'answer-sheets');
  fs.mkdirSync(targetDir, { recursive: true });
  return path.join(
    targetDir,
    `${Date.now()}-${crypto.randomUUID()}-p${String(pageNo).padStart(3, '0')}.jpg`,
  );
}

async function splitUploadedAnswerSheets(taskId, files) {
  const pages = [];
  const createdPagePaths = [];

  try {
    for (const file of files) {
      const ext = path.extname(file.originalname || '').toLowerCase();
      let buffers = [];

      try {
        if (file.mimetype === 'application/pdf' || ext === '.pdf') {
          buffers = await renderPdfPages(file.path);
        } else if (file.mimetype.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) {
          buffers = [await normalizeImageFile(file.path)];
        } else {
          throw new Error(`暂不支持 ${file.originalname} 这种文件格式，请上传 PDF 或图片。`);
        }

        if (!buffers.length) {
          throw new Error(`${file.originalname} 未能拆出可识别页面。`);
        }

        buffers.forEach((buffer, index) => {
          const pageNo = index + 1;
          const storedPath = createPageFilePath(taskId, pageNo);
          fs.writeFileSync(storedPath, buffer);
          createdPagePaths.push(storedPath);

          pages.push({
            sourceOriginalName: file.originalname,
            sourcePage: pageNo,
            displayName: buffers.length > 1 ? `${file.originalname} - 第 ${pageNo} 页` : file.originalname,
            storedName: path.basename(storedPath),
            storedPath,
            mimeType: 'image/jpeg',
            size: buffer.length,
          });
        });
      } finally {
        fs.rmSync(file.path, { force: true });
      }
    }
    return pages;
  } catch (error) {
    createdPagePaths.forEach((filePath) => fs.rmSync(filePath, { force: true }));
    throw error;
  }
}

module.exports = {
  splitUploadedAnswerSheets,
  renderPdfPagesAsDataUrls,
};
