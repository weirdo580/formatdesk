import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { VIDEO_SRC } from './matrix.js';
import { mdToHtml, htmlToMd, imageToPdf, pdfExtractText, textToDocx, textToXlsx, textToPptx } from './native.js';

/**
 * 引擎适配层：resolve(src, dst) -> { name, run(task, ctx) }
 * 二进制探测顺序：环境变量(FD_FFMPEG/FD_SOFFICE) -> 项目 tools/ 目录 ->
 * Windows 默认安装路径 -> PATH。探测到则真实执行，否则降级 mock 引擎。
 */

function probeRun(cmd) {
  try {
    const r = spawnSync(cmd, ['-version'], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
    return r.status === 0;
  } catch { return false; }
}
function firstUsable(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    if (c.includes('/') || c.includes('\\') || path.isAbsolute(c)) {
      if (fs.existsSync(c) && probeRun(c)) return c;
    } else if (probeRun(c)) return c;
  }
  return null;
}
/** soffice --version 可能挂起（GUI 子系统），绝对路径只做存在性检查 */
function firstExistingOrUsable(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    if (c.includes('/') || c.includes('\\') || path.isAbsolute(c)) { if (fs.existsSync(c)) return c; }
    else if (probeRun(c)) return c;
  }
  return null;
}

