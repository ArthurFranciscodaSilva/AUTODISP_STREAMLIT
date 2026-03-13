# Usa a imagem base do Node.js
FROM node:18-slim

# Instala as dependências necessárias para o Puppeteer (Chromium e bibliotecas de sistema)
# Esta etapa garante que o whatsapp-web.js funcione corretamente no ambiente Docker
RUN apt-get update && apt-get install -y \
    chromium \
    libgbm-dev \
    libasound2 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm-dev \
    libxrandr2 \
    libnss3 \
    libnspr4 \
    libpangocairo-1.0-0 \
    libgconf-2-4 \
    libgtk-3-0 \
    libxshmfence-dev \
    libxcomposite-dev \
    libxfixes-dev \
    fonts-liberation \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia os arquivos de configuração e código
COPY package-server.json ./package.json 
COPY server.cjs .

# Instala as dependências do Node.js
# Instala as dependências, ignorando temporariamente conflitos de peer-deps
RUN npm install --legacy-peer-deps

# Comando de inicialização: executa o servidor Node.js
# Usamos 'node server.js' diretamente pois não há script 'start' dedicado no package.json
CMD ["node", "server.cjs"]

# Expõe a porta que o servidor Node.js está usando
EXPOSE 3001