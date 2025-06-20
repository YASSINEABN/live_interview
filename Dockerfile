# Use an official Node.js runtime as a parent image
FROM node:18-slim

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install app dependencies
RUN npm install

# Bundle app source
COPY . .

# Railway provides the PORT environment variable
EXPOSE $PORT

# The command to start the app
CMD [ "npm", "start" ]