export class EngineRegistry {
  constructor({ config, detect = true } = {}) {
    this.config = config;
    this.bin = { ffmpeg: null, ffprobe: null, soffice: null, pandoc: null };
    if (detect) {
      const site = config.siteDir || process.cwd();
      this.bin.ffmpeg = firstUsable([
        process.env.FD_FFMPEG,
        path.join(site, 'tools', 'ffmpeg', 'ffmpeg.exe'),
        path.join(site, 'tools', 'ffmpeg', 'ffmpeg'),
        'ffmpeg',
      ]);
      this.bin.ffprobe = (this.bin.ffmpeg && this.bin.ffmpeg !== 'ffmpeg' && fs.existsSync(this.bin.ffmpeg))
        ? [path.join(path.dirname(this.bin.ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'), 'ffprobe'].find(c => fs.existsSync(c) || probeRun(c))
        : firstUsable(['ffprobe']);
      this.bin.soffice = firstExistingOrUsable([
        process.env.FD_SOFFICE,
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LibreOffice', 'program', 'soffice.exe'),
        'soffice', 'libreoffice',
      ]);
      this.bin.pandoc = firstUsable([process.env.FD_PANDOC, 'pandoc']);
    }
    this.available = {
      ffmpeg: !!this.bin.ffmpeg, ffprobe: !!this.bin.ffprobe,
      libreoffice: !!this.bin.soffice, pandoc: !!this.bin.pandoc, native: true,
    };
  }

  resolve(src, dst) {
    const av = this.available;
    if (VIDEO_SRC.includes(src) && av.ffmpeg) return { name: 'ffmpeg', run: this.#runFfmpeg(src, dst) };
    if (['doc','docx','ppt','pptx','xls','xlsx','csv'].includes(src) && av.libreoffice)
      return { name: 'libreoffice', run: this.#runLibreOffice(dst) };
    if (['txt','html','htm'].includes(src) && ['pdf','docx'].includes(dst) && av.libreoffice)
      return { name: 'libreoffice', run: this.#runLibreOffice(dst,
        (src === 'html' || src === 'htm') && dst === 'docx' ? 'docx:MS Word 2007 XML:HTML (StarWriter)' : null) };
    if (['jpg','jpeg','png'].includes(src) && dst === 'pdf') return { name: 'native', run: this.#runImageToPdf(src) };
    if (['jpg','jpeg','png'].includes(src) && av.libreoffice) return { name: 'libreoffice', run: this.#runLibreOffice(dst) };
    if (src === 'md') {
      if (dst === 'html') return { name: 'native', run: this.#runMdToHtml() };
      if (av.libreoffice) return { name: 'libreoffice', run: this.#runMdToDoc(dst) };
    }
    if (src === 'html' && dst === 'md') return { name: 'native', run: this.#runHtmlToMd() };
    if (src === 'txt' && dst === 'md') return { name: 'native', run: this.#runTxtToMd() };
    if (src === 'pdf') {
      if (['txt','docx','xlsx','pptx'].includes(dst)) return { name: 'native', run: this.#runPdfExtract(dst) };
      if (av.libreoffice) return { name: 'libreoffice', run: this.#runLibreOffice(dst) };
    }
    if (['md','html','txt'].includes(src) && av.pandoc)
      return { name: 'pandoc', run: this.#runPandoc(dst) };
    return { name: 'mock', run: this.#runMock(src, dst) };
  }

  /* ---------- FFmpeg：视频 -> 音频，stderr time= 换算进度 ---------- */
  #runFfmpeg(src, dst) {
    const codec = { mp3: ['-c:a','libmp3lame'], aac: ['-c:a','aac'], wav: ['-c:a','pcm_s16le'] }[dst] || ['-c:a','libmp3lame'];
    return async (task, ctx) => {
      const dur = this.bin.ffprobe ? await ffprobeDuration(ctx.inputPath, this.bin.ffprobe) : 0;
      const bitrate = task.opts?.bitrate && task.opts.bitrate !== 'auto' ? ['-b:a', task.opts.bitrate + 'k'] : [];
      const out = path.join(this.config.dataDir, `.tmp_${task.id}.${dst}`);
      const args = ['-hide_banner', '-i', ctx.inputPath, '-vn', ...codec, ...bitrate, '-y', out];
      await new Promise((resolve, reject) => {
        const p = spawn(this.bin.ffmpeg, args, { windowsHide: true });
        let errTail = '';
        p.stderr.on('data', buf => {
          errTail = (errTail + buf.toString()).slice(-4000);
          const m = /time=(\d+):(\d+):(\d+)\.(\d+)/.exec(errTail.slice(-200));
          if (m && dur > 0) {
            const t = +m[1]*3600 + +m[2]*60 + +m[3] + +m[4]/100;
            ctx.report(Math.min(99, t / dur * 100));
          }
          ctx.cancelCheck();
        });
        p.on('error', reject);
        p.on('close', code => code === 0 ? resolve() : reject(new Error('FFmpeg 退出码 ' + code)));
      });
      const data = fs.readFileSync(out);
      fs.rmSync(out, { force: true });
      ctx.report(100);
      return data;
    };
  }

  /* ---------- LibreOffice headless：Office/文本/图片 -> 目标格式 ---------- */
  #runLibreOffice(dst, filterSpec = null, prepare = null) {
    return async (task, ctx) => {
      const outDir = path.join(this.config.dataDir, `.tmp_dir_${task.id}`);
      fs.mkdirSync(outDir, { recursive: true });
      const bin = this.bin.soffice;
      const profile = outDir + '/profile';
      const input = prepare ? prepare(ctx.inputPath, task, outDir) : ctx.inputPath;
      await new Promise((resolve, reject) => {
        const p = spawn(bin, ['--headless', `-env:UserInstallation=file:///${profile.replace(/\\/g,'/')}`,
          '--convert-to', filterSpec || dst, '--outdir', outDir, input], { windowsHide: true });
        let err = '';
        p.stderr.on('data', d => err += d);
        p.on('error', reject);
        p.on('close', code => code === 0 ? resolve() : reject(new Error('LibreOffice 退出码 ' + code + ' ' + err.slice(-300))));
      });
      ctx.report(90);
      const base = path.basename(input).replace(/\.[^.]+$/, '') + '.' + dst;
      const produced = path.join(outDir, base);
      if (!fs.existsSync(produced)) { fs.rmSync(outDir, { recursive: true, force: true }); throw new Error('引擎未产出文件'); }
      const data = fs.readFileSync(produced);
      fs.rmSync(outDir, { recursive: true, force: true });
      ctx.report(100);
      return data;
    };
  }

  /* ---------- Pandoc：md/html/txt -> docx/pdf ---------- */
  #runPandoc(dst) {
    return async (task, ctx) => {
      const out = path.join(this.config.dataDir, `.tmp_${task.id}.${dst}`);
      await new Promise((resolve, reject) => {
        const p = spawn(this.bin.pandoc, ['-f','markdown', '-o', out, ctx.inputPath], { windowsHide: true });
        let err = '';
        p.stderr.on('data', d => err += d);
        p.on('error', reject);
        p.on('close', code => code === 0 ? resolve() : reject(new Error('Pandoc 退出码 ' + code + ' ' + err.slice(-300))));
      });
      ctx.report(100);
      const data = fs.readFileSync(out);
      fs.rmSync(out, { force: true });
      return data;
    };
  }

  /* ---------- 原生：图片 -> PDF（JPEG 直通 / PNG 解码归一化），失败降级 LO ---------- */
  #runImageToPdf(src) {
    return async (task, ctx) => {
      ctx.report(10);
      const buf = fs.readFileSync(ctx.inputPath);
      try {
        const pdf = imageToPdf(buf, src);
        ctx.report(100);
        return pdf;
      } catch (e) {
        if (this.available.libreoffice) return this.#runLibreOffice('pdf')(task, ctx);
        throw new Error('图片嵌入 PDF 失败：' + e.message);
      }
    };
  }

  /* ---------- 原生：Markdown / HTML / 文本互转 ---------- */
  #runMdToHtml() {
    return async (task, ctx) => {
      ctx.report(50);
      const html = mdToHtml(fs.readFileSync(ctx.inputPath, 'utf8'));
      ctx.report(100);
      return Buffer.from(html, 'utf8');
    };
  }
  #runHtmlToMd() {
    return async (task, ctx) => {
      ctx.report(50);
      const md = htmlToMd(fs.readFileSync(ctx.inputPath, 'utf8'));
      ctx.report(100);
      return Buffer.from(md, 'utf8');
    };
  }
  #runTxtToMd() {
    return async (task, ctx) => {
      ctx.report(80);
      return fs.readFileSync(ctx.inputPath);
    };
  }
  /* md -> pdf/docx：先原生渲染为 HTML，再交 LibreOffice 排版导出（docx 需显式 filter） */
  #runMdToDoc(dst) {
    const filter = dst === 'docx' ? 'docx:MS Word 2007 XML:HTML (StarWriter)' : null;
    let tmp;
    const runner = this.#runLibreOffice(dst, filter, (inputPath, task) => {
      const html = mdToHtml(fs.readFileSync(inputPath, 'utf8'));
      tmp = path.join(this.config.dataDir, `.md_${task.id}.html`);
      fs.writeFileSync(tmp, html);
      return tmp;
    });
    return async (task, ctx) => {
      try { return await runner(task, ctx); }
      finally { if (tmp) fs.rmSync(tmp, { force: true }); }
    };
  }

  /* ---------- 原生：PDF 文本提取 + OOXML 打包 ---------- */
  #runPdfExtract(dst) {
    return async (task, ctx) => {
      ctx.report(10);
      const buf = fs.readFileSync(ctx.inputPath);
      ctx.report(40);
      const text = pdfExtractText(buf);
      ctx.report(70);
      let out;
      if (dst === 'txt') out = Buffer.from(text + '\n', 'utf8');
      else if (dst === 'docx') out = textToDocx(text);
      else if (dst === 'xlsx') out = textToXlsx(text);
      else out = textToPptx(text, task.fileName);
      ctx.report(100);
      return out;
    };
  }

  /* ---------- Mock：开发期降级引擎，模拟排队+转码进度并产出带文件头的演示产物 ---------- */
  #runMock(src, dst) {
    return async (task, ctx) => {
      const steps = 24;
      for (let i = 1; i <= steps; i++) {
        await sleep(40 + Math.random() * 60);
        ctx.cancelCheck();
        ctx.report(Math.min(99, (i / steps) * 100));
      }
      ctx.report(100);
      return mockProduct(dst, task.fileName);
    };
  }
}

/** 各目标格式的最小合法产物（演示用） */
function mockProduct(dst, name) {
  const note = `\nFORMATDESK mock output for: ${name}\n`;
  switch (dst) {
    case 'pdf':  return Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF' + note, 'latin1');
    case 'mp3':  return Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.from(note)]);
    case 'wav':  return riff('WAVE', note);
    case 'aac':
    case 'm4a':  return Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypM4A ', 'latin1'), Buffer.from(note)]);
    case 'png':  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(note)]);
    case 'jpg':  return Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.from(note)]);
    case 'docx':
    case 'xlsx':
    case 'pptx': return Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from(note)]);
    default:     return Buffer.from('FORMATDESK mock output for: ' + name);
  }
}
function riff(tag, note) {
  const body = Buffer.from(note);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0); head.writeUInt32LE(4 + body.length + 8 - 8, 4); head.write(tag, 8);
  return Buffer.concat([head, Buffer.from('fmt \x10\x00\x00\x00', 'latin1'), Buffer.alloc(16), body]);
}

async function ffprobeDuration(file, ffprobeBin) {
  return new Promise(resolve => {
    const p = spawn(ffprobeBin, ['-v','error','-show_entries','format=duration','-of','csv=p=0', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('error', () => resolve(0));
    p.on('close', () => resolve(parseFloat(out) || 0));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
