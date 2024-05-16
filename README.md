# Chatbot and Conversation Archival Service

## Overview

This project implements a chatbot service with conversation management and archival features. It uses Express.js for the web server, Prisma for database interactions, and Minio for object storage. The chatbot can process user messages, maintain conversation threads, and archive old conversation messages to Minio for storage.

## Features

- **Chatbot API**: Handles user interactions and maintains conversation threads.
- **Conversation Archival**: Archives conversation messages to Minio storage after a specified period.
- **Token Generation**: Generates JWT tokens for secure communication.

## Technologies Used

- Node.js
- Express.js
- Prisma
- Minio
- JWT (JSON Web Token)
- OpenAI API

## Getting Started

### Prerequisites

- Node.js and npm
- Docker (for running Minio)
- PostgreSQL database
- OpenAI API key

### Installation

1. **Clone the repository**

```sh
git clone <repository_url>
cd <repository_directory>
```

2. **Install dependencies**

```sh
npm install
```

3. **Set up environment variables**

Create a `.env` file in the root directory and add the following variables:

```sh
DATABASE_URL=postgresql://user:password@localhost:5432/mydatabase
OPENAI_API_KEY=your_openai_api_key
JWT_SECRET=your_jwt_secret
CHATBOT_SECRET=your_chatbot_secret
CLIENT_URL=http://localhost:3000
```

4. **Run Minio using Docker**

```sh
docker run -p 9000:9000 -p 9001:9001 --name minio \
 -e "MINIO_ROOT_USER=minioadmin" \
 -e "MINIO_ROOT_PASSWORD=minioadmin" \
 quay.io/minio/minio server /data --console-address ":9001"
```

5. **Set up the database**

```sh
npx prisma migrate dev --name init
```

6. **Start the server**

```sh
node app.js
```

## Usage

### Endpoints

#### GET /token

Generates a JWT token for authentication.

#### POST /chat

Handles user messages and maintains conversation threads.

**Request Body:**

```json
{
  "message": "User's message",
  "thread_id": "Existing thread ID (optional)",
  "userId": "User ID"
}
```

#### GET /conversation/:id/messages

Retrieves messages from a specified conversation. If the conversation is archived, it fetches messages from Minio and restores them to the database.

### Archival Script

The `archive.js` script archives conversation messages that are older than the specified threshold.

**Usage:**

```sh
node archive.js --th "n MONTHS"
```

Replace `n` with the number of months.

### File Structure

- `app.js`: Main server file.
- `archive.js`: Script for archiving old conversation messages.
- `chatbot.js`: Contains routes for the chatbot API.
- `clients.js`: Exports configured instances of Prisma and OpenAI clients.
- `prisma/schema.prisma`: Prisma schema for database models.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request for any improvements or bug fixes.

## License

This project is licensed under the MIT License.
