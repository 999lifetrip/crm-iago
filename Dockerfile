FROM node:20-alpine

WORKDIR /app

# Instala dependências tanto na raiz quanto na pasta backend
COPY package.json ./
COPY backend/package.json ./backend/

RUN npm install --omit=dev && cd backend && npm install --omit=dev

# Copia todos os arquivos do projeto
COPY . .

WORKDIR /app/backend

EXPOSE 3100

CMD ["node", "server.js"]
