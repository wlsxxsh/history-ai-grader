function getUmiEndpoint(settings) {
  return String(settings?.umiEndpoint || 'http://127.0.0.1:1224').replace(/\/$/, '');
}

function getErrorMessage(payload, fallback) {
  return payload?.data || payload?.message || fallback;
}

function flattenBox(box) {
  if (!Array.isArray(box) || !box.length) {
    return {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    };
  }

  const xs = box.map((point) => Number(point?.[0] || 0));
  const ys = box.map((point) => Number(point?.[1] || 0));
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);

  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function joinUmiBlocks(blocks) {
  return blocks
    .map((item) => `${item.text || ''}${item.end || ''}`)
    .join('')
    .trim();
}

function getUmiOptions(mode) {
  return {
    'ocr.cls': true,
    'ocr.limit_side_len': 4320,
    'tbpu.parser': mode === 'layout' ? 'single_line' : 'single_para',
    'data.format': 'dict',
  };
}

function getBase64FromDataUrl(imageDataUrl) {
  const match = String(imageDataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('图片数据格式不正确，请重新生成后再试。');
  }

  return {
    mimeType: match[1],
    base64: match[2],
  };
}

async function ocrImageWithUmi({ settings, imageDataUrl, mode = 'text' }) {
  const endpoint = getUmiEndpoint(settings);
  const { base64 } = getBase64FromDataUrl(imageDataUrl);
  let response;

  try {
    response = await fetch(`${endpoint}/api/ocr`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        base64,
        options: getUmiOptions(mode),
      }),
    });
  } catch (error) {
    throw new Error(`无法连接 Umi-OCR（${endpoint}）。请先启动本地 Umi-OCR，并确认 HTTP 接口已开启。`);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(getErrorMessage(payload, 'Umi-OCR 调用失败。'));
  }

  if (payload.code === 101) {
    return {
      engine: 'umi',
      text: '',
      blocks: [],
      averageConfidence: 0,
    };
  }

  if (payload.code !== 100) {
    throw new Error(getErrorMessage(payload, 'Umi-OCR 未返回有效识别结果。'));
  }

  const blocks = (Array.isArray(payload.data) ? payload.data : []).map((item) => ({
    text: String(item?.text || ''),
    score: Number(item?.score || 0),
    end: String(item?.end || ''),
    box: Array.isArray(item?.box) ? item.box : [],
    ...flattenBox(item?.box),
  }));

  return {
    engine: 'umi',
    text: joinUmiBlocks(blocks),
    blocks,
    averageConfidence: blocks.length ? blocks.reduce((sum, item) => sum + item.score, 0) / blocks.length : 0,
  };
}

async function ocrImageText({ settings, imageDataUrl, mode = 'text' }) {
  return ocrImageWithUmi({ settings, imageDataUrl, mode });
}

module.exports = {
  getBase64FromDataUrl,
  getUmiEndpoint,
  joinUmiBlocks,
  ocrImageText,
  ocrImageWithUmi,
};
