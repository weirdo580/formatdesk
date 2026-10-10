# 格式转换台 FormatDesk

在线文件格式转换：视频转 MP3、文档互转（PDF / Word / PPT / Excel / txt / html）。

- 前端：单文件 SPA（`index.html`），深色 + 橙主题，字体自托管
- 后端：零依赖 Node 22（`server/`），双泳道任务调度、FFmpeg / LibreOffice 引擎池、分片上传、签名下载、60 分钟自动清理
- 部署：整站一个 Docker 容器（见 `Dockerfile`），监听 80，引擎走 PATH
