# Portable image for any container host. Render uses the Node runtime + render.yaml;
# this is here so the same app runs on Fly.io / a VM / anything that speaks OCI.
FROM node:22-slim

WORKDIR /app

# Install prod deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# config.js reads process.env.PORT; the host maps this. 3000 is the local default.
EXPOSE 3000

CMD ["npm", "start"]
