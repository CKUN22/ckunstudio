// Free testing mode: keep screenshots compact enough for D1 storage.
async function prepareImage(file) {
  const read = blob => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(blob);
  });
  if (file.size <= 512 * 1024) return read(file);
  if (file.size > 20 * 1024 * 1024) throw new Error('原始图片不能超过 20MB，请先缩小后上传');
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('图片无法解码，请换一张图片'); }
  try {
    for (let edge = 1800; edge >= 300; edge = Math.floor(edge * 0.75)) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器不支持图片压缩');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.85, 0.65, 0.45]) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
        if (blob && blob.size <= 512 * 1024) return read(blob);
      }
    }
    throw new Error('图片压缩后仍超过 512KB，请先裁剪后上传');
  } finally { bitmap.close(); }
}
