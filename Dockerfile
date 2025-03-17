# Use Node.js official image as a base
FROM node:18-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the entire project
COPY . .

# Expose the port (ensure your app listens on PORT)
EXPOSE 8080

# Start the application
CMD ["node", "server.js"]
