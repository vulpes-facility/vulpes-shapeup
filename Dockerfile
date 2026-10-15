FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin/ ./bin/
COPY src/ ./src/
USER node
EXPOSE 8080
CMD ["node", "bin/server.mjs"]
