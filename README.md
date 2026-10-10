# 格式转换台 FormatDesk

在线文件格式转换：视频转音频（MP3 / AAC / WAV）、图片转 PDF、文本互转（txt / md / html / csv）。

**访问地址：** https://weirdo580.github.io/formatdesk/

## 这个站点怎么工作

所有转换都在**访问者自己的浏览器里**完成，文件不上传到任何服务器，服务端只负责发送静态文件。

- 视频转音频：FFmpeg.wasm（`vendor/ffmpeg/`，首次使用时按需加载约 31MB，之后浏览器缓存）
- 图片转 PDF / 图片格式互转：pdf-lib（`vendor/pdf-lib.min.js`）在浏览器内合成
- 文本互转：页面内置的纯 JS 引擎（Markdown / HTML / CSV 解析），零依赖

因此这个站点可以完全托管在 GitHub Pages 这类静态托管上，永久免费、无需服务器、无需数据库。

## 仓库结构

```
index.html          单文件前端（首页 + 两个转换页，hash 路由）
vendor/             浏览器端转换引擎（FFmpeg.wasm + pdf-lib）
fonts/              自托管字体
server/             可选的自我部署后端（Node 22 + FFmpeg + LibreOffice）
Dockerfile          后端容器镜像（含文档互转能力，非 Pages 必需）
```

`server/` 与 `Dockerfile/DEPLOY.md` 保留给以后想自己买服务器部署、重新打开 PDF/Word/PPT/Excel 文档互转时使用。当前线上静态版不含文档互转。

## 本地预览

```
node tools/serve.mjs 8090    # 然后打开 http://127.0.0.1:8090/formatdesk/
```

（`tools/` 已被 gitignore，任意静态服务器都可以，只要给 `application/wasm` 正确的 MIME。）

## 已知限制

- 单个文件建议不超过 100MB，大文件受浏览器内存限制
- 首次转换视频需下载一次引擎（约 31MB，之后走缓存）
- 离开或刷新页面会中断进行中的任务，转换完成后请及时下载
- 中国大陆访问 `github.io` 有时不稳定
