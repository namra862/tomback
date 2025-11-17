# 1. Start from an official Node.js image. 18-slim is small and fast.
FROM node:18-slim

# 2. Install the system dependencies your app needs.
# This is CRITICAL for 'pdf2pic' (poppler, graphicsmagick)
# and 'puppeteer' (chromium, etc.) to work on Linux
RUN apt-get update && apt-get install -y \
    poppler-utils \
    graphicsmagick \
    # Add puppeteer dependencies
    chromium \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 3. Set up the working directory inside the container
WORKDIR /app

# 4. Copy package files and install dependencies
# This uses npm to match your project
COPY package.json package-lock.json ./
RUN npm install --production

# 5. Copy the rest of your application code
COPY . .

# 6. Expose the port your app runs on
EXPOSE 5000

# 7. The command to start your app
CMD ["node", "index.js"]