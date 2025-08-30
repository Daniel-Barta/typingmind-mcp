# Use an official Node.js runtime as a parent image (slim variant for better security)
FROM node:23-slim


# Install Python, pip, and other dependencies
RUN apt-get update && \
    apt-get install -y python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

# Install uv via pip
RUN pip3 install uv --break-system-packages 

# Set the working directory in the container
WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm

# Copy package.json and pnpm-lock.yaml first to leverage Docker cache
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including dev for build)
RUN pnpm install

# Copy the rest of the application source code
COPY . .

# Build TypeScript
RUN pnpm build

# Prune dev dependencies for runtime image size
RUN pnpm prune --prod

# Set the default port the app will run on
ENV PORT=50880

# Make port 50880 available to the world outside this container
EXPOSE 50880

# Define the command to run the app
CMD ["node", "dist/bin/index.js"]
