const express = require("express");
const router = express.Router();
const { openai, prisma } = require("./clients");
const { verify, sign } = require("jsonwebtoken");
const Minio = require("minio");
const es = require("event-stream");
const { Transform, Writable, pipeline } = require("stream");
const pipelineAsync = require("util").promisify(pipeline);

const minioClient = new Minio.Client({
  endPoint: "minio",
  port: 80,
  useSSL: false,
  accessKey: "minioadmin",
  secretKey: "minioadmin",
});

class Parser extends Transform {
  constructor() {
    super({
      readableObjectMode: true,
      writableObjectMode: false,
    });
    this.counter = 0;
  }

  _transform(chunk, encoding, callback) {
    this.counter++;

    try {
      if (chunk.toString().length > 0) {
        const parsed = JSON.parse(chunk);
        callback(null, parsed);
      } else {
        callback();
      }
    } catch (err) {
      console.error(err);
      callback(err);
    }
  }
}

router.get("/token", (req, res) => {
  // Check request header for an Authorization header
  const authHeader = req.headers["authorization"];
  if (!authHeader || authHeader !== process.env.CHATBOT_SECRET) {
    return res.status(401).send("Unauthorized");
  }

  // Create a token with the JWT_SECRET
  const token = sign(
    {
      created: new Date().toISOString(),
    },
    process.env.JWT_SECRET,
    { expiresIn: "4hr" }
  );

  // Send the token in a cookie named "chatbot_token"
  res
    .cookie("chatbot_token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    })
    .send("Token created");
});

router.post("/chat", async (req, res) => {
  try {
    // Extract token from a cookie named "chatbot_token"
    const token = req.cookies.chatbot_token;

    if (!token) {
      const noToken = new Error();
      noToken.status = 401;
      noToken.msg = "No token provided";
      throw noToken;
    }

    // Verify the token
    await verifyPromise(token, process.env.JWT_SECRET);

    const { message, thread_id, userId } = req.body;

    let threadId;
    let sequenceNumber;
    if (thread_id) {
      threadId = thread_id;

      // Find the current sequenceNumber
      const messages = await openai.beta.threads.messages.list(threadId);
      const currentSequenceNumber = messages.data.length;
      sequenceNumber = currentSequenceNumber + 1;

      // Conversation has already been started, add the message to the current thread
      await openai.beta.threads.messages.create(threadId, {
        role: "user",
        content: message,
      });

      // Record a new ConversationMessage of type role: "user"
      await prisma.conversation.update({
        where: {
          id: threadId,
        },
        data: {
          updatedAt: new Date(),
          messages: {
            create: {
              messageText: message,
              role: "user",
              sequenceNumber,
            },
          },
        },
      });
    } else {
      const newThread = await openai.beta.threads.create({
        messages: [
          {
            role: "user",
            content: message,
          },
        ],
      });
      threadId = newThread.id;

      // Record a new conversation
      await prisma.conversation.create({
        data: {
          id: threadId,
          userId,
        },
      });

      // Record a new ConversationMessage of type role: "user"
      await prisma.conversationMessage.create({
        data: {
          conversationId: threadId,
          messageText: message,
          role: "user",
          sequenceNumber: 1,
        },
      });
    }

    // Create a run with the thread id and the assistant id
    // Remember to create the assistant in the openAI dashboard

    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: process.env.OPENAI_ASSISTANT_ID,
      tools: [{ type: "file_search" }],
    });

    // Wait for the completed status to be returned from the run (Poll every 5 seconds)

    let completed = false;
    while (!completed) {
      await sleep(5000);
      const asstRun = await openai.beta.threads.runs.retrieve(threadId, run.id);
      completed = asstRun.status === "completed";
      console.log("run status:", asstRun.status);
    }

    // Get the messages from the thread
    const messages = await openai.beta.threads.messages.list(threadId);
    const lastMessage = messages.data[0];

    // Record a new ConversationMessage of type role: "assistant"
    await prisma.conversation.update({
      where: {
        id: threadId,
      },
      data: {
        updatedAt: new Date(),
        messages: {
          create: {
            messageText: lastMessage.content[0].text.value,
            role: "assistant",
            sequenceNumber: sequenceNumber ? sequenceNumber + 1 : 2,
          },
        },
      },
    });

    return res.json({
      threadId,
      response: lastMessage.content[0].text.value,
    });
  } catch (error) {
    console.log(error);
    res
      .status(error.status || 500)
      .send(error.msg || `An error occurred: Please try again later.`);
  }
});

router.get("/conversation/:id/messages", async (req, res) => {
  try {
    const conversationId = req.params.id;
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { archived: true },
    });

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    if (!conversation.archived) {
      return res.json(
        await prisma.conversationMessage.findMany({
          where: { conversationId },
        })
      );
    }

    // Retrieve archived messages from Minio
    const bucketName = "conversation-message-archives";
    const objectName = `${conversationId}_messages`;

    const stream = await minioClient.getObject(bucketName, objectName);
    const parser = new Parser();
    let first = true;
    const saveMessagesStream = new Writable({
      objectMode: true,
      async write(message, encoding, callback) {
        try {
          await prisma.conversationMessage.create({
            data: message,
          });
          if (first) {
            res.write(JSON.stringify(message));
          } else {
            res.write(`,${JSON.stringify(message)}`);
          }
          first = false;
          callback();
        } catch (err) {
          callback(err);
        }
      },
    });

    // Write headers for letting the client know im sending json
    res.setHeader("Content-Type", "application/json");
    // Write the opening bracket
    res.write("[");

    // Stream the data from Minio, split by new line, parse into JSON, and save to the database while sending to the client
    await pipelineAsync(stream, es.split(), parser, saveMessagesStream);

    // Update the conversation to mark it as unarchived
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { archived: false },
    });

    // Remove the trailing comma
    res.write("]");
    res.end();
  } catch (err) {
    console.error(err);

    // If the res has been started, end it
    if (!res.headersSent) {
      res
        .status(err.status || 500)
        .json({ error: err.msg || "An error occurred" });
    } else {
      res.setHeader("ise-message", err.msg || "An error occurred");
      res.end();
    }
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const verifyPromise = (token, secret) => {
  return new Promise((resolve, reject) => {
    verify(token, secret, (err, decoded) => {
      if (err) {
        const customError = new Error(err.message);
        customError.status = 401;
        customError.msg = "Unable to verify credentials";
        reject(customError);
      }
      resolve(decoded);
    });
  });
};

module.exports = router;
