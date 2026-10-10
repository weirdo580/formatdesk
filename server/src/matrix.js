/**
 * 转换矩阵：源格式 -> { 可用目标, 泳道, 首选引擎 }
 * 数据驱动：新增格式只改这张表；前端可通过 GET /api/matrix 拉取。
 */
export const VIDEO_SRC  = ['mp4','mov','mkv','avi','flv','webm','wmv'];
export const AUDIO_TGT = ['mp3','aac','wav'];
export const DANGEROUS = ['exe','bat','cmd','sh','ps1','js','jar','msi','scr','vbs','com','apk','dll'];

const audioTargets = AUDIO_TGT;

/** @type {Record<string,{targets:string[],lane:'doc'|'av',engine:string}>} */
export const MATRIX = {
  mp4:  { targets: audioTargets, lane: 'av',  engine: 'ffmpeg' },
  mov:  { targets: audioTargets, lane: 'av',  engine: 'ffmpeg' },
  mkv:  { targets: audioTargets, lane: 'av',  engine: 'ffmpeg' },
  avi:  { targets: audioTargets, lane: 'av',  engine: 'ffmpeg' },
  flv:  { targets: audioTargets, lane: 'av',  engine: 'ffmpeg' },
  webm: { targets: audioTargets, lane: 'av',  engine: 'ffmpeg' },
  wmv:  { targets: audioTargets, lane: 'av',  engine: 'ffmpeg' },

  doc:  { targets: ['pdf'],             lane: 'doc', engine: 'libreoffice' },
  docx: { targets: ['pdf'],             lane: 'doc', engine: 'libreoffice' },
  ppt:  { targets: ['pdf'],             lane: 'doc', engine: 'libreoffice' },
  pptx: { targets: ['pdf'],             lane: 'doc', engine: 'libreoffice' },
  xls:  { targets: ['pdf','csv'],       lane: 'doc', engine: 'libreoffice' },
  xlsx: { targets: ['pdf','csv'],       lane: 'doc', engine: 'libreoffice' },
  csv:  { targets: ['xlsx','txt'],      lane: 'doc', engine: 'libreoffice' },
  pdf:  { targets: ['docx','pptx','xlsx','txt','jpg'], lane: 'doc', engine: 'native' },
  txt:  { targets: ['docx','pdf','md'], lane: 'doc', engine: 'libreoffice' },
  md:   { targets: ['docx','pdf','html'], lane: 'doc', engine: 'native+libreoffice' },
  html: { targets: ['pdf','docx','md'], lane: 'doc', engine: 'libreoffice' },
  jpg:  { targets: ['pdf','png'],       lane: 'doc', engine: 'native' },
  jpeg: { targets: ['pdf','png'],       lane: 'doc', engine: 'native' },
  png:  { targets: ['pdf','jpg'],       lane: 'doc', engine: 'native' },
};

export const extOf = name => String(name).split('.').pop().toLowerCase();
export const canConvert = (src, dst) => !!MATRIX[src]?.targets.includes(dst);
export const laneOf = (src) => MATRIX[src]?.lane ?? null;
export const engineOf = (src, dst) => MATRIX[src]?.engine ?? null;

/** 供 GET /api/matrix 下发给前端的精简结构 */
export function matrixView() {
  return Object.fromEntries(
    Object.entries(MATRIX).map(([k, v]) => [k, { targets: v.targets, lane: v.lane }])
  );
}
