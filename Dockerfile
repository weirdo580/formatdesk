# 格式转换台：前端静态页 + 零依赖 Node 后端 + 转换引擎，整站一个容器
FROM node:22-bookworm-slim

# 引擎：FFmpeg（视频转音频）+ LibreOffice 三件套（文档互转）+ 中文字体
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY index.html ./
COPY fonts ./fonts
COPY server ./server

# 容器内：监听 80，数据放临时目录（本就不持久），小内存机器并发压到 1
ENV FD_HOST=0.0.0.0 \
    FD_PORT=80 \
    FD_DATA=/tmp/formatdesk-data \
    FD_DOC_CONC=1 \
    FD_AV_CONC=1

EXPOSE 80
CMD ["node", "server/index.js"]
